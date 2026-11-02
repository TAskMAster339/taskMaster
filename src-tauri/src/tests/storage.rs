use super::*;

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
    assert_eq!(version, 8);
    assert_eq!(violations, 0);
}

#[test]
fn migration_preserves_legacy_focus_history_without_blocking_task_completion() {
    let database = TemporaryDatabase::new();
    let task_id;
    {
        let store = TaskStore::open(&database.0).unwrap();
        task_id = store.create_task("Обычная задача").unwrap().id;
    }

    {
        let connection = Connection::open(&database.0).unwrap();
        connection.execute("INSERT INTO focus_sessions(id,task_id,duration_seconds,started_at,running_since,status) VALUES('legacy-session',?1,60,1000,1000,'active')", [&task_id]).unwrap();
        connection
            .execute_batch("DROP INDEX timers_created; DROP TABLE timers; DROP TABLE preferences; DROP TABLE keyboard_shortcuts; DROP TABLE deletion_undos; PRAGMA user_version=4;")
            .unwrap();
    }

    let store = TaskStore::open(&database.0).unwrap();
    store.complete_task(&task_id).unwrap();
    assert!(store.list_timers().unwrap().is_empty());
    let connection = Connection::open(&database.0).unwrap();
    let legacy_sessions: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM focus_sessions WHERE id='legacy-session'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(legacy_sessions, 1);
}

#[test]
fn export_includes_archived_tasks_events_and_legacy_sessions() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Экспорт").unwrap();
    store.set_created_at(&task.id, 1000).unwrap();
    store.archive_expired_tasks(1000 + 86_400_000).unwrap();
    store.create_timer("Чай", 60, 1000).unwrap();
    let data = store.export_data().unwrap();
    assert_eq!(data["tasks"][0]["status"], "archived");
    assert_eq!(data["task_events"].as_array().unwrap().len(), 2);
    assert_eq!(data["timers"][0]["name"], "Чай");
    assert!(data["focus_sessions"].is_array());
}

#[test]
fn preferences_persist_validate_and_control_archive_boundary() {
    let db = TemporaryDatabase::new();
    let id;
    {
        let store = TaskStore::open(&db.0).unwrap();
        assert_eq!(store.preferences().unwrap().reminder_minutes, 15);
        assert_eq!(store.preferences().unwrap().archive_hours, 24);
        store.set_preferences(30, 2).unwrap();
        assert_eq!(store.preferences().unwrap().reminder_minutes, 30);
        for (minutes, hours) in [(0, 2), (1440, 2), (30, 0), (30, 8761)] {
            assert!(store.set_preferences(minutes, hours).is_err());
        }
        let task = store.create_task("Срок").unwrap();
        id = task.id;
        store.set_created_at(&id, 1000).unwrap();
    }
    let store = TaskStore::open(&db.0).unwrap();
    assert_eq!(store.preferences().unwrap().archive_hours, 2);
    assert_eq!(
        store.archive_expired_tasks(1000 + 7_200_000 - 1).unwrap(),
        0
    );
    assert_eq!(store.archive_expired_tasks(1000 + 7_200_000).unwrap(), 1);
    assert_eq!(store.archive_expired_tasks(1000 + 7_200_001).unwrap(), 0);
    assert_eq!(store.list_tasks().unwrap()[0].id, id);
}

#[test]
fn custom_shortcuts_persist_and_reject_conflicts_without_overwriting() {
    let db = TemporaryDatabase::new();
    {
        let store = TaskStore::open(&db.0).unwrap();
        store
            .set_shortcut("new_task", "Ctrl+Shift+T", "Ctrl+Alt+Space")
            .unwrap();
        assert!(
            store
                .set_shortcut("new_task", "Ctrl+R", "Ctrl+Alt+Space")
                .is_err()
        );
        assert!(
            store
                .set_shortcut("new_task", "Ctrl+Alt+Space", "Ctrl+Alt+Space")
                .is_err()
        );
        assert_eq!(store.shortcuts().unwrap()["new_task"], "Ctrl+Shift+T");
    }
    let store = TaskStore::open(&db.0).unwrap();
    assert_eq!(store.shortcuts().unwrap()["new_task"], "Ctrl+Shift+T");
    assert_eq!(store.shortcuts().unwrap()["rename"], "F2");
    assert_eq!(
        store.export_data().unwrap()["keyboard_shortcuts"][0]["action"],
        "new_task"
    );
}
