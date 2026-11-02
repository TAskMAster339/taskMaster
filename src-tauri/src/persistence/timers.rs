use crate::app::error::AppError;
use crate::domain::models::Timer;
use crate::persistence::common::now_millis;
use crate::persistence::store::TaskStore;
use rusqlite::{OptionalExtension, params};
use std::time::Instant;
use uuid::Uuid;

impl TaskStore {
    pub fn create_timer(
        &self,
        raw_name: &str,
        duration_seconds: i64,
        now: i64,
    ) -> Result<Timer, AppError> {
        let name = crate::domain::validation::timer_name(raw_name, duration_seconds)
            .ok_or_else(AppError::invalid_timer)?;
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
    pub(crate) fn pause_timer_at_elapsed(
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
}
