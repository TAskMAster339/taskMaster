use crate::app::error::AppError;
use crate::persistence::store::TaskStore;
use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub fn error(message: impl Into<String>) -> AppError {
    crate::platform::diagnostics::record(
        crate::platform::diagnostics::Event::BackupWarning,
        Some("backup_error"),
    );
    AppError {
        code: "backup_error",
        message: message.into(),
    }
}

pub(super) fn database_error() -> AppError {
    error("Не удалось прочитать резервную копию. Проверьте файл и доступ к нему.")
}

pub(super) fn copy(source: &Connection, destination: &mut Connection) -> Result<(), AppError> {
    let backup = Backup::new(source, destination).map_err(|_| database_error())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match backup.step(256).map_err(|_| database_error())? {
            StepResult::Done => return Ok(()),
            StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(10)),
            StepResult::More => {}
            _ => return Err(database_error()),
        }
        if Instant::now() > deadline {
            return Err(error("База занята. Повторите попытку позже."));
        }
    }
}

pub(super) fn cleanup(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let _ = fs::remove_file(PathBuf::from(name));
    }
}

struct Temporary(PathBuf);

impl Drop for Temporary {
    fn drop(&mut self) {
        cleanup(&self.0);
    }
}

pub fn snapshot(source: &Connection, destination: &Path) -> Result<(), AppError> {
    if let Some(live) = source.path().filter(|path| !path.is_empty()) {
        let live = Path::new(live);
        let same_parent = live
            .parent()
            .and_then(|path| fs::canonicalize(path).ok())
            .zip(
                destination
                    .parent()
                    .and_then(|path| fs::canonicalize(path).ok()),
            )
            .is_some_and(|(a, b)| a == b);
        let live_name = live
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let destination_name = destination
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let protected_name = [
            live_name.clone(),
            format!("{live_name}-wal"),
            format!("{live_name}-shm"),
        ]
        .contains(&destination_name);
        let same_file = fs::canonicalize(live)
            .ok()
            .zip(fs::canonicalize(destination).ok())
            .is_some_and(|(a, b)| a == b);
        if same_file || (same_parent && protected_name) {
            return Err(error(
                "Выберите другой файл: рабочую базу и её служебные файлы нельзя заменять резервной копией.",
            ));
        }
    }
    let parent = destination.parent().ok_or_else(database_error)?;
    let temporary = Temporary(parent.join(format!(".taskmaster-{}.sqlite3", uuid::Uuid::new_v4())));
    let mut target = Connection::open(&temporary.0).map_err(|_| {
        error("Не удалось создать копию. Проверьте папку, права доступа и свободное место.")
    })?;
    copy(source, &mut target)?;
    drop(target);
    fs::OpenOptions::new()
        .write(true)
        .open(&temporary.0)
        .and_then(|f| f.sync_all())
        .map_err(|_| database_error())?;
    fs::rename(&temporary.0, destination)
        .map_err(|_| error("Не удалось сохранить копию в выбранный файл."))?;
    Ok(())
}

pub fn daily_backup(store: &TaskStore, directory: &Path, day: &str) -> Result<(), AppError> {
    if day.len() != 10
        || !day.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return Err(database_error());
    }
    fs::create_dir_all(directory)
        .map_err(|_| error("Не удалось открыть папку ежедневных копий."))?;
    let path = directory.join(format!("daily-{day}.sqlite3"));
    if !path.exists() {
        snapshot(&store.connection, &path)?;
    } else {
        drop(prepare(&path, directory)?);
    }
    let files = daily_files(directory)?;
    for file in files.iter().skip(7) {
        fs::remove_file(file)
            .map_err(|_| error("Копия создана, но не удалось удалить старую ежедневную копию."))?;
    }
    Ok(())
}

pub fn daily_files(directory: &Path) -> Result<Vec<PathBuf>, AppError> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| database_error())? {
        let entry = entry.map_err(|_| database_error())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.len() == 24
            && name.starts_with("daily-")
            && name.ends_with(".sqlite3")
            && name[6..16].bytes().enumerate().all(|(i, b)| {
                if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            })
            && entry.file_type().map_err(|_| database_error())?.is_file()
        {
            files.push(entry.path());
        }
    }
    files.sort_by(|a, b| b.cmp(a));
    Ok(files)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub source: String,
    pub tasks: i64,
    pub events: i64,
    pub timers: i64,
}

pub struct Prepared {
    pub preview: Preview,
    store: Option<TaskStore>,
    _temporary: Temporary,
}

impl Drop for Prepared {
    fn drop(&mut self) {
        drop(self.store.take());
    }
}

pub fn prepare(source: &Path, directory: &Path) -> Result<Prepared, AppError> {
    let input = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| database_error())?;
    input
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| database_error())?;
    input
        .execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(|_| database_error())?;
    let integrity: String = input
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| database_error())?;
    if integrity != "ok" {
        return Err(error("Резервная копия повреждена. Выберите другой файл."));
    }
    let version: i64 = input
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| database_error())?;
    if !(1..=crate::persistence::store::CURRENT_SCHEMA_VERSION).contains(&version) {
        return Err(error(
            "Версия базы не поддерживается. Выберите копию taskMaster совместимой версии.",
        ));
    }
    fs::create_dir_all(directory).map_err(|_| database_error())?;
    let token = uuid::Uuid::new_v4().to_string();
    let temporary = Temporary(directory.join(format!("restore-{token}.sqlite3")));
    snapshot(&input, &temporary.0)?;
    drop(input);
    let store = TaskStore::open(&temporary.0)
        .map_err(|_| error("Файл не содержит совместимую базу taskMaster."))?;
    store.list_tasks()?;
    store.list_timers()?;
    store.preferences()?;
    store.shortcuts()?;
    store.list_deletion_undos(0)?;
    let connection = &store.connection;
    let violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .map_err(|_| database_error())?;
    if violations != 0 {
        return Err(error(
            "В копии нарушены связи данных. Выберите другой файл.",
        ));
    }
    let tasks = connection
        .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
        .map_err(|_| database_error())?;
    let events=connection.query_row("SELECT COUNT(*) FROM task_events WHERE id IS NOT NULL AND task_id IS NOT NULL AND kind IS NOT NULL AND occurred_at IS NOT NULL AND details IS NOT NULL",[],|r|r.get(0)).map_err(|_|database_error())?;
    let timers = connection
        .query_row("SELECT COUNT(*) FROM timers", [], |r| r.get(0))
        .map_err(|_| database_error())?;
    connection
        .prepare("SELECT id,task_id,duration_seconds,started_at,status FROM focus_sessions LIMIT 0")
        .map_err(|_| database_error())?;
    Ok(Prepared {
        preview: Preview {
            token,
            source: source.to_string_lossy().into_owned(),
            tasks,
            events,
            timers,
        },
        store: Some(store),
        _temporary: temporary,
    })
}

pub fn restore_live(
    live: &mut TaskStore,
    prepared: &Prepared,
    directory: &Path,
) -> Result<PathBuf, AppError> {
    let mut clocks = live.timer_clocks.lock().map_err(|_| AppError::lock())?;
    fs::create_dir_all(directory).map_err(|_| database_error())?;
    let safety = directory.join(format!("before-restore-{}.sqlite3", uuid::Uuid::new_v4()));
    snapshot(&live.connection, &safety)?;
    copy(
        &prepared
            .store
            .as_ref()
            .ok_or_else(database_error)?
            .connection,
        &mut live.connection,
    )?;
    clocks.clear();
    Ok(safety)
}

pub fn restore_marker(database: &Path) -> PathBuf {
    database.with_extension("restore-pending")
}

pub fn recover_unreadable(
    database: &Path,
    prepared: &Prepared,
    directory: &Path,
) -> Result<(TaskStore, PathBuf), AppError> {
    let recovery = directory.join(format!("recovery-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&recovery).map_err(|_| database_error())?;
    // Build and verify the replacement before moving any original file.
    let staged = Temporary(directory.join(format!("recovered-{}.sqlite3", uuid::Uuid::new_v4())));
    snapshot(
        &prepared
            .store
            .as_ref()
            .ok_or_else(database_error)?
            .connection,
        &staged.0,
    )?;
    let check = TaskStore::open(&staged.0).map_err(|_| database_error())?;
    check.list_tasks()?;
    drop(check);
    let marker = restore_marker(database);
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&marker)
            .map_err(|_| database_error())?;
        file.write_all(recovery.to_string_lossy().as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| database_error())?;
    }
    let mut moved = Vec::new();
    let mut installed = false;
    let operation = (|| {
        for suffix in ["", "-wal", "-shm"] {
            let mut name = database.as_os_str().to_owned();
            name.push(suffix);
            let original = PathBuf::from(name);
            if original.exists() {
                let saved = recovery.join(original.file_name().ok_or_else(database_error)?);
                fs::rename(&original, &saved).map_err(|_| database_error())?;
                moved.push((original, saved));
            }
        }
        fs::rename(&staged.0, database).map_err(|_| database_error())?;
        installed = true;
        TaskStore::open(database).map_err(|_| database_error())
    })();
    match operation {
        Ok(store) => {
            fs::remove_file(&marker).map_err(|_| {
                self::error(format!(
                    "Данные заменены, но восстановление не удалось завершить. Предыдущие файлы: {}",
                    recovery.display()
                ))
            })?;
            Ok((store, recovery))
        }
        Err(error) => {
            // If replacement failed, originals remain available in recovery even if rollback fails.
            if !installed {
                for (original, saved) in moved.iter().rev() {
                    fs::rename(saved, original).map_err(|_| {
                        self::error(format!(
                            "Не удалось восстановить рабочий файл. Исходные данные сохранены: {}",
                            recovery.display()
                        ))
                    })?;
                }
                fs::remove_file(&marker).map_err(|_| database_error())?;
            }
            Err(error)
        }
    }
}

#[cfg(test)]
#[path = "../tests/storage_tests.rs"]
mod tests;
