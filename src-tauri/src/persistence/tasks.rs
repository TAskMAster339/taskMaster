use crate::app::error::AppError;
use crate::domain::models::{Task, TaskStatus};
use crate::persistence::common::{
    compact_active_positions, decode_reminder_state, decode_task_status, not_found, now_millis,
    record_event, task_exists, validate_title,
};
use crate::persistence::store::TaskStore;
use rusqlite::{OptionalExtension, params};
use std::collections::HashSet;
use uuid::Uuid;

impl TaskStore {
    pub fn list_tasks(&self) -> Result<Vec<Task>, AppError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, title, status, position, created_at, updated_at, completed_at, archived_at,
                        reminder_at, reminder_state
                 FROM tasks
                 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
                          CASE WHEN status = 'active' THEN position END ASC,
                          completed_at DESC",
            )
            .map_err(|_| AppError::storage())?;
        let rows = statement
            .query_map([], |row| {
                let status: String = row.get(2)?;
                let reminder_state: Option<String> = row.get(9)?;
                Ok(Task {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    status: decode_task_status(&status)?,
                    position: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    completed_at: row.get(6)?,
                    archived_at: row.get(7)?,
                    reminder_at: row.get(8)?,
                    reminder_state: reminder_state
                        .as_deref()
                        .map(decode_reminder_state)
                        .transpose()?,
                })
            })
            .map_err(|_| AppError::storage())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())
    }
    pub fn create_task(&self, raw_title: &str) -> Result<Task, AppError> {
        let title = validate_title(raw_title)?;
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let position: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM tasks WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| AppError::storage())?;
        let now = now_millis();
        let task = Task {
            id: Uuid::new_v4().to_string(),
            title: title.to_owned(),
            status: TaskStatus::Active,
            position,
            created_at: now,
            updated_at: now,
            completed_at: None,
            archived_at: None,
            reminder_at: None,
            reminder_state: None,
        };
        transaction
            .execute(
                "INSERT INTO tasks (id, title, status, position, created_at, updated_at)
                 VALUES (?1, ?2, 'active', ?3, ?4, ?4)",
                params![task.id, task.title, task.position, now],
            )
            .map_err(|_| AppError::storage())?;
        record_event(
            &transaction,
            &task.id,
            "created",
            now,
            &serde_json::json!({ "title": task.title }),
        )?;
        transaction.commit().map_err(|_| AppError::storage())?;
        Ok(task)
    }
    pub fn rename_task(&self, id: &str, raw_title: &str) -> Result<(), AppError> {
        let title = validate_title(raw_title)?;
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let old_title: Option<String> = transaction
            .query_row("SELECT title FROM tasks WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| AppError::storage())?;
        let old_title = old_title.ok_or_else(not_found)?;
        if old_title != title {
            let now = now_millis();
            transaction
                .execute(
                    "UPDATE tasks SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![title, now, id],
                )
                .map_err(|_| AppError::storage())?;
            record_event(
                &transaction,
                id,
                "renamed",
                now,
                &serde_json::json!({ "oldTitle": old_title, "newTitle": title }),
            )?;
        }
        transaction.commit().map_err(|_| AppError::storage())
    }
    pub fn complete_task(&self, id: &str) -> Result<(), AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let now = now_millis();
        let pending_reminder: Option<Option<i64>> = transaction
            .query_row(
                "SELECT reminder_at FROM tasks WHERE id = ?1 AND status = 'active' AND reminder_state = 'pending'",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| AppError::storage())?;
        let changed = transaction
            .execute(
                "UPDATE tasks SET status = 'completed', completed_at = ?1, updated_at = ?1,
                        reminder_at = CASE WHEN reminder_state = 'pending' THEN NULL ELSE reminder_at END,
                        reminder_state = CASE WHEN reminder_state = 'pending' THEN NULL ELSE reminder_state END
                 WHERE id = ?2 AND status = 'active'",
                params![now, id],
            )
            .map_err(|_| AppError::storage())?;
        if changed == 0 {
            return if task_exists(&transaction, id)? {
                Err(AppError::invalid_state())
            } else {
                Err(not_found())
            };
        }
        compact_active_positions(&transaction)?;
        if let Some(reminder_at) = pending_reminder {
            record_event(
                &transaction,
                id,
                "reminder_cleared",
                now,
                &serde_json::json!({ "reminderAt": reminder_at, "reason": "task_completed" }),
            )?;
        }
        record_event(&transaction, id, "completed", now, &serde_json::json!({}))?;
        transaction.commit().map_err(|_| AppError::storage())
    }
    pub fn reopen_task(&self, id: &str) -> Result<(), AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let position: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM tasks WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| AppError::storage())?;
        let now = now_millis();
        let changed = transaction
            .execute(
                "UPDATE tasks SET status = 'active', position = ?1, completed_at = NULL, updated_at = ?2
                 WHERE id = ?3 AND status = 'completed'",
                params![position, now, id],
            )
            .map_err(|_| AppError::storage())?;
        if changed == 0 {
            return if task_exists(&transaction, id)? {
                Err(AppError::invalid_state())
            } else {
                Err(not_found())
            };
        }
        record_event(&transaction, id, "reopened", now, &serde_json::json!({}))?;
        transaction.commit().map_err(|_| AppError::storage())
    }
    pub fn restore_task(&self, id: &str) -> Result<(), AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let previous_created_at: Option<i64> = transaction
            .query_row(
                "SELECT created_at FROM tasks WHERE id = ?1 AND status = 'archived'",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| AppError::storage())?;
        let Some(previous_created_at) = previous_created_at else {
            return if task_exists(&transaction, id)? {
                Err(AppError::invalid_state())
            } else {
                Err(not_found())
            };
        };

        let position: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM tasks WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| AppError::storage())?;
        let now = now_millis();
        transaction.execute(
            "UPDATE tasks SET status = 'active', position = ?1, created_at = ?2, updated_at = ?2,
             completed_at = NULL, archived_at = NULL WHERE id = ?3 AND status = 'archived'",
            params![position, now, id],
        ).map_err(|_| AppError::storage())?;
        record_event(
            &transaction,
            id,
            "restored",
            now,
            &serde_json::json!({ "previousCreatedAt": previous_created_at, "createdAt": now }),
        )?;
        transaction.commit().map_err(|_| AppError::storage())
    }
    pub fn reorder_tasks(&self, ids: &[String]) -> Result<(), AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let mut statement = transaction
            .prepare("SELECT id, position FROM tasks WHERE status = 'active' ORDER BY position")
            .map_err(|_| AppError::storage())?;
        let current = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|_| AppError::storage())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())?;
        drop(statement);

        let requested: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let known: HashSet<&str> = current.iter().map(|(id, _)| id.as_str()).collect();
        if ids.len() != current.len() || requested.len() != ids.len() || requested != known {
            return Err(AppError::invalid_order());
        }

        let old_positions: std::collections::HashMap<&str, i64> = current
            .iter()
            .map(|(id, position)| (id.as_str(), *position))
            .collect();
        let now = now_millis();
        for (position, id) in ids.iter().enumerate() {
            let position = position as i64;
            if old_positions.get(id.as_str()).copied() != Some(position) {
                transaction
                    .execute(
                        "UPDATE tasks SET position = ?1, updated_at = ?2 WHERE id = ?3",
                        params![position, now, id],
                    )
                    .map_err(|_| AppError::storage())?;
                record_event(
                    &transaction,
                    id,
                    "reordered",
                    now,
                    &serde_json::json!({ "position": position }),
                )?;
            }
        }
        transaction.commit().map_err(|_| AppError::storage())
    }
    pub fn archive_expired_tasks(&self, now: i64) -> Result<usize, AppError> {
        let retention_ms = self.preferences()?.archive_hours * 60 * 60 * 1000;
        let cutoff = now.saturating_sub(retention_ms);
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        transaction
            .execute("DELETE FROM deletion_undos WHERE expires_at <= ?1", [now])
            .map_err(|_| AppError::storage())?;
        let mut statement = transaction.prepare(
            "SELECT id FROM tasks WHERE status IN ('active', 'completed') AND created_at <= ?1 ORDER BY created_at, id",
        ).map_err(|_| AppError::storage())?;
        let ids = statement
            .query_map([cutoff], |row| row.get::<_, String>(0))
            .map_err(|_| AppError::storage())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())?;
        drop(statement);

        for id in &ids {
            transaction.execute(
                "UPDATE tasks SET status = 'archived', archived_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![now, id],
            ).map_err(|_| AppError::storage())?;
            record_event(&transaction, id, "archived", now, &serde_json::json!({}))?;
        }
        if !ids.is_empty() {
            compact_active_positions(&transaction)?;
        }
        transaction.commit().map_err(|_| AppError::storage())?;
        Ok(ids.len())
    }
}
