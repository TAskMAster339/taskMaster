use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Mutex,
    time::{Instant, SystemTime},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;

use crate::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Active,
    Completed,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderState {
    Pending,
    Fired,
    Missed,
}

impl ReminderState {
    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "fired" => Ok(Self::Fired),
            "missed" => Ok(Self::Missed),
            _ => Err(rusqlite::Error::InvalidQuery),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DueReminder {
    pub task_id: String,
    pub title: String,
}

impl TaskStatus {
    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "active" => Ok(Self::Active),
            "completed" => Ok(Self::Completed),
            "archived" => Ok(Self::Archived),
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
    pub archived_at: Option<i64>,
    pub reminder_at: Option<i64>,
    pub reminder_state: Option<ReminderState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTask {
    pub task: Task,
    pub occurred_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDay {
    pub completed: Vec<HistoryTask>,
    pub archived: Vec<HistoryTask>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub id: String,
    pub name: String,
    pub duration_seconds: i64,
    pub remaining_seconds: i64,
    pub status: String,
}

pub const MAX_TIMER_SECONDS: i64 = 359_999;

pub struct TaskStore {
    connection: Connection,
    timer_clocks: Mutex<HashMap<String, Instant>>,
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
        if !(0..=5).contains(&schema_version) {
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
        let migrated_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if migrated_version == 1 {
            connection.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 BEGIN;
                 CREATE TABLE tasks_new (
                     id TEXT PRIMARY KEY NOT NULL,
                     title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
                     status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'archived')),
                     position INTEGER NOT NULL,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL,
                     completed_at INTEGER,
                     archived_at INTEGER
                 );
                 INSERT INTO tasks_new (id, title, status, position, created_at, updated_at, completed_at)
                     SELECT id, title, status, position, created_at, updated_at, completed_at FROM tasks;
                 DROP TABLE tasks;
                 ALTER TABLE tasks_new RENAME TO tasks;
                 CREATE INDEX tasks_status_position ON tasks(status, position);
                 PRAGMA user_version = 2;
                 COMMIT;
                 PRAGMA foreign_keys = ON;",
            )?;
        }
        let migrated_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if migrated_version == 2 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(
                "ALTER TABLE tasks ADD COLUMN reminder_at INTEGER;
                 ALTER TABLE tasks ADD COLUMN reminder_state TEXT
                     CHECK(reminder_state IS NULL OR reminder_state IN ('pending', 'fired', 'missed'));
                 CREATE INDEX tasks_reminder_due ON tasks(reminder_state, reminder_at);
                 PRAGMA user_version = 3;",
            )?;
            transaction.commit()?;
        }
        let migrated_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if migrated_version == 3 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(
                "CREATE TABLE focus_sessions (
                    id TEXT PRIMARY KEY NOT NULL,
                    task_id TEXT NOT NULL REFERENCES tasks(id),
                    duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 60 AND 10800),
                    elapsed_seconds INTEGER NOT NULL DEFAULT 0,
                    started_at INTEGER NOT NULL,
                    running_since INTEGER NOT NULL,
                    paused_at INTEGER,
                    ended_at INTEGER,
                    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'interrupted', 'finished', 'cancelled'))
                 );
                 CREATE UNIQUE INDEX one_live_focus_session ON focus_sessions((1))
                     WHERE status IN ('active', 'paused', 'interrupted');
                 PRAGMA user_version = 4;"
            )?;
            transaction.commit()?;
        }
        let migrated_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if migrated_version == 4 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(
                "CREATE TABLE timers (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
                    duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 359999),
                    remaining_seconds INTEGER NOT NULL CHECK(remaining_seconds BETWEEN 0 AND 359999),
                    status TEXT NOT NULL CHECK(status IN ('ready', 'running', 'paused', 'finished')),
                    started_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX timers_created ON timers(created_at, id);
                 PRAGMA user_version = 5;",
            )?;
            transaction.commit()?;
        }
        Ok(Self {
            connection,
            timer_clocks: Mutex::new(HashMap::new()),
        })
    }

    pub fn create_timer(
        &self,
        raw_name: &str,
        duration_seconds: i64,
        now: i64,
    ) -> Result<Timer, AppError> {
        let name = raw_name.trim();
        if name.is_empty()
            || name.chars().count() > 80
            || !(1..=MAX_TIMER_SECONDS).contains(&duration_seconds)
        {
            return Err(AppError::invalid_timer());
        }
        let id = Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO timers(id,name,duration_seconds,remaining_seconds,status,created_at,updated_at) VALUES(?1,?2,?3,?3,'ready',?4,?4)",
            params![id, name, duration_seconds, now],
        ).map_err(|_| AppError::storage())?;
        Ok(Timer {
            id,
            name: name.into(),
            duration_seconds,
            remaining_seconds: duration_seconds,
            status: "ready".into(),
        })
    }

    pub fn list_timers(&self) -> Result<Vec<Timer>, AppError> {
        self.list_timers_at(now_millis())
    }

    pub fn list_timers_at(&self, now: i64) -> Result<Vec<Timer>, AppError> {
        let mut statement = self.connection.prepare("SELECT id,name,duration_seconds,remaining_seconds,status,started_at FROM timers ORDER BY created_at,rowid").map_err(|_| AppError::storage())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(|_| AppError::storage())?;
        let clocks = self.timer_clocks.lock().map_err(|_| AppError::lock())?;
        rows.map(|row| {
            let (id, name, duration_seconds, remaining_seconds, status, started_at) =
                row.map_err(|_| AppError::storage())?;
            let remaining_seconds = if status == "running" {
                let elapsed = clocks
                    .get(&id)
                    .map(|started| started.elapsed().as_secs() as i64)
                    .or_else(|| started_at.map(|started| now.saturating_sub(started).max(0) / 1000))
                    .unwrap_or_default();
                remaining_seconds.saturating_sub(elapsed).max(0)
            } else {
                remaining_seconds
            };
            Ok(Timer {
                id,
                name,
                duration_seconds,
                remaining_seconds,
                status,
            })
        })
        .collect()
    }

    pub fn start_timer(&self, id: &str) -> Result<(), AppError> {
        self.start_timer_at(id, now_millis())?;
        self.timer_clocks
            .lock()
            .map_err(|_| AppError::lock())?
            .insert(id.into(), Instant::now());
        Ok(())
    }

    pub fn start_timer_at(&self, id: &str, now: i64) -> Result<(), AppError> {
        let changed = self.connection.execute("UPDATE timers SET status='running',started_at=?1,updated_at=?1 WHERE id=?2 AND status IN ('ready','paused') AND remaining_seconds > 0", params![now,id]).map_err(|_| AppError::storage())?;
        if changed == 0 {
            return Err(AppError::invalid_state());
        }
        Ok(())
    }

    pub fn pause_timer(&self, id: &str) -> Result<(), AppError> {
        let elapsed = self
            .timer_clocks
            .lock()
            .map_err(|_| AppError::lock())?
            .remove(id)
            .map(|started| started.elapsed().as_secs() as i64);
        self.pause_timer_at_elapsed(id, now_millis(), elapsed)
    }

    #[cfg(test)]
    pub fn pause_timer_at(&self, id: &str, now: i64) -> Result<(), AppError> {
        self.pause_timer_at_elapsed(id, now, None)
    }

    fn pause_timer_at_elapsed(
        &self,
        id: &str,
        now: i64,
        monotonic_elapsed: Option<i64>,
    ) -> Result<(), AppError> {
        let started_at: Option<i64> = self
            .connection
            .query_row(
                "SELECT started_at FROM timers WHERE id=?1 AND status='running'",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| AppError::storage())?;
        let Some(started_at) = started_at else {
            return Err(AppError::invalid_state());
        };
        let remaining: i64 = self
            .connection
            .query_row(
                "SELECT remaining_seconds FROM timers WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|_| AppError::storage())?;
        let elapsed =
            monotonic_elapsed.unwrap_or_else(|| now.saturating_sub(started_at).max(0) / 1000);
        self.connection.execute("UPDATE timers SET status='paused',remaining_seconds=?1,started_at=NULL,updated_at=?2 WHERE id=?3", params![remaining.saturating_sub(elapsed).max(0),now,id]).map_err(|_| AppError::storage())?;
        Ok(())
    }

    pub fn reset_timer(&self, id: &str) -> Result<(), AppError> {
        self.reset_timer_at(id, now_millis())
    }

    pub fn reset_timer_at(&self, id: &str, now: i64) -> Result<(), AppError> {
        let changed = self.connection.execute("UPDATE timers SET status='ready',remaining_seconds=duration_seconds,started_at=NULL,updated_at=?1 WHERE id=?2", params![now,id]).map_err(|_| AppError::storage())?;
        self.timer_clocks
            .lock()
            .map_err(|_| AppError::lock())?
            .remove(id);
        if changed == 0 {
            return Err(AppError::invalid_state());
        }
        Ok(())
    }

    pub fn delete_timer(&self, id: &str) -> Result<(), AppError> {
        let changed = self
            .connection
            .execute("DELETE FROM timers WHERE id=?1", [id])
            .map_err(|_| AppError::storage())?;
        self.timer_clocks
            .lock()
            .map_err(|_| AppError::lock())?
            .remove(id);
        if changed == 0 {
            return Err(AppError::invalid_state());
        }
        Ok(())
    }

    pub fn take_due_timers(&self) -> Result<Vec<Timer>, AppError> {
        self.take_due_timers_at(now_millis())
    }

    pub fn take_due_timers_at(&self, now: i64) -> Result<Vec<Timer>, AppError> {
        let timers = self.list_timers_at(now)?;
        let mut due = Vec::new();
        for timer in timers
            .into_iter()
            .filter(|timer| timer.status == "running" && timer.remaining_seconds == 0)
        {
            let changed = self.connection.execute("UPDATE timers SET status='finished',remaining_seconds=0,started_at=NULL,updated_at=?1 WHERE id=?2 AND status='running'", params![now,&timer.id]).map_err(|_| AppError::storage())?;
            if changed > 0 {
                self.timer_clocks
                    .lock()
                    .map_err(|_| AppError::lock())?
                    .remove(&timer.id);
                due.push(Timer {
                    status: "finished".into(),
                    ..timer
                });
            }
        }
        Ok(due)
    }

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
                    status: TaskStatus::parse(&status)?,
                    position: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    completed_at: row.get(6)?,
                    archived_at: row.get(7)?,
                    reminder_at: row.get(8)?,
                    reminder_state: reminder_state
                        .as_deref()
                        .map(ReminderState::parse)
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

    #[cfg(test)]
    pub fn force_completed_with_pending_reminder_for_test(&self, id: &str) -> rusqlite::Result<()> {
        self.connection
            .execute("UPDATE tasks SET status = 'completed' WHERE id = ?1", [id])?;
        Ok(())
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

    pub fn list_history_for_range(&self, start: i64, end: i64) -> Result<HistoryDay, AppError> {
        if start >= end {
            return Err(AppError::invalid_state());
        }
        Ok(HistoryDay {
            completed: self.list_history_kind("completed", start, end)?,
            archived: self.list_history_kind("archived", start, end)?,
        })
    }

    pub fn list_task_creation_times(&self, start: i64, end: i64) -> Result<Vec<i64>, AppError> {
        if start >= end {
            return Err(AppError::invalid_state());
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT occurred_at FROM task_events
                 WHERE kind = 'created' AND occurred_at >= ?1 AND occurred_at < ?2
                 ORDER BY occurred_at ASC",
            )
            .map_err(|_| AppError::storage())?;
        let rows = statement
            .query_map(rusqlite::params![start, end], |row| row.get(0))
            .map_err(|_| AppError::storage())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())
    }

    fn list_history_kind(
        &self,
        kind: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<HistoryTask>, AppError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT t.id, t.title, t.status, t.position, t.created_at, t.updated_at,
                        t.completed_at, t.archived_at, t.reminder_at, t.reminder_state, MAX(e.occurred_at),
                        COALESCE((SELECT MIN(created.occurred_at) FROM task_events created
                                  WHERE created.task_id = t.id AND created.kind = 'created'), t.created_at)
                 FROM task_events e JOIN tasks t ON t.id = e.task_id
                 WHERE e.kind = ?1 AND e.occurred_at >= ?2 AND e.occurred_at < ?3
                 GROUP BY t.id ORDER BY MAX(e.occurred_at) DESC, t.id",
            )
            .map_err(|_| AppError::storage())?;
        let rows = statement
            .query_map(rusqlite::params![kind, start, end], |row| {
                let status: String = row.get(2)?;
                let reminder_state: Option<String> = row.get(9)?;
                Ok(HistoryTask {
                    task: Task {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        status: TaskStatus::parse(&status)?,
                        position: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        completed_at: row.get(6)?,
                        archived_at: row.get(7)?,
                        reminder_at: row.get(8)?,
                        reminder_state: reminder_state
                            .as_deref()
                            .map(ReminderState::parse)
                            .transpose()?,
                    },
                    occurred_at: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|_| AppError::storage())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())
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
        const RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
        let cutoff = now.saturating_sub(RETENTION_MS);
        let transaction = self
            .connection
            .unchecked_transaction()
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
        compact_active_positions(&transaction)?;
        transaction.commit().map_err(|_| AppError::storage())?;
        Ok(ids.len())
    }

    #[cfg(test)]
    pub fn count_archive_events(&self) -> rusqlite::Result<i64> {
        self.connection.query_row(
            "SELECT COUNT(*) FROM task_events WHERE kind = 'archived'",
            [],
            |row| row.get(0),
        )
    }

    #[cfg(test)]
    pub fn count_events_for_task(&self, task_id: &str, kind: &str) -> rusqlite::Result<i64> {
        self.connection.query_row(
            "SELECT COUNT(*) FROM task_events WHERE task_id = ?1 AND kind = ?2",
            rusqlite::params![task_id, kind],
            |row| row.get(0),
        )
    }

    #[cfg(test)]
    pub fn set_created_at(&self, id: &str, created_at: i64) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE tasks SET created_at = ?1 WHERE id = ?2",
            params![created_at, id],
        )?;
        Ok(())
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
