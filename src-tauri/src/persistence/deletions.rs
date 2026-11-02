use crate::app::error::AppError;
use crate::domain::models::{ReminderState, Task, TaskStatus};
use crate::persistence::common::{
    compact_active_positions, decode_reminder_state, decode_task_status, record_event,
};
use crate::persistence::store::TaskStore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClearMode {
    Tasks,
    AllData,
}

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

pub(super) fn purge_summary(connection: &Connection, id: &str) -> Result<PurgeSummary, AppError> {
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

pub(super) fn expired_undo() -> AppError {
    AppError {
        code: "undo_expired",
        message: "Отменить удаление можно в течение пяти секунд. Задача сохранена в истории."
            .into(),
    }
}

pub(crate) fn task_by_id(connection: &Connection, id: &str) -> Result<Task, AppError> {
    connection.query_row("SELECT id,title,status,position,created_at,updated_at,completed_at,archived_at,reminder_at,reminder_state FROM tasks WHERE id=?1",[id],|row| {
        let status:String=row.get(2)?; let reminder:Option<String>=row.get(9)?;
        Ok(Task {id:row.get(0)?,title:row.get(1)?,status:decode_task_status(&status)?,position:row.get(3)?,created_at:row.get(4)?,updated_at:row.get(5)?,completed_at:row.get(6)?,archived_at:row.get(7)?,reminder_at:row.get(8)?,reminder_state:reminder.as_deref().map(decode_reminder_state).transpose()?})
    }).optional().map_err(|_|AppError::storage())?.ok_or_else(AppError::invalid_state)
}

pub(super) fn status_name(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Active => "active",
        TaskStatus::Completed => "completed",
        TaskStatus::Archived => "archived",
    }
}

pub(super) fn reminder_name(state: Option<ReminderState>) -> Option<&'static str> {
    state.map(|state| match state {
        ReminderState::Pending => "pending",
        ReminderState::Fired => "fired",
        ReminderState::Missed => "missed",
    })
}

impl TaskStore {
    pub fn clear_data(&self, mode: ClearMode) -> Result<(), AppError> {
        let mut clocks = self.timer_clocks.lock().map_err(|_| AppError::lock())?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        tx.execute_batch("DELETE FROM focus_sessions; DELETE FROM task_events; DELETE FROM deletion_undos; DELETE FROM tasks;").map_err(|_| AppError::storage())?;
        if matches!(mode, ClearMode::AllData) {
            tx.execute("DELETE FROM timers", [])
                .map_err(|_| AppError::storage())?;
            tx.execute_batch("DELETE FROM keyboard_shortcuts; UPDATE preferences SET reminder_minutes=15,archive_hours=24 WHERE id=1;")
                .map_err(|_| AppError::storage())?;
        }
        tx.commit().map_err(|_| AppError::storage())?;
        if matches!(mode, ClearMode::AllData) {
            clocks.clear();
        }
        Ok(())
    }
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
#[path = "../tests/deletions_tests.rs"]
mod tests;
