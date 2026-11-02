use serde::Serialize;
use std::io::{self, Write};
use std::{
    fs,
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
            .write_at(event, code, crate::persistence::common::now_millis())
            .is_err()
    {
        state.warning = Some(WRITE_WARNING.into());
    }
}

pub fn get_diagnostics_warning() -> Option<String> {
    STATE.get().and_then(|state| match state.lock() {
        Ok(state) => state.warning.clone(),
        Err(_) => Some(WRITE_WARNING.into()),
    })
}

#[cfg(test)]
#[path = "../tests/diagnostics_tests.rs"]
mod tests;
