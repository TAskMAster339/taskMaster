use crate::app::error::AppError;
use crate::domain::models::{ReminderState, TaskStatus};
use rusqlite::{Connection, params};
use std::time::SystemTime;
use uuid::Uuid;

pub(super) fn validate_title(raw_title: &str) -> Result<&str, AppError> {
    crate::domain::validation::task_title(raw_title).ok_or_else(AppError::invalid_title)
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(super) fn task_exists(connection: &Connection, id: &str) -> Result<bool, AppError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| AppError::storage())
}

pub(crate) fn compact_active_positions(connection: &Connection) -> Result<(), AppError> {
    let mut statement = connection
        .prepare("SELECT id FROM tasks WHERE status = 'active' ORDER BY position")
        .map_err(|_| AppError::storage())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| AppError::storage())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| AppError::storage())?;
    drop(statement);
    for (position, id) in ids.iter().enumerate() {
        connection
            .execute(
                "UPDATE tasks SET position = ?1 WHERE id = ?2",
                params![position as i64, id],
            )
            .map_err(|_| AppError::storage())?;
    }
    Ok(())
}

pub(crate) fn record_event(
    connection: &Connection,
    task_id: &str,
    kind: &str,
    occurred_at: i64,
    details: &serde_json::Value,
) -> Result<(), AppError> {
    connection
        .execute(
            "INSERT INTO task_events (id, task_id, kind, occurred_at, details)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                Uuid::new_v4().to_string(),
                task_id,
                kind,
                occurred_at,
                details.to_string()
            ],
        )
        .map_err(|_| AppError::storage())?;
    Ok(())
}

pub(super) fn not_found() -> AppError {
    AppError {
        code: "task_not_found",
        message: "Задача уже недоступна. Обновите список.".into(),
    }
}

pub(crate) fn decode_reminder_state(value: &str) -> rusqlite::Result<ReminderState> {
    match value {
        "pending" => Ok(ReminderState::Pending),
        "fired" => Ok(ReminderState::Fired),
        "missed" => Ok(ReminderState::Missed),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

pub(crate) fn decode_task_status(value: &str) -> rusqlite::Result<TaskStatus> {
    match value {
        "active" => Ok(TaskStatus::Active),
        "completed" => Ok(TaskStatus::Completed),
        "archived" => Ok(TaskStatus::Archived),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
