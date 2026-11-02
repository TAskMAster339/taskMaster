use serde::Serialize;
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const MAX_BYTES: u64 = 256 * 1024;
const ARCHIVES: usize = 3;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    AppStarted,
    AppStopped,
    StorageError,
    CommandRejected,
    BackupWarning,
    ReminderError,
    TimerError,
    NotificationError,
    ShortcutConflict,
    Panic,
}

struct LocalLog {
    directory: PathBuf,
    max_bytes: u64,
}
impl LocalLog {
    fn write_at(&self, event: Event, code: Option<&'static str>, now: i64) -> io::Result<()> {
        #[derive(Serialize)]
        struct Record {
            timestamp: i64,
            event: Event,
            code: Option<&'static str>,
        }
        let mut line = serde_json::to_vec(&Record {
            timestamp: now,
            event,
            code,
        })?;
        line.push(b'\n');
        let current = self.directory.join("diagnostics.jsonl");
        let size = match fs::metadata(&current) {
            Ok(value) => value.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error),
        };
        if size > 0 && size.saturating_add(line.len() as u64) > self.max_bytes {
            let oldest = self.directory.join(format!("diagnostics.{ARCHIVES}.jsonl"));
            match fs::remove_file(oldest) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            for index in (1..ARCHIVES).rev() {
                let from = self.directory.join(format!("diagnostics.{index}.jsonl"));
                let to = self
                    .directory
                    .join(format!("diagnostics.{}.jsonl", index + 1));
                match fs::rename(from, to) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
            fs::rename(&current, self.directory.join("diagnostics.1.jsonl"))?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(current)?;
        file.write_all(&line)?;
        file.flush()
    }
}

struct State {
    log: Option<LocalLog>,
    warning: Option<String>,
}
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
const WRITE_WARNING: &str = "Не удалось записать диагностический журнал. Проверьте свободное место и доступ к папке данных.";

pub fn initialize(directory: &Path) {
    let state = match fs::create_dir_all(directory) {
        Ok(()) => State {
            log: Some(LocalLog {
                directory: directory.into(),
                max_bytes: MAX_BYTES,
            }),
            warning: None,
        },
        Err(_) => State {
            log: None,
            warning: Some(WRITE_WARNING.into()),
        },
    };
    let _ = STATE.set(Mutex::new(state));
    record(Event::AppStarted, None);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Never record panic payloads: they may contain user data.
        record(Event::Panic, None);
        previous(info);
    }));
}

pub fn record(event: Event, code: Option<&'static str>) {
    if let Some(state) = STATE.get()
        && let Ok(mut state) = state.lock()
        && let Some(log) = &state.log
        && log
            .write_at(event, code, crate::tasks::now_millis())
            .is_err()
    {
        state.warning = Some(WRITE_WARNING.into());
    }
}

#[tauri::command]
pub fn get_diagnostics_warning() -> Option<String> {
    STATE.get().and_then(|state| match state.lock() {
        Ok(state) => state.warning.clone(),
        Err(_) => Some(WRITE_WARNING.into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("taskmaster-logs-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            Self(directory)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn writes_structured_records_without_user_content() {
        let temp = Temp::new();
        let log = LocalLog {
            directory: temp.0.clone(),
            max_bytes: MAX_BYTES,
        };
        log.write_at(Event::StorageError, Some("storage_error"), 123)
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(temp.0.join("diagnostics.jsonl")).unwrap())
                .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"timestamp":123,"event":"storage_error","code":"storage_error"})
        );
    }
    #[test]
    fn rotates_only_owned_logs_and_bounds_retention() {
        let temp = Temp::new();
        fs::write(temp.0.join("keep.txt"), "unchanged").unwrap();
        let log = LocalLog {
            directory: temp.0.clone(),
            max_bytes: 100,
        };
        for now in 0..12 {
            log.write_at(Event::AppStarted, None, now).unwrap();
        }
        let files: Vec<_> = fs::read_dir(&temp.0)
            .unwrap()
            .map(|v| v.unwrap().path())
            .collect();
        assert_eq!(files.len(), ARCHIVES + 2);
        assert_eq!(
            fs::read_to_string(temp.0.join("keep.txt")).unwrap(),
            "unchanged"
        );
        for name in [
            "diagnostics.jsonl",
            "diagnostics.1.jsonl",
            "diagnostics.2.jsonl",
            "diagnostics.3.jsonl",
        ] {
            let content = fs::read_to_string(temp.0.join(name)).unwrap();
            assert!(content.len() <= 100);
            for line in content.lines() {
                let _: serde_json::Value = serde_json::from_str(line).unwrap();
            }
        }
    }
    #[test]
    fn reports_write_failure_without_touching_other_files() {
        let temp = Temp::new();
        let path = temp.0.join("not-a-directory");
        fs::write(&path, "keep").unwrap();
        let log = LocalLog {
            directory: path.clone(),
            max_bytes: MAX_BYTES,
        };
        assert!(log.write_at(Event::AppStarted, None, 0).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "keep");
    }
}
