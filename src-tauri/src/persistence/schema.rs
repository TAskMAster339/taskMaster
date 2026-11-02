use crate::persistence::store::{CURRENT_SCHEMA_VERSION, TaskStore};
use rusqlite::Connection;
use std::{collections::HashMap, sync::Mutex};

impl TaskStore {
    pub(crate) fn from_connection(connection: Connection) -> rusqlite::Result<Self> {
        let schema_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if !(0..=CURRENT_SCHEMA_VERSION).contains(&schema_version) {
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
        if schema_version < 6 {
            let tx = connection.unchecked_transaction()?;
            tx.execute_batch("CREATE TABLE preferences (id INTEGER PRIMARY KEY CHECK(id=1), reminder_minutes INTEGER NOT NULL CHECK(reminder_minutes BETWEEN 1 AND 1439), archive_hours INTEGER NOT NULL CHECK(archive_hours BETWEEN 1 AND 8760)); INSERT INTO preferences VALUES(1,15,24); PRAGMA user_version=6;")?;
            tx.commit()?;
        }
        if schema_version < 7 {
            let tx = connection.unchecked_transaction()?;
            tx.execute_batch("CREATE TABLE keyboard_shortcuts(action TEXT PRIMARY KEY NOT NULL, combination TEXT NOT NULL); PRAGMA user_version=7;")?;
            tx.commit()?;
        }
        if schema_version < 8 {
            let tx = connection.unchecked_transaction()?;
            tx.execute_batch("CREATE TABLE deletion_undos(token TEXT PRIMARY KEY NOT NULL,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,previous_task TEXT NOT NULL,deleted_task TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE INDEX deletion_undos_expiration ON deletion_undos(expires_at); PRAGMA user_version=8;")?;
            tx.commit()?;
        }
        Ok(Self {
            connection,
            timer_clocks: Mutex::new(HashMap::new()),
        })
    }
}
