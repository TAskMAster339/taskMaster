use crate::domain::models::TaskStatus;
use crate::persistence::store::TaskStore;
use crate::platform::windows::{clamp_to_monitor, overlay_timer_window_size};

use rusqlite::Connection;

use std::path::PathBuf;

use uuid::Uuid;

struct TemporaryDatabase(PathBuf);

impl TemporaryDatabase {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("taskmaster-{}.sqlite3", Uuid::new_v4())))
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal"] {
            let mut path = self.0.as_os_str().to_owned();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

mod overlay;
mod storage;
#[path = "store_support.rs"]
mod store_support;
mod tasks;
mod timers;
