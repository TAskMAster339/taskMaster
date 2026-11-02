use crate::{AppError, tasks::TaskStore};
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
    crate::diagnostics::record(
        crate::diagnostics::Event::BackupWarning,
        Some("backup_error"),
    );
    AppError {
        code: "backup_error",
        message: message.into(),
    }
}
fn database_error() -> AppError {
    error("Не удалось прочитать резервную копию. Проверьте файл и доступ к нему.")
}

fn copy(source: &Connection, destination: &mut Connection) -> Result<(), AppError> {
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

fn cleanup(path: &Path) {
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
    if !(1..=crate::tasks::CURRENT_SCHEMA_VERSION).contains(&version) {
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
mod tests {
    use super::*;
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("taskmaster-storage-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn snapshot_includes_committed_wal_and_preserves_the_source() {
        let sandbox = Sandbox::new();
        let source = TaskStore::open(sandbox.path("live.sqlite3")).unwrap();
        source.create_task("Сохранить").unwrap();
        let path = sandbox.path("copy.sqlite3");
        snapshot(&source.connection, &path).unwrap();
        let restored = TaskStore::open(path).unwrap();
        assert_eq!(restored.list_tasks().unwrap()[0].title, "Сохранить");
        assert_eq!(source.list_tasks().unwrap().len(), 1);
        assert!(snapshot(&source.connection, &sandbox.path("live.sqlite3")).is_err());
        assert!(snapshot(&source.connection, &sandbox.path("live.sqlite3-wal")).is_err());
        assert!(snapshot(&source.connection, &sandbox.path("live.sqlite3-shm")).is_err());
        assert_eq!(source.list_tasks().unwrap().len(), 1);
    }
    #[test]
    fn daily_copy_is_once_per_day_and_rotates_only_daily_files() {
        let sandbox = Sandbox::new();
        let store = TaskStore::in_memory().unwrap();
        let directory = sandbox.path("backups");
        store.create_task("Утро").unwrap();
        daily_backup(&store, &directory, "2026-11-01").unwrap();
        store.create_task("Вечер").unwrap();
        daily_backup(&store, &directory, "2026-11-01").unwrap();
        assert_eq!(
            prepare(&directory.join("daily-2026-11-01.sqlite3"), &directory)
                .unwrap()
                .preview
                .tasks,
            1
        );
        fs::write(directory.join("manual.sqlite3"), b"untouched").unwrap();
        fs::write(directory.join("before-restore-safe.sqlite3"), b"untouched").unwrap();
        for day in 2..=9 {
            daily_backup(&store, &directory, &format!("2026-11-{day:02}")).unwrap();
        }
        let files = daily_files(&directory).unwrap();
        assert_eq!(files.len(), 7);
        assert!(files[0].ends_with("daily-2026-11-09.sqlite3"));
        assert!(!directory.join("daily-2026-11-02.sqlite3").exists());
        assert_eq!(
            fs::read(directory.join("manual.sqlite3")).unwrap(),
            b"untouched"
        );
        assert!(directory.join("before-restore-safe.sqlite3").exists());
    }
    #[test]
    fn restore_uses_validated_snapshot_and_saves_current_data_first() {
        let sandbox = Sandbox::new();
        let file = sandbox.path("copy.sqlite3");
        let mut live = TaskStore::open(sandbox.path("live.sqlite3")).unwrap();
        let task = live.create_task("Исходная").unwrap();
        live.complete_task(&task.id).unwrap();
        live.create_timer("Таймер", 90, 1000).unwrap();
        live.set_preferences(30, 48).unwrap();
        snapshot(&live.connection, &file).unwrap();
        let prepared = prepare(&file, &sandbox.0).unwrap();
        live.create_task("После копии").unwrap();
        // Changing the selected file after validation cannot change what will be restored.
        fs::write(&file, b"replaced after validation").unwrap();
        let safety = restore_live(&mut live, &prepared, &sandbox.0).unwrap();
        assert_eq!(live.list_tasks().unwrap().len(), 1);
        assert_eq!(live.list_timers_at(1000).unwrap()[0].name, "Таймер");
        assert_eq!(live.preferences().unwrap().archive_hours, 48);
        assert_eq!(
            live.export_data().unwrap()["task_events"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            TaskStore::open(safety).unwrap().list_tasks().unwrap().len(),
            2
        );
        drop(live);
        let reopened = TaskStore::open(sandbox.path("live.sqlite3")).unwrap();
        assert_eq!(reopened.list_tasks().unwrap().len(), 1);
        assert_eq!(reopened.preferences().unwrap().archive_hours, 48);
    }
    #[test]
    fn invalid_future_and_unrelated_files_are_rejected_without_modification() {
        let sandbox = Sandbox::new();
        let invalid = sandbox.path("invalid.sqlite3");
        fs::write(&invalid, b"not sqlite").unwrap();
        assert!(prepare(&invalid, &sandbox.0).is_err());
        assert_eq!(fs::read(&invalid).unwrap(), b"not sqlite");
        let future = sandbox.path("future.sqlite3");
        let conn = Connection::open(&future).unwrap();
        conn.execute_batch("PRAGMA user_version=99;").unwrap();
        drop(conn);
        let original = fs::read(&future).unwrap();
        assert!(prepare(&future, &sandbox.0).is_err());
        assert_eq!(fs::read(&future).unwrap(), original);
        let unrelated = sandbox.path("other.sqlite3");
        let conn = Connection::open(&unrelated).unwrap();
        conn.execute_batch("CREATE TABLE other(x); PRAGMA user_version=7;")
            .unwrap();
        drop(conn);
        assert!(prepare(&unrelated, &sandbox.0).is_err());
        assert!(prepare(&sandbox.path("missing.sqlite3"), &sandbox.0).is_err());
        assert!(!sandbox.path("missing.sqlite3").exists());
    }
    #[test]
    fn safety_copy_failure_does_not_change_live_data() {
        let sandbox = Sandbox::new();
        let mut live = TaskStore::in_memory().unwrap();
        live.create_task("В копии").unwrap();
        let source = sandbox.path("source.sqlite3");
        snapshot(&live.connection, &source).unwrap();
        let prepared = prepare(&source, &sandbox.0).unwrap();
        live.create_task("Не потерять").unwrap();
        let unavailable = sandbox.path("not-a-directory");
        fs::write(&unavailable, b"file").unwrap();
        assert!(restore_live(&mut live, &prepared, &unavailable).is_err());
        assert_eq!(live.list_tasks().unwrap().len(), 2);
    }
    #[test]
    fn unreadable_database_and_sidecars_are_preserved_during_recovery() {
        let sandbox = Sandbox::new();
        let source = TaskStore::in_memory().unwrap();
        source.create_task("Восстановить").unwrap();
        let file = sandbox.path("copy.sqlite3");
        snapshot(&source.connection, &file).unwrap();
        let prepared = prepare(&file, &sandbox.0).unwrap();
        let database = sandbox.path("taskmaster.sqlite3");
        fs::write(&database, b"damaged original").unwrap();
        fs::write(sandbox.path("taskmaster.sqlite3-wal"), b"damaged wal").unwrap();
        assert!(TaskStore::open(&database).is_err());
        let (restored, recovery) = recover_unreadable(&database, &prepared, &sandbox.0).unwrap();
        assert_eq!(restored.list_tasks().unwrap()[0].title, "Восстановить");
        assert_eq!(
            fs::read(recovery.join("taskmaster.sqlite3")).unwrap(),
            b"damaged original"
        );
        assert_eq!(
            fs::read(recovery.join("taskmaster.sqlite3-wal")).unwrap(),
            b"damaged wal"
        );
    }
    #[test]
    fn migration_of_backup_never_changes_the_selected_legacy_file() {
        let sandbox = Sandbox::new();
        let path = sandbox.path("legacy.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,position INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,completed_at INTEGER); CREATE TABLE task_events(id TEXT PRIMARY KEY NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,occurred_at INTEGER NOT NULL,details TEXT NOT NULL DEFAULT '{}'); CREATE INDEX tasks_status_position ON tasks(status,position); INSERT INTO tasks VALUES('one','Старая задача','active',0,1000,1000,NULL); INSERT INTO task_events VALUES('event','one','created',1000,'{}'); PRAGMA user_version=1;").unwrap();
        drop(connection);
        let original = fs::read(&path).unwrap();
        let prepared = prepare(&path, &sandbox.0).unwrap();
        assert_eq!(prepared.preview.tasks, 1);
        assert_eq!(prepared.preview.events, 1);
        assert_eq!(fs::read(&path).unwrap(), original);
    }
    #[test]
    fn cancelling_preview_changes_no_data_and_removes_its_staging_file() {
        let sandbox = Sandbox::new();
        let live = TaskStore::in_memory().unwrap();
        live.create_task("Не менять").unwrap();
        let file = sandbox.path("copy.sqlite3");
        snapshot(&live.connection, &file).unwrap();
        let prepared = prepare(&file, &sandbox.0).unwrap();
        let staging = prepared._temporary.0.clone();
        assert!(staging.exists());
        drop(prepared);
        assert!(!staging.exists());
        assert!(file.exists());
        assert_eq!(live.list_tasks().unwrap()[0].title, "Не менять");
    }
    #[test]
    fn failed_destination_write_keeps_live_database_and_safety_copy() {
        let sandbox = Sandbox::new();
        let path = sandbox.path("live.sqlite3");
        let mut live = TaskStore::open(&path).unwrap();
        live.create_task("До копии").unwrap();
        let source = sandbox.path("source.sqlite3");
        snapshot(&live.connection, &source).unwrap();
        live.create_task("После копии").unwrap();
        let prepared = prepare(&source, &sandbox.0).unwrap();
        drop(live);
        live = TaskStore::open(&path).unwrap();
        live.connection =
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(restore_live(&mut live, &prepared, &sandbox.0).is_err());
        assert_eq!(live.list_tasks().unwrap().len(), 2);
        let saved = fs::read_dir(&sandbox.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("before-restore-")
            })
            .collect::<Vec<_>>();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            TaskStore::open(saved[0].path())
                .unwrap()
                .list_tasks()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn interrupted_recovery_never_opens_a_new_empty_database() {
        let sandbox = Sandbox::new();
        let database = sandbox.path("taskmaster.sqlite3");
        fs::write(
            restore_marker(&database),
            b"previous files in recovery directory",
        )
        .unwrap();
        assert!(crate::open_store(sandbox.0.clone()).is_err());
        assert!(!database.exists());
    }
}
