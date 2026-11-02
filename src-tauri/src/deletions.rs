use crate::{
    AppError,
    tasks::{ReminderState, Task, TaskStatus, TaskStore, compact_active_positions, record_event},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoDeletion {
    pub token: String,
    pub task_id: String,
    pub title: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeSummary {
    pub task: Task,
    pub event_count: i64,
    pub session_count: i64,
}

fn purge_summary(connection: &Connection, id: &str) -> Result<PurgeSummary, AppError> {
    let task = task_by_id(connection, id)?;
    let eligible: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_events WHERE task_id=?1 AND kind IN ('completed','archived'))",
        [id], |row| row.get(0),
    ).map_err(|_| AppError::storage())?;
    if !eligible {
        return Err(AppError::invalid_state());
    }
    let event_count = connection
        .query_row(
            "SELECT COUNT(*) FROM task_events WHERE task_id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| AppError::storage())?;
    let session_count = connection
        .query_row(
            "SELECT COUNT(*) FROM focus_sessions WHERE task_id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| AppError::storage())?;
    Ok(PurgeSummary {
        task,
        event_count,
        session_count,
    })
}

fn expired_undo() -> AppError {
    AppError {
        code: "undo_expired",
        message: "Отменить удаление можно в течение пяти секунд. Задача сохранена в истории."
            .into(),
    }
}
pub(crate) fn task_by_id(connection: &Connection, id: &str) -> Result<Task, AppError> {
    connection.query_row("SELECT id,title,status,position,created_at,updated_at,completed_at,archived_at,reminder_at,reminder_state FROM tasks WHERE id=?1",[id],|row| {
        let status:String=row.get(2)?; let reminder:Option<String>=row.get(9)?;
        Ok(Task {id:row.get(0)?,title:row.get(1)?,status:TaskStatus::parse(&status)?,position:row.get(3)?,created_at:row.get(4)?,updated_at:row.get(5)?,completed_at:row.get(6)?,archived_at:row.get(7)?,reminder_at:row.get(8)?,reminder_state:reminder.as_deref().map(ReminderState::parse).transpose()?})
    }).optional().map_err(|_|AppError::storage())?.ok_or_else(AppError::invalid_state)
}
fn status_name(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Active => "active",
        TaskStatus::Completed => "completed",
        TaskStatus::Archived => "archived",
    }
}
fn reminder_name(state: Option<ReminderState>) -> Option<&'static str> {
    state.map(|state| match state {
        ReminderState::Pending => "pending",
        ReminderState::Fired => "fired",
        ReminderState::Missed => "missed",
    })
}

impl TaskStore {
    pub fn prepare_permanent_deletion(&self, id: &str) -> Result<PurgeSummary, AppError> {
        purge_summary(&self.connection, id)
    }

    pub fn permanently_delete_task(&self, expected: &PurgeSummary) -> Result<(), AppError> {
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        if purge_summary(&tx, &expected.task.id)? != *expected {
            return Err(AppError {
                code: "task_changed",
                message: "Задача изменилась. Откройте подтверждение удаления заново.".into(),
            });
        }
        for table in ["focus_sessions", "task_events", "deletion_undos", "tasks"] {
            let column = if table == "tasks" { "id" } else { "task_id" };
            tx.execute(
                &format!("DELETE FROM {table} WHERE {column}=?1"),
                [&expected.task.id],
            )
            .map_err(|_| AppError::storage())?;
        }
        compact_active_positions(&tx)?;
        tx.commit().map_err(|_| AppError::storage())
    }
    pub fn delete_task_at(&self, id: &str, now: i64) -> Result<UndoDeletion, AppError> {
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let previous = task_by_id(&tx, id)?;
        if previous.status == TaskStatus::Archived {
            return Err(AppError::invalid_state());
        }
        let mut deleted = previous.clone();
        deleted.status = TaskStatus::Archived;
        deleted.archived_at = Some(now);
        deleted.updated_at = now;
        if deleted.reminder_state == Some(ReminderState::Pending) {
            deleted.reminder_at = None;
            deleted.reminder_state = None;
            record_event(
                &tx,
                id,
                "reminder_cleared",
                now,
                &serde_json::json!({"reminderAt":previous.reminder_at,"reason":"task_deleted"}),
            )?;
        }
        tx.execute("UPDATE tasks SET status='archived',archived_at=?1,updated_at=?1,reminder_at=?2,reminder_state=?3 WHERE id=?4",params![now,deleted.reminder_at,reminder_name(deleted.reminder_state),id]).map_err(|_|AppError::storage())?;
        compact_active_positions(&tx)?;
        record_event(
            &tx,
            id,
            "deleted",
            now,
            &serde_json::json!({"previousStatus":status_name(previous.status),"position":previous.position}),
        )?;
        record_event(
            &tx,
            id,
            "archived",
            now,
            &serde_json::json!({"reason":"deleted"}),
        )?;
        let token = uuid::Uuid::new_v4().to_string();
        let expires_at = now.saturating_add(5000);
        tx.execute(
            "DELETE FROM deletion_undos WHERE expires_at <= ?1 OR task_id=?2",
            params![now, id],
        )
        .map_err(|_| AppError::storage())?;
        tx.execute("INSERT INTO deletion_undos(token,task_id,previous_task,deleted_task,expires_at) VALUES(?1,?2,?3,?4,?5)",params![token,id,serde_json::to_string(&previous).map_err(|_|AppError::storage())?,serde_json::to_string(&deleted).map_err(|_|AppError::storage())?,expires_at]).map_err(|_|AppError::storage())?;
        tx.commit().map_err(|_| AppError::storage())?;
        Ok(UndoDeletion {
            token,
            task_id: id.into(),
            title: previous.title,
            expires_at,
        })
    }
    pub fn undo_task_deletion_at(&self, token: &str, now: i64) -> Result<Task, AppError> {
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let snapshot: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT previous_task,deleted_task,expires_at FROM deletion_undos WHERE token=?1",
                [token],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| AppError::storage())?;
        let Some((previous, deleted, expires_at)) = snapshot else {
            return Err(expired_undo());
        };
        if now >= expires_at {
            return Err(expired_undo());
        }
        let mut restored: Task =
            serde_json::from_str(&previous).map_err(|_| AppError::storage())?;
        let expected: Task = serde_json::from_str(&deleted).map_err(|_| AppError::storage())?;
        if task_by_id(&tx, &restored.id)? != expected {
            return Err(AppError::invalid_state());
        }
        restored.updated_at = now;
        let retention = self.preferences()?.archive_hours * 60 * 60 * 1000;
        let expired = restored.created_at <= now.saturating_sub(retention);
        if expired {
            restored.status = TaskStatus::Archived;
            restored.archived_at = Some(now);
            restored.reminder_at = expected.reminder_at;
            restored.reminder_state = expected.reminder_state;
        }
        if restored.status == TaskStatus::Active {
            let count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM tasks WHERE status='active'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| AppError::storage())?;
            restored.position = restored.position.clamp(0, count);
            tx.execute(
                "UPDATE tasks SET position=position+1 WHERE status='active' AND position>=?1",
                [restored.position],
            )
            .map_err(|_| AppError::storage())?;
        }
        if restored.reminder_state == Some(ReminderState::Pending) {
            if restored.reminder_at.is_some_and(|time| time <= now) {
                restored.reminder_state = Some(ReminderState::Missed);
            }
            record_event(
                &tx,
                &restored.id,
                if restored.reminder_state == Some(ReminderState::Missed) {
                    "reminder_missed"
                } else {
                    "reminder_set"
                },
                now,
                &serde_json::json!({"reminderAt":restored.reminder_at,"reason":"deletion_undone"}),
            )?;
        }
        tx.execute("UPDATE tasks SET status=?1,position=?2,created_at=?3,updated_at=?4,completed_at=?5,archived_at=?6,reminder_at=?7,reminder_state=?8 WHERE id=?9",params![status_name(restored.status),restored.position,restored.created_at,now,restored.completed_at,restored.archived_at,restored.reminder_at,reminder_name(restored.reminder_state),restored.id]).map_err(|_|AppError::storage())?;
        tx.execute("DELETE FROM deletion_undos WHERE token=?1", [token])
            .map_err(|_| AppError::storage())?;
        record_event(
            &tx,
            &restored.id,
            "restored",
            now,
            &serde_json::json!({"reason":"deletion_undone","status":status_name(restored.status)}),
        )?;
        if expired {
            record_event(
                &tx,
                &restored.id,
                "archived",
                now,
                &serde_json::json!({"reason":"expired_after_undo"}),
            )?;
        }
        tx.commit().map_err(|_| AppError::storage())?;
        Ok(restored)
    }
    pub fn list_deletion_undos(&self, now: i64) -> Result<Vec<UndoDeletion>, AppError> {
        self.connection
            .execute("DELETE FROM deletion_undos WHERE expires_at<=?1", [now])
            .map_err(|_| AppError::storage())?;
        let mut stmt=self.connection.prepare("SELECT u.token,u.task_id,u.previous_task,u.expires_at FROM deletion_undos u JOIN tasks t ON t.id=u.task_id WHERE u.expires_at>?1 AND t.status='archived' ORDER BY u.expires_at,u.token").map_err(|_|AppError::storage())?;
        let rows = stmt
            .query_map([now], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|_| AppError::storage())?;
        rows.map(|row| {
            let (token, task_id, previous, expires_at) = row.map_err(|_| AppError::storage())?;
            let previous: Task =
                serde_json::from_str(&previous).map_err(|_| AppError::storage())?;
            Ok(UndoDeletion {
                token,
                task_id,
                title: previous.title,
                expires_at,
            })
        })
        .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::TaskStatus;
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
}
