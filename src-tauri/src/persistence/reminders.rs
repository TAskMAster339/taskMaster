use crate::app::error::AppError;
use crate::domain::models::DueReminder;
use crate::persistence::common::{not_found, now_millis, record_event};
use crate::persistence::store::TaskStore;
use rusqlite::{OptionalExtension, params};

impl TaskStore {
    pub fn set_reminder(&self, id: &str, reminder_at: i64) -> Result<(), AppError> {
        self.set_reminder_at(id, reminder_at, now_millis())
    }
    pub fn set_reminder_at(&self, id: &str, reminder_at: i64, now: i64) -> Result<(), AppError> {
        if reminder_at <= now {
            return Err(AppError::invalid_reminder_time());
        }

        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let task: Option<(String, Option<i64>, Option<String>)> = transaction
            .query_row(
                "SELECT status, reminder_at, reminder_state FROM tasks WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| AppError::storage())?;
        let Some((status, old_reminder_at, old_reminder_state)) = task else {
            return Err(not_found());
        };
        if status != "active" {
            return Err(AppError::invalid_state());
        }
        if old_reminder_at == Some(reminder_at) && old_reminder_state.as_deref() == Some("pending")
        {
            return transaction.commit().map_err(|_| AppError::storage());
        }

        transaction
            .execute(
                "UPDATE tasks SET reminder_at = ?1, reminder_state = 'pending', updated_at = ?2
                 WHERE id = ?3",
                params![reminder_at, now, id],
            )
            .map_err(|_| AppError::storage())?;
        record_event(
            &transaction,
            id,
            "reminder_set",
            now,
            &serde_json::json!({ "reminderAt": reminder_at }),
        )?;
        transaction.commit().map_err(|_| AppError::storage())
    }
    pub fn clear_reminder(&self, id: &str) -> Result<(), AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let reminder_at: Option<Option<i64>> = transaction
            .query_row("SELECT reminder_at FROM tasks WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| AppError::storage())?;
        let Some(reminder_at) = reminder_at else {
            return Err(not_found());
        };
        let Some(reminder_at) = reminder_at else {
            return transaction.commit().map_err(|_| AppError::storage());
        };

        let now = now_millis();
        transaction
            .execute(
                "UPDATE tasks SET reminder_at = NULL, reminder_state = NULL, updated_at = ?1
                 WHERE id = ?2",
                params![now, id],
            )
            .map_err(|_| AppError::storage())?;
        record_event(
            &transaction,
            id,
            "reminder_cleared",
            now,
            &serde_json::json!({ "reminderAt": reminder_at }),
        )?;
        transaction.commit().map_err(|_| AppError::storage())
    }
    pub fn take_due_reminders(&self, now: i64) -> Result<Vec<DueReminder>, AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let mut statement = transaction
            .prepare(
                "SELECT id, title, reminder_at FROM tasks
                 WHERE status = 'active' AND reminder_state = 'pending' AND reminder_at <= ?1
                 ORDER BY reminder_at, id",
            )
            .map_err(|_| AppError::storage())?;
        let due = statement
            .query_map([now], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|_| AppError::storage())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())?;
        drop(statement);

        let mut reminders = Vec::with_capacity(due.len());
        for (id, title, reminder_at) in due {
            transaction
                .execute(
                    "UPDATE tasks SET reminder_state = 'fired' WHERE id = ?1 AND reminder_state = 'pending'",
                    [&id],
                )
                .map_err(|_| AppError::storage())?;
            record_event(
                &transaction,
                &id,
                "reminder_fired",
                now,
                &serde_json::json!({ "reminderAt": reminder_at }),
            )?;
            reminders.push(DueReminder { task_id: id, title });
        }
        transaction.commit().map_err(|_| AppError::storage())?;
        Ok(reminders)
    }
    pub fn poll_reminders_at(&self, now: i64) -> Result<(usize, Vec<DueReminder>), AppError> {
        let archived = self.archive_expired_tasks(now)?;
        self.clear_non_active_reminders(now)?;
        self.mark_missed_reminders(now.saturating_sub(30_000))?;
        Ok((archived, self.take_due_reminders(now)?))
    }
    pub fn mark_missed_reminders(&self, now: i64) -> Result<usize, AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let mut statement = transaction
            .prepare(
                "SELECT id, reminder_at FROM tasks
                 WHERE reminder_state = 'pending' AND reminder_at <= ?1
                 ORDER BY reminder_at, id",
            )
            .map_err(|_| AppError::storage())?;
        let overdue = statement
            .query_map([now], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|_| AppError::storage())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())?;
        drop(statement);

        for (id, reminder_at) in &overdue {
            transaction
                .execute(
                    "UPDATE tasks SET reminder_state = 'missed' WHERE id = ?1 AND reminder_state = 'pending'",
                    [id],
                )
                .map_err(|_| AppError::storage())?;
            record_event(
                &transaction,
                id,
                "reminder_missed",
                now,
                &serde_json::json!({ "reminderAt": reminder_at }),
            )?;
        }
        transaction.commit().map_err(|_| AppError::storage())?;
        Ok(overdue.len())
    }
    pub fn clear_non_active_reminders(&self, now: i64) -> Result<usize, AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let mut statement = transaction
            .prepare(
                "SELECT id, reminder_at FROM tasks
                 WHERE status != 'active' AND reminder_state = 'pending'",
            )
            .map_err(|_| AppError::storage())?;
        let reminders = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .map_err(|_| AppError::storage())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())?;
        drop(statement);

        for (id, reminder_at) in &reminders {
            transaction
                .execute(
                    "UPDATE tasks SET reminder_at = NULL, reminder_state = NULL
                     WHERE id = ?1 AND status != 'active' AND reminder_state = 'pending'",
                    [id],
                )
                .map_err(|_| AppError::storage())?;
            record_event(
                &transaction,
                id,
                "reminder_cleared",
                now,
                &serde_json::json!({ "reminderAt": reminder_at, "reason": "task_inactive" }),
            )?;
        }
        transaction.commit().map_err(|_| AppError::storage())?;
        Ok(reminders.len())
    }
}
