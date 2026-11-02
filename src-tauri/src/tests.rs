use super::{
    clamp_to_monitor, overlay_timer_window_size,
    tasks::{TaskStatus, TaskStore},
};
use rusqlite::Connection;
use std::path::PathBuf;
use uuid::Uuid;

#[test]
fn overlay_position_is_clamped_inside_the_monitor_work_area() {
    assert_eq!(
        clamp_to_monitor(900, 700, 100, 50, 800, 600, 360, 154),
        (540, 496)
    );
    assert_eq!(
        clamp_to_monitor(-500, -200, 100, 50, 800, 600, 360, 154),
        (100, 50)
    );
}

#[test]
fn overlay_timer_columns_expand_right_without_growing_beyond_two_rows() {
    assert_eq!(overlay_timer_window_size(0, 1920.0), (360.0, 154.0));
    assert_eq!(overlay_timer_window_size(1, 1920.0), (452.0, 594.0));
    assert_eq!(overlay_timer_window_size(4, 1920.0), (896.0, 594.0));
    assert_eq!(overlay_timer_window_size(20, 500.0), (500.0, 474.0));
}

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
fn archives_tasks_at_the_24_hour_creation_deadline_and_only_once() {
    let store = TaskStore::in_memory().unwrap();
    let active = store.create_task("Активная").unwrap();
    let completed = store.create_task("Выполненная").unwrap();
    store.set_created_at(&active.id, 1_000).unwrap();
    store.set_created_at(&completed.id, 2_000).unwrap();
    store.complete_task(&completed.id).unwrap();

    const TWENTY_FOUR_HOURS_MS: i64 = 24 * 60 * 60 * 1000;
    let deadline = 1_000 + TWENTY_FOUR_HOURS_MS;

    assert_eq!(store.archive_expired_tasks(deadline - 1).unwrap(), 0);
    assert_eq!(store.archive_expired_tasks(deadline).unwrap(), 1);
    assert_eq!(store.archive_expired_tasks(deadline + 1_000).unwrap(), 1);
    assert_eq!(store.archive_expired_tasks(deadline + 1).unwrap(), 0);

    let tasks = store.list_tasks().unwrap();
    assert!(tasks.iter().all(|task| task.status == TaskStatus::Archived));
    assert_eq!(store.count_archive_events().unwrap(), 2);
}

#[test]
fn reminders_are_validated_stored_and_cleared_with_history() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Позвонить").unwrap();

    store.set_reminder_at(&task.id, 5_000, 1_000).unwrap();
    assert!(store.set_reminder_at(&task.id, 999, 1_000).is_err());

    let scheduled = store
        .list_tasks()
        .unwrap()
        .into_iter()
        .find(|item| item.id == task.id)
        .unwrap();
    assert_eq!(scheduled.reminder_at, Some(5_000));
    assert_eq!(
        scheduled.reminder_state,
        Some(super::tasks::ReminderState::Pending)
    );

    store.clear_reminder(&task.id).unwrap();
    let cleared = store
        .list_tasks()
        .unwrap()
        .into_iter()
        .find(|item| item.id == task.id)
        .unwrap();
    assert_eq!(cleared.reminder_at, None);
    assert_eq!(cleared.reminder_state, None);
    assert_eq!(
        store
            .count_events_for_task(&task.id, "reminder_set")
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .count_events_for_task(&task.id, "reminder_cleared")
            .unwrap(),
        1
    );
}

#[test]
fn due_reminders_fire_once_and_overdue_reminders_are_marked_missed() {
    let store = TaskStore::in_memory().unwrap();
    let due = store.create_task("Выполнить дело").unwrap();
    let missed = store.create_task("Пропущенное дело").unwrap();
    store.set_reminder_at(&due.id, 2_000, 1_000).unwrap();
    store.set_reminder_at(&missed.id, 3_000, 1_000).unwrap();

    assert!(store.take_due_reminders(1_999).unwrap().is_empty());
    let notifications = store.take_due_reminders(2_000).unwrap();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0].task_id, due.id);
    assert_eq!(notifications[0].title, "Выполнить дело");
    assert!(store.take_due_reminders(2_001).unwrap().is_empty());

    assert_eq!(store.mark_missed_reminders(3_000).unwrap(), 1);
    assert_eq!(store.mark_missed_reminders(3_001).unwrap(), 0);
    assert!(store.take_due_reminders(10_000).unwrap().is_empty());
    let tasks = store.list_tasks().unwrap();
    let fired = tasks.iter().find(|item| item.id == due.id).unwrap();
    let skipped = tasks.iter().find(|item| item.id == missed.id).unwrap();
    assert_eq!(
        fired.reminder_state,
        Some(super::tasks::ReminderState::Fired)
    );
    assert_eq!(
        skipped.reminder_state,
        Some(super::tasks::ReminderState::Missed)
    );
    assert_eq!(
        store
            .count_events_for_task(&due.id, "reminder_fired")
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .count_events_for_task(&missed.id, "reminder_missed")
            .unwrap(),
        1
    );
}

#[test]
fn completing_task_clears_pending_reminder_and_completed_tasks_cannot_be_scheduled() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Завершить до встречи").unwrap();
    store.set_reminder_at(&task.id, 5_000, 1_000).unwrap();

    store.complete_task(&task.id).unwrap();

    let completed = store
        .list_tasks()
        .unwrap()
        .into_iter()
        .find(|item| item.id == task.id)
        .unwrap();
    assert_eq!(completed.reminder_at, None);
    assert_eq!(completed.reminder_state, None);
    assert_eq!(
        store
            .count_events_for_task(&task.id, "reminder_cleared")
            .unwrap(),
        1
    );
    assert!(store.take_due_reminders(i64::MAX).unwrap().is_empty());
    assert!(store.set_reminder_at(&task.id, 6_000, 1_000).is_err());
}

#[test]
fn old_pending_reminders_on_completed_tasks_are_not_sent_and_are_cleared() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Уже выполнено").unwrap();
    store.set_reminder_at(&task.id, 5_000, 1_000).unwrap();
    store
        .force_completed_with_pending_reminder_for_test(&task.id)
        .unwrap();

    assert!(store.take_due_reminders(5_000).unwrap().is_empty());
    assert_eq!(store.clear_non_active_reminders(5_001).unwrap(), 1);

    let completed = store
        .list_tasks()
        .unwrap()
        .into_iter()
        .find(|item| item.id == task.id)
        .unwrap();
    assert_eq!(completed.reminder_at, None);
    assert_eq!(completed.reminder_state, None);
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
    assert_eq!(version, 5);
    assert_eq!(violations, 0);
}

#[test]
fn independent_timers_are_persisted_and_can_run_in_parallel() {
    let store = TaskStore::in_memory().unwrap();
    let first = store.create_timer("Чай", 60, 1_000).unwrap();
    let second = store.create_timer("Перерыв", 180, 1_001).unwrap();
    store.start_timer_at(&first.id, 1_000).unwrap();
    store.start_timer_at(&second.id, 1_001).unwrap();

    let timers = store.list_timers_at(11_000).unwrap();
    assert_eq!(timers.len(), 2);
    assert_eq!(timers[0].name, "Чай");
    assert_eq!(timers[0].remaining_seconds, 50);
    assert_eq!(timers[0].status, "running");
    assert_eq!(timers[1].remaining_seconds, 171);
}

#[test]
fn independent_timer_can_pause_resume_reset_and_finish_once() {
    let store = TaskStore::in_memory().unwrap();
    let timer = store.create_timer("Варка", 60, 1_000).unwrap();
    store.start_timer_at(&timer.id, 1_000).unwrap();
    store.pause_timer_at(&timer.id, 11_000).unwrap();
    assert_eq!(
        store.list_timers_at(100_000).unwrap()[0].remaining_seconds,
        50
    );
    store.start_timer_at(&timer.id, 100_000).unwrap();

    assert!(store.take_due_timers_at(149_999).unwrap().is_empty());
    let due = store.take_due_timers_at(150_000).unwrap();
    assert_eq!(due[0].id, timer.id);
    assert_eq!(due[0].status, "finished");
    assert!(store.take_due_timers_at(151_000).unwrap().is_empty());

    store.reset_timer_at(&timer.id, 151_000).unwrap();
    assert_eq!(
        store.list_timers_at(151_000).unwrap()[0].remaining_seconds,
        60
    );
}

#[test]
fn timer_creation_rejects_empty_names_and_zero_duration() {
    let store = TaskStore::in_memory().unwrap();
    assert!(store.create_timer(" ", 30, 1_000).is_err());
    assert!(store.create_timer("Варка", 0, 1_000).is_err());
    assert!(store.list_timers_at(1_000).unwrap().is_empty());
}

#[test]
fn running_timer_restores_its_remaining_time_after_reopening_the_database() {
    let database = TemporaryDatabase::new();
    let timer_id;
    {
        let store = TaskStore::open(&database.0).unwrap();
        timer_id = store.create_timer("Перерыв", 60, 1_000).unwrap().id;
        store.start_timer_at(&timer_id, 1_000).unwrap();
    }

    let store = TaskStore::open(&database.0).unwrap();
    let restored = store.list_timers_at(11_000).unwrap();
    assert_eq!(restored[0].id, timer_id);
    assert_eq!(restored[0].remaining_seconds, 50);
    assert_eq!(restored[0].status, "running");
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
            .execute_batch("DROP INDEX timers_created; DROP TABLE timers; PRAGMA user_version=4;")
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
fn restores_archived_task_to_queue_with_a_new_24_hour_window_and_history_event() {
    let store = TaskStore::in_memory().unwrap();
    let old = store.create_task("Старая задача").unwrap();
    let active = store.create_task("Остаётся в очереди").unwrap();
    store.set_created_at(&old.id, 1_000).unwrap();
    store
        .archive_expired_tasks(1_000 + 24 * 60 * 60 * 1000)
        .unwrap();

    store.restore_task(&old.id).unwrap();

    let tasks = store.list_tasks().unwrap();
    let restored = tasks.iter().find(|task| task.id == old.id).unwrap();
    assert_eq!(restored.status, TaskStatus::Active);
    assert_eq!(restored.position, 1);
    assert!(restored.created_at > 1_000 + 24 * 60 * 60 * 1000);
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

#[test]
fn lists_creation_times_in_a_half_open_calendar_range() {
    let store = TaskStore::in_memory().unwrap();
    let created = store.create_task("Задача с отметкой в календаре").unwrap();
    let start = created.created_at;
    let end = start + 1;

    assert_eq!(store.list_task_creation_times(start, end).unwrap(), [start]);
    assert!(
        store
            .list_task_creation_times(end, end + 1)
            .unwrap()
            .is_empty()
    );
}
