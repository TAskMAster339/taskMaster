use super::*;
use crate::domain::models::TaskStatus;
#[test]
fn clear_tasks_preserves_settings_but_full_reset_restores_defaults() {
    for mode in [ClearMode::Tasks, ClearMode::AllData] {
        let store = TaskStore::in_memory().unwrap();
        let task = store.create_task("Task").unwrap();
        store.delete_task_at(&task.id, task.created_at).unwrap();
        store.create_timer("Timer", 60, 1000).unwrap();
        store.set_preferences(30, 48).unwrap();
        store
            .set_shortcut("new_task", "Ctrl+Alt+N", "Ctrl+Alt+Space")
            .unwrap();
        let shortcuts = store.shortcuts().unwrap();
        store.clear_data(mode).unwrap();
        store.clear_data(mode).unwrap();
        for table in ["tasks", "task_events", "deletion_undos", "focus_sessions"] {
            assert_eq!(
                store
                    .connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            store.list_timers_at(1000).unwrap().len(),
            if matches!(mode, ClearMode::Tasks) {
                1
            } else {
                0
            }
        );
        let full_reset = matches!(mode, ClearMode::AllData);
        assert_eq!(
            store.preferences().unwrap().reminder_minutes,
            if full_reset { 15 } else { 30 }
        );
        assert_eq!(
            store.preferences().unwrap().archive_hours,
            if full_reset { 24 } else { 48 }
        );
        assert_eq!(
            store.shortcuts().unwrap(),
            if full_reset {
                crate::domain::shortcuts::defaults()
            } else {
                shortcuts
            }
        );
    }
}
#[test]
fn clear_data_rolls_back_on_failure() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Keep").unwrap();
    store.delete_task_at(&task.id, task.created_at).unwrap();
    store.connection.execute_batch("CREATE TRIGGER reject_clear BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'blocked'); END;").unwrap();
    let before = store.export_data().unwrap();
    assert!(store.clear_data(ClearMode::AllData).is_err());
    assert_eq!(store.export_data().unwrap(), before);
    assert_eq!(store.list_deletion_undos(task.created_at).unwrap().len(), 1);
}
#[test]
fn clear_data_keeps_backup_restorable() {
    for mode in [ClearMode::Tasks, ClearMode::AllData] {
        let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&directory).unwrap();
        let mut store = TaskStore::open(directory.join("live.sqlite3")).unwrap();
        store.create_task("Recover").unwrap();
        store.create_timer("Recover timer", 60, 1000).unwrap();
        let backup = directory.join("manual.sqlite3");
        crate::persistence::backups::snapshot(&store.connection, &backup).unwrap();
        let bytes = std::fs::read(&backup).unwrap();
        store.clear_data(mode).unwrap();
        assert_eq!(std::fs::read(&backup).unwrap(), bytes);
        let prepared = crate::persistence::backups::prepare(&backup, &directory).unwrap();
        crate::persistence::backups::restore_live(&mut store, &prepared, &directory).unwrap();
        assert_eq!(store.list_tasks().unwrap().len(), 1);
        assert_eq!(store.list_timers_at(1000).unwrap().len(), 1);
        drop(prepared);
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
#[test]
fn permanent_deletion_removes_only_the_confirmed_task_and_its_history() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Удалить").unwrap();
    let other = store.create_task("Оставить").unwrap();
    store.delete_task_at(&task.id, task.created_at).unwrap();
    store.connection.execute("INSERT INTO focus_sessions(id,task_id,duration_seconds,started_at,running_since,status) VALUES('legacy',?1,60,0,0,'finished')", [&task.id]).unwrap();
    let summary = store.prepare_permanent_deletion(&task.id).unwrap();
    assert_eq!(summary.session_count, 1);
    store.permanently_delete_task(&summary).unwrap();
    assert_eq!(
        store.list_tasks().unwrap(),
        vec![task_by_id(&store.connection, &other.id).unwrap()]
    );
    for table in ["task_events", "focus_sessions", "deletion_undos"] {
        let count: i64 = store
            .connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE task_id=?1"),
                [&task.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}
#[test]
fn permanent_deletion_requires_history_and_rejects_changed_confirmation() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Меняется").unwrap();
    assert!(store.prepare_permanent_deletion(&task.id).is_err());
    store.complete_task(&task.id).unwrap();
    let summary = store.prepare_permanent_deletion(&task.id).unwrap();
    store.rename_task(&task.id, "Новое название").unwrap();
    assert!(store.permanently_delete_task(&summary).is_err());
    let summary = store.prepare_permanent_deletion(&task.id).unwrap();
    record_event(
        &store.connection,
        &task.id,
        "test",
        task.created_at,
        &serde_json::json!({}),
    )
    .unwrap();
    assert!(store.permanently_delete_task(&summary).is_err());
    assert_eq!(store.list_tasks().unwrap().len(), 1);
}
#[test]
fn permanent_deletion_rolls_back_all_related_data_if_task_delete_fails() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Сохранить при ошибке").unwrap();
    store.delete_task_at(&task.id, task.created_at).unwrap();
    store.connection.execute("INSERT INTO focus_sessions(id,task_id,duration_seconds,started_at,running_since,status) VALUES('legacy',?1,60,0,0,'finished')", [&task.id]).unwrap();
    let summary = store.prepare_permanent_deletion(&task.id).unwrap();
    store.connection.execute_batch("CREATE TRIGGER reject_purge BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'failure'); END;").unwrap();
    assert!(store.permanently_delete_task(&summary).is_err());
    assert_eq!(store.prepare_permanent_deletion(&task.id).unwrap(), summary);
    assert_eq!(store.list_deletion_undos(task.created_at).unwrap().len(), 1);
}
#[test]
fn purging_restored_history_task_compacts_queue_and_keeps_independent_timers() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Первая").unwrap();
    store.complete_task(&task.id).unwrap();
    store.reopen_task(&task.id).unwrap();
    let other = store.create_task("Вторая").unwrap();
    let timer = store
        .create_timer("Отдельный", 60, task.created_at)
        .unwrap();
    let summary = store.prepare_permanent_deletion(&task.id).unwrap();
    store.permanently_delete_task(&summary).unwrap();
    assert_eq!(
        task_by_id(&store.connection, &other.id).unwrap().position,
        0
    );
    assert_eq!(store.list_timers().unwrap()[0].id, timer.id);
    assert!(store.permanently_delete_task(&summary).is_err());
}
#[test]
fn removing_a_task_archives_it_keeps_history_and_compacts_the_queue() {
    let store = TaskStore::in_memory().unwrap();
    let first = store.create_task("Первая").unwrap();
    let second = store.create_task("Вторая").unwrap();
    let third = store.create_task("Третья").unwrap();
    let now = first.created_at + 1000;
    store
        .set_reminder_at(&second.id, now + 100000, now)
        .unwrap();
    let undo = store.delete_task_at(&second.id, now).unwrap();
    assert_eq!(undo.expires_at, now + 5000);
    let tasks = store.list_tasks().unwrap();
    assert_eq!(tasks.len(), 3);
    let deleted = tasks.iter().find(|task| task.id == second.id).unwrap();
    assert_eq!(deleted.status, TaskStatus::Archived);
    assert_eq!(deleted.reminder_at, None);
    let active = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Active)
        .map(|task| (task.id.clone(), task.position))
        .collect::<Vec<_>>();
    assert_eq!(active, [(first.id, 0), (third.id, 1)]);
    assert_eq!(
        store.count_events_for_task(&second.id, "deleted").unwrap(),
        1
    );
    assert_eq!(
        store.list_history_for_range(now, now + 1).unwrap().archived[0]
            .task
            .id,
        second.id
    );
    assert!(store.take_due_reminders(now + 100000).unwrap().is_empty());
}
#[test]
fn undo_preserves_creation_deadline_order_and_future_reminder() {
    let store = TaskStore::in_memory().unwrap();
    let first = store.create_task("Первая").unwrap();
    let second = store.create_task("Вторая").unwrap();
    let third = store.create_task("Третья").unwrap();
    let now = first.created_at + 10;
    store.set_reminder_at(&second.id, now + 60000, now).unwrap();
    let undo = store.delete_task_at(&second.id, now).unwrap();
    let restored = store
        .undo_task_deletion_at(&undo.token, now + 4999)
        .unwrap();
    assert_eq!(restored.status, TaskStatus::Active);
    assert_eq!(restored.created_at, second.created_at);
    assert_eq!(restored.reminder_state, Some(ReminderState::Pending));
    assert_eq!(
        store
            .list_tasks()
            .unwrap()
            .iter()
            .filter(|t| t.status == TaskStatus::Active)
            .map(|t| (t.id.clone(), t.position))
            .collect::<Vec<_>>(),
        [(first.id, 0), (second.id, 1), (third.id, 2)]
    );
    assert!(
        store
            .undo_task_deletion_at(&undo.token, now + 4999)
            .is_err()
    );
    assert!(store.list_deletion_undos(now + 4999).unwrap().is_empty());
}
#[test]
fn undo_at_exact_deadline_is_rejected_and_cleanup_preserves_history() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Срок").unwrap();
    let now = task.created_at;
    let undo = store.delete_task_at(&task.id, now).unwrap();
    assert!(
        store
            .undo_task_deletion_at(&undo.token, now + 5000)
            .is_err()
    );
    assert!(store.list_deletion_undos(now + 5000).unwrap().is_empty());
    assert_eq!(store.list_tasks().unwrap()[0].status, TaskStatus::Archived);
    assert_eq!(store.count_events_for_task(&task.id, "deleted").unwrap(), 1);
}
#[test]
fn completed_task_returns_to_its_previous_completion_state() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Готовая").unwrap();
    store.complete_task(&task.id).unwrap();
    let before = task_by_id(&store.connection, &task.id).unwrap();
    let now = before.updated_at + 100;
    let undo = store.delete_task_at(&task.id, now).unwrap();
    let restored = store.undo_task_deletion_at(&undo.token, now + 1).unwrap();
    assert_eq!(restored.status, TaskStatus::Completed);
    assert_eq!(restored.completed_at, before.completed_at);
    assert_eq!(restored.created_at, before.created_at);
}
#[test]
fn undo_does_not_replay_a_reminder_that_became_due() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Напомнить").unwrap();
    let now = task.created_at;
    store.set_reminder_at(&task.id, now + 1000, now).unwrap();
    let undo = store.delete_task_at(&task.id, now + 10).unwrap();
    let restored = store
        .undo_task_deletion_at(&undo.token, now + 1001)
        .unwrap();
    assert_eq!(restored.reminder_state, Some(ReminderState::Missed));
    assert!(store.take_due_reminders(now + 2000).unwrap().is_empty());
    assert_eq!(
        store
            .count_events_for_task(&task.id, "reminder_missed")
            .unwrap(),
        1
    );
}
#[test]
fn stale_tokens_and_repeated_removal_cannot_change_a_newer_deletion() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Одна").unwrap();
    let now = task.created_at;
    let old = store.delete_task_at(&task.id, now).unwrap();
    assert!(store.delete_task_at(&task.id, now + 1).is_err());
    store.undo_task_deletion_at(&old.token, now + 2).unwrap();
    let new = store.delete_task_at(&task.id, now + 3).unwrap();
    assert!(store.undo_task_deletion_at(&old.token, now + 4).is_err());
    assert_eq!(store.list_tasks().unwrap()[0].status, TaskStatus::Archived);
    store.undo_task_deletion_at(&new.token, now + 5).unwrap();
}
#[test]
fn deletion_rolls_back_task_reminder_queue_and_events_on_storage_failure() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Не потерять").unwrap();
    let next = store.create_task("Следующая").unwrap();
    let now = task.created_at;
    store.set_reminder_at(&task.id, now + 60000, now).unwrap();
    store.connection.execute_batch("CREATE TRIGGER reject_deletion BEFORE INSERT ON task_events WHEN NEW.kind='deleted' BEGIN SELECT RAISE(ABORT,'failure'); END;").unwrap();
    assert!(store.delete_task_at(&task.id, now + 1).is_err());
    let tasks = store.list_tasks().unwrap();
    assert_eq!(tasks[0].id, task.id);
    assert_eq!(tasks[0].status, TaskStatus::Active);
    assert_eq!(tasks[0].reminder_state, Some(ReminderState::Pending));
    assert_eq!(tasks[1].id, next.id);
    assert_eq!(tasks[1].position, 1);
    assert_eq!(
        store
            .count_events_for_task(&task.id, "reminder_cleared")
            .unwrap(),
        0
    );
    assert!(store.list_deletion_undos(now + 2).unwrap().is_empty());
}
#[test]
fn undo_does_not_extend_the_task_lifetime() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("На границе суток").unwrap();
    let deadline = task.created_at + 86_400_000;
    let undo = store.delete_task_at(&task.id, deadline - 1000).unwrap();
    let restored = store
        .undo_task_deletion_at(&undo.token, deadline + 1000)
        .unwrap();
    assert_eq!(restored.status, TaskStatus::Archived);
    assert_eq!(restored.created_at, task.created_at);
    assert!(
        store
            .take_due_reminders(deadline + 1001)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn history_restore_invalidates_the_old_undo() {
    let store = TaskStore::in_memory().unwrap();
    let task = store.create_task("Из истории").unwrap();
    let undo = store.delete_task_at(&task.id, task.created_at).unwrap();
    store.restore_task(&task.id).unwrap();
    assert!(
        store
            .undo_task_deletion_at(&undo.token, task.created_at + 100)
            .is_err()
    );
    assert!(
        store
            .list_deletion_undos(task.created_at + 100)
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.list_tasks().unwrap()[0].status, TaskStatus::Active);
}
#[test]
fn pending_undo_survives_reopening_the_database() {
    let file = std::env::temp_dir().join(format!(
        "taskmaster-deletion-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let (undo, now);
    {
        let store = TaskStore::open(&file).unwrap();
        let task = store.create_task("Перезапуск").unwrap();
        now = task.created_at;
        undo = store.delete_task_at(&task.id, now).unwrap();
    }
    {
        let store = TaskStore::open(&file).unwrap();
        assert_eq!(
            store.list_deletion_undos(now + 100).unwrap()[0].token,
            undo.token
        );
        store.undo_task_deletion_at(&undo.token, now + 100).unwrap();
        assert_eq!(store.list_tasks().unwrap()[0].status, TaskStatus::Active);
    }
    std::fs::remove_file(file).unwrap();
}
