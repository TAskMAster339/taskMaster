use super::*;

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
        Some(crate::domain::models::ReminderState::Pending)
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
        Some(crate::domain::models::ReminderState::Fired)
    );
    assert_eq!(
        skipped.reminder_state,
        Some(crate::domain::models::ReminderState::Missed)
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

#[test]
fn background_poll_archives_expired_tasks_before_sending_reminders() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Истекла в трее").unwrap();
    let deadline = task.created_at + 86_400_000;
    store
        .set_reminder_at(&task.id, deadline, task.created_at)
        .unwrap();
    let (archived, reminders) = store.poll_reminders_at(deadline).unwrap();
    assert_eq!(archived, 1);
    assert!(reminders.is_empty());
    assert_eq!(store.list_tasks().unwrap()[0].status, TaskStatus::Archived);
    assert_eq!(store.poll_reminders_at(deadline + 1).unwrap().0, 0);
    assert_eq!(store.count_archive_events().unwrap(), 1);
}

#[test]
#[ignore = "manual performance check on a disposable database"]
fn benchmark_queue_of_5000_tasks() {
    use std::time::Instant;
    let directory = std::env::temp_dir().join(format!("taskmaster-benchmark-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    {
        let store = TaskStore::open(directory.join("test.sqlite3")).unwrap();
        let now = crate::persistence::common::now_millis();
        store.connection.execute("WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<4999) INSERT INTO tasks(id,title,status,position,created_at,updated_at) SELECT printf('task-%d',x),'Проверка производительности','active',x,?1,?1 FROM n",[now]).unwrap();
        let start = Instant::now();
        let tasks = store.list_tasks().unwrap();
        eprintln!("5000: list = {:?}", start.elapsed());
        assert_eq!(tasks.len(), 5000);
        let start = Instant::now();
        store.rename_task(&tasks[0].id, "Новое название").unwrap();
        eprintln!("5000: rename = {:?}", start.elapsed());
        let mut ids: Vec<_> = tasks.iter().map(|t| t.id.clone()).collect();
        ids.swap(0, 1);
        let start = Instant::now();
        store.reorder_tasks(&ids).unwrap();
        eprintln!("5000: adjacent reorder = {:?}", start.elapsed());
        let start = Instant::now();
        store.complete_task(&ids[0]).unwrap();
        eprintln!("5000: complete = {:?}", start.elapsed());
        let start = Instant::now();
        store.poll_reminders_at(now + 1000).unwrap();
        eprintln!("5000: background poll = {:?}", start.elapsed());
        assert_eq!(
            store
                .list_tasks()
                .unwrap()
                .iter()
                .filter(|t| t.status == TaskStatus::Active)
                .count(),
            4999
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reopening_task_removes_cancelled_completion_from_history() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Вернуть в Сегодня").unwrap();
    store.complete_task(&task.id).unwrap();
    assert_eq!(
        store
            .list_history_for_range(0, i64::MAX)
            .unwrap()
            .completed
            .len(),
        1
    );
    store.reopen_task(&task.id).unwrap();
    assert!(
        store
            .list_history_for_range(0, i64::MAX)
            .unwrap()
            .completed
            .is_empty()
    );
    let events: i64 = store.connection.query_row(
        "SELECT COUNT(*) FROM task_events WHERE task_id = ?1 AND kind IN ('completed', 'reopened')",
        [&task.id],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(events, 2);
    store.complete_task(&task.id).unwrap();
    assert_eq!(
        store
            .list_history_for_range(0, i64::MAX)
            .unwrap()
            .completed
            .len(),
        1
    );
}
