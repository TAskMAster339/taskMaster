use crate::app::error::AppError;
use crate::domain::overlay::OverlaySettings;
use crate::persistence::backups as storage;
use crate::persistence::deletions;
use crate::persistence::store::TaskStore;
use crate::platform::diagnostics;
use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

pub(crate) struct AppState {
    pub(crate) store: Mutex<Result<TaskStore, AppError>>,
}

#[derive(Default)]
pub(crate) struct PermanentDeletionState(
    pub(crate) Mutex<Option<(String, deletions::PurgeSummary)>>,
);

pub(crate) struct BackupState {
    pub(crate) directory: PathBuf,
    pub(crate) warning: Mutex<Option<String>>,
    pub(crate) pending: Mutex<Option<storage::Prepared>>,
}

pub(crate) struct OverlayState {
    pub(crate) settings: Mutex<OverlaySettings>,
    pub(crate) shortcut_available: Mutex<bool>,
    pub(crate) path: PathBuf,
}

pub(crate) fn with_store<T>(
    state: &AppState,
    action: impl FnOnce(&TaskStore) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let guard: MutexGuard<'_, Result<TaskStore, AppError>> =
        state.store.lock().map_err(|_| AppError::lock())?;
    let result = action(guard.as_ref().map_err(Clone::clone)?);
    if let Err(error) = &result {
        diagnostics::record(diagnostics::Event::CommandRejected, Some(error.code));
    }
    result
}
