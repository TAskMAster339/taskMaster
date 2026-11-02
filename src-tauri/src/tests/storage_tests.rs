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
    live.connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
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
    assert!(crate::app::bootstrap::open_store(sandbox.0.clone()).is_err());
    assert!(!database.exists());
}
