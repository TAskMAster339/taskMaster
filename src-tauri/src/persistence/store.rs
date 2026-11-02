use rusqlite::Connection;
use std::{collections::HashMap, path::Path, sync::Mutex, time::Instant};

pub(crate) const CURRENT_SCHEMA_VERSION: i64 = 8;

pub struct TaskStore {
    pub(crate) connection: Connection,
    pub(crate) timer_clocks: Mutex<HashMap<String, Instant>>,
}

impl TaskStore {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        use std::io::Read;
        let path = path.as_ref();
        if path.exists() {
            let mut header = [0u8; 16];
            let mut file = std::fs::File::open(path).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if file.read_exact(&mut header).is_err() || &header != b"SQLite format 3\0" {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        let connection = Connection::open(path)?;
        let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Self::from_connection(connection)
    }
}
