use crate::app::error::AppError;
use crate::persistence::store::TaskStore;
use rusqlite::{Connection, params};
impl TaskStore {
    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }
}

impl TaskStore {
    #[cfg(test)]
    pub fn pause_timer_at(&self, id: &str, now: i64) -> Result<(), AppError> {
        self.pause_timer_at_elapsed(id, now, None)
    }
}

impl TaskStore {
    #[cfg(test)]
    pub fn force_completed_with_pending_reminder_for_test(&self, id: &str) -> rusqlite::Result<()> {
        self.connection
            .execute("UPDATE tasks SET status = 'completed' WHERE id = ?1", [id])?;
        Ok(())
    }
}

impl TaskStore {
    #[cfg(test)]
    pub fn count_archive_events(&self) -> rusqlite::Result<i64> {
        self.connection.query_row(
            "SELECT COUNT(*) FROM task_events WHERE kind = 'archived'",
            [],
            |row| row.get(0),
        )
    }
}

impl TaskStore {
    #[cfg(test)]
    pub fn count_events_for_task(&self, task_id: &str, kind: &str) -> rusqlite::Result<i64> {
        self.connection.query_row(
            "SELECT COUNT(*) FROM task_events WHERE task_id = ?1 AND kind = ?2",
            rusqlite::params![task_id, kind],
            |row| row.get(0),
        )
    }
}

impl TaskStore {
    #[cfg(test)]
    pub fn set_created_at(&self, id: &str, created_at: i64) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE tasks SET created_at = ?1 WHERE id = ?2",
            params![created_at, id],
        )?;
        Ok(())
    }
}
