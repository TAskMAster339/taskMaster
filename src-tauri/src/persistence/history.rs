use crate::app::error::AppError;
use crate::domain::models::{HistoryDay, HistoryTask, Task};
use crate::persistence::common::{decode_reminder_state, decode_task_status};
use crate::persistence::store::TaskStore;

impl TaskStore {
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
    pub(super) fn list_history_kind(
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
                   AND (e.kind <> 'completed' OR NOT EXISTS (
                       SELECT 1 FROM task_events reopened
                       WHERE reopened.task_id = e.task_id AND reopened.kind = 'reopened'
                         AND reopened.rowid > e.rowid
                   ))
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
                    },
                    occurred_at: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|_| AppError::storage())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| AppError::storage())
    }
}
