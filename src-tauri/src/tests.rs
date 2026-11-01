use super::tasks::{TaskStatus, TaskStore};
use rusqlite::Connection;
use std::path::PathBuf;
use uuid::Uuid;

struct TemporaryDatabase(PathBuf);

impl TemporaryDatabase {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("taskmaster-{}.sqlite3", Uuid::new_v4())))
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal"] {
            let mut path = self.0.as_os_str().to_owned();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

#[test]
fn creates_trimmed_tasks_in_manual_queue_order() {
    let store = TaskStore::in_memory().unwrap();

    let first = store.create_task("  Купить хлеб  ").unwrap();
    let second = store.create_task("Позвонить врачу").unwrap();
    let tasks = store.list_tasks().unwrap();

    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0].id, first.id);
    assert_eq!(tasks[0].title, "Купить хлеб");
    assert_eq!(tasks[0].position, 0);
    assert_eq!(tasks[1].id, second.id);
    assert_eq!(tasks[1].position, 1);
}

#[test]
fn rejects_empty_and_overlong_titles_without_creating_rows() {
    let store = TaskStore::in_memory().unwrap();

    assert!(store.create_task("   ").is_err());
    assert!(store.create_task(&"я".repeat(301)).is_err());
    assert!(store.list_tasks().unwrap().is_empty());
}

#[test]
fn completion_hides_task_and_reopening_appends_it_to_the_queue() {
    let store = TaskStore::in_memory().unwrap();
    let first = store.create_task("Первая").unwrap();
    let second = store.create_task("Вторая").unwrap();

    store.complete_task(&first.id).unwrap();
    let tasks = store.list_tasks().unwrap();
    let active: Vec<_> = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Active)
        .collect();
    let completed: Vec<_> = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Completed)
        .collect();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, second.id);
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].id, first.id);

    store.reopen_task(&first.id).unwrap();
    let tasks = store.list_tasks().unwrap();
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[1].id, first.id);
    assert_eq!(tasks[1].status, TaskStatus::Active);
    assert_eq!(tasks[1].position, 1);
}

#[test]
fn reorder_persists_a_contiguous_manual_order() {
    let store = TaskStore::in_memory().unwrap();
    let first = store.create_task("Первая").unwrap();
    let second = store.create_task("Вторая").unwrap();
    let third = store.create_task("Третья").unwrap();

    store
        .reorder_tasks(&[third.id.clone(), first.id.clone(), second.id.clone()])
        .unwrap();
    let tasks = store.list_tasks().unwrap();

    assert_eq!(
        tasks
            .iter()
            .map(|task| task.title.as_str())
            .collect::<Vec<_>>(),
        ["Третья", "Первая", "Вторая"]
    );
    assert_eq!(
        tasks.iter().map(|task| task.position).collect::<Vec<_>>(),
        [0, 1, 2]
    );
}

#[test]
fn task_and_manual_order_survive_reopening_the_database() {
    let database = TemporaryDatabase::new();
    let path = &database.0;
    let expected_ids;
    {
        let store = TaskStore::open(path).unwrap();
        let first = store.create_task("Первое дело").unwrap();
        let second = store.create_task("Второе дело").unwrap();
        store
            .reorder_tasks(&[second.id.clone(), first.id.clone()])
            .unwrap();
        expected_ids = vec![second.id, first.id];
    }
    {
        let store = TaskStore::open(path).unwrap();
        let actual_ids: Vec<_> = store
            .list_tasks()
            .unwrap()
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(actual_ids, expected_ids);
    }
}

#[test]
fn refuses_newer_schema_without_changing_its_version_or_contents() {
    let database = TemporaryDatabase::new();
    let connection = Connection::open(&database.0).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE newer_schema_marker (value TEXT NOT NULL);
             PRAGMA user_version = 99;",
        )
        .unwrap();
    drop(connection);

    let opened = TaskStore::open(&database.0);
    if opened.is_ok() {
        drop(opened);
        panic!("a newer schema should be rejected");
    }

    let connection = Connection::open(&database.0).unwrap();
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let marker_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'newer_schema_marker')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, 99);
    assert!(marker_exists);
}

#[test]
fn rejects_incomplete_or_duplicate_reorder_without_changing_the_queue() {
    let store = TaskStore::in_memory().unwrap();
    let first = store.create_task("Первая").unwrap();
    let second = store.create_task("Вторая").unwrap();

    assert!(
        store
            .reorder_tasks(&[first.id.clone(), first.id.clone()])
            .is_err()
    );
    assert!(
        store
            .reorder_tasks(std::slice::from_ref(&first.id))
            .is_err()
    );
    let tasks = store.list_tasks().unwrap();
    assert_eq!(tasks[0].id, first.id);
    assert_eq!(tasks[1].id, second.id);
}
