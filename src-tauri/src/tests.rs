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

#[test]
fn archives_tasks_at_the_48_hour_creation_deadline_and_only_once() {
    let store = TaskStore::in_memory().unwrap();
    let active = store.create_task("Активная").unwrap();
    let completed = store.create_task("Выполненная").unwrap();
    store.set_created_at(&active.id, 1_000).unwrap();
    store.set_created_at(&completed.id, 2_000).unwrap();
    store.complete_task(&completed.id).unwrap();

    const FORTY_EIGHT_HOURS_MS: i64 = 48 * 60 * 60 * 1000;
    let deadline = 1_000 + FORTY_EIGHT_HOURS_MS;

    assert_eq!(store.archive_expired_tasks(deadline - 1).unwrap(), 0);
    assert_eq!(store.archive_expired_tasks(deadline).unwrap(), 1);
    assert_eq!(store.archive_expired_tasks(deadline + 1_000).unwrap(), 1);
    assert_eq!(store.archive_expired_tasks(deadline + 1).unwrap(), 0);

    let tasks = store.list_tasks().unwrap();
    assert!(tasks.iter().all(|task| task.status == TaskStatus::Archived));
    assert_eq!(store.count_archive_events().unwrap(), 2);
}

#[test]
fn migrates_version_one_tasks_and_keeps_their_event_foreign_keys() {
    let database = TemporaryDatabase::new();
    let connection = Connection::open(&database.0).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE tasks (
                 id TEXT PRIMARY KEY NOT NULL,
                 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
                 status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
                 position INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 completed_at INTEGER
             );
             CREATE TABLE task_events (
                 id TEXT PRIMARY KEY NOT NULL,
                 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 kind TEXT NOT NULL,
                 occurred_at INTEGER NOT NULL,
                 details TEXT NOT NULL DEFAULT '{}'
             );
             CREATE INDEX tasks_status_position ON tasks(status, position);
             CREATE INDEX task_events_task_time ON task_events(task_id, occurred_at);
             INSERT INTO tasks VALUES ('task-1', 'Сохранённая', 'active', 0, 1000, 1000, NULL);
             INSERT INTO task_events VALUES ('event-1', 'task-1', 'created', 1000, '{}');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    drop(connection);

    let store = TaskStore::open(&database.0).unwrap();
    let tasks = store.list_tasks().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].title, "Сохранённая");
    assert_eq!(tasks[0].archived_at, None);
    assert_eq!(store.count_archive_events().unwrap(), 0);

    let connection = Connection::open(&database.0).unwrap();
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, 2);
    assert_eq!(violations, 0);
}

#[test]
fn restores_archived_task_to_queue_with_a_new_48_hour_window_and_history_event() {
    let store = TaskStore::in_memory().unwrap();
    let old = store.create_task("Старая задача").unwrap();
    let active = store.create_task("Остаётся в очереди").unwrap();
    store.set_created_at(&old.id, 1_000).unwrap();
    store
        .archive_expired_tasks(1_000 + 48 * 60 * 60 * 1000)
        .unwrap();

    store.restore_task(&old.id).unwrap();

    let tasks = store.list_tasks().unwrap();
    let restored = tasks.iter().find(|task| task.id == old.id).unwrap();
    assert_eq!(restored.status, TaskStatus::Active);
    assert_eq!(restored.position, 1);
    assert!(restored.created_at > 1_000 + 48 * 60 * 60 * 1000);
    assert_eq!(restored.archived_at, None);
    assert_eq!(tasks[0].id, active.id);

    assert_eq!(store.count_events_for_task(&old.id, "restored").unwrap(), 1);
    assert_eq!(store.count_events_for_task(&old.id, "archived").unwrap(), 1);
}

#[test]
fn history_day_groups_completed_and_archived_tasks_by_event_time() {
    let store = TaskStore::in_memory().unwrap();
    let completed = store.create_task("Выполнена в выбранную дату").unwrap();
    let archived = store.create_task("Архивирована в выбранную дату").unwrap();
    let active = store.create_task("Остаётся активной").unwrap();
    store.set_created_at(&archived.id, 1_000).unwrap();

    store.complete_task(&completed.id).unwrap();
    let completed_at = store
        .list_tasks()
        .unwrap()
        .into_iter()
        .find(|task| task.id == completed.id)
        .unwrap()
        .completed_at
        .unwrap();
    let archived_at = completed_at + 10_000;
    store.archive_expired_tasks(archived_at).unwrap();

    let completion_day = store
        .list_history_for_range(completed_at, archived_at)
        .unwrap();
    assert_eq!(completion_day.completed.len(), 1);
    assert_eq!(completion_day.completed[0].task.id, completed.id);
    assert!(completion_day.archived.is_empty());

    let archive_day = store
        .list_history_for_range(archived_at, archived_at + 1)
        .unwrap();
    assert_eq!(archive_day.archived.len(), 1);
    assert_eq!(archive_day.archived[0].task.id, archived.id);
    assert_eq!(archive_day.archived[0].occurred_at, archived_at);
    assert!(
        !archive_day
            .completed
            .iter()
            .any(|item| item.task.id == active.id)
    );
}
