use std::{collections::HashSet, path::Path, time::SystemTime};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;

use crate::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Active,
    Completed,
}

impl TaskStatus {
    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "active" => Ok(Self::Active),
            "completed" => Ok(Self::Completed),
            _ => Err(rusqlite::Error::InvalidQuery),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

pub struct TaskStore {
    connection: Connection,
}

impl TaskStore {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> rusqlite::Result<Self> {
        let schema_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if !(0..=1).contains(&schema_version) {
            return Err(rusqlite::Error::InvalidQuery);
        }

        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        if schema_version == 0 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(
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
                 PRAGMA user_version = 1;",
            )?;
            transaction.commit()?;
        }
        Ok(Self { connection })
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>, AppError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, title, status, position, created_at, updated_at, completed_at
                 FROM tasks
                 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
                          CASE WHEN status = 'active' THEN position END ASC,
                          completed_at DESC",
            )
            .map_err(|_| AppError::storage())?;
        let rows = statement
            .query_map([], |row| {
                let status: String = row.get(2)?;
                Ok(Task {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    status: TaskStatus::parse(&status)?,
                    position: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    completed_at: row.get(6)?,
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
        let changed = transaction
            .execute(
                "UPDATE tasks SET status = 'completed', completed_at = ?1, updated_at = ?1
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
}

fn validate_title(raw_title: &str) -> Result<&str, AppError> {
    let title = raw_title.trim();
    if title.is_empty() || title.chars().count() > 300 {
        return Err(AppError::invalid_title());
    }
    Ok(title)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn task_exists(connection: &Connection, id: &str) -> Result<bool, AppError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| AppError::storage())
}

fn compact_active_positions(connection: &Connection) -> Result<(), AppError> {
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

fn record_event(
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

fn not_found() -> AppError {
    AppError {
        code: "task_not_found",
        message: "Задача уже недоступна. Обновите список.".into(),
    }
}
