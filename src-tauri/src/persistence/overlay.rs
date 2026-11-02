use crate::app::error::AppError;
use crate::app::state::OverlayState;
use crate::domain::overlay::OverlaySettings;
use std::fs;

pub(crate) fn save_overlay_settings(state: &OverlayState) -> Result<(), AppError> {
    let settings = state.settings.lock().map_err(|_| AppError::lock())?.clone();
    let temporary = state.path.with_extension("json.tmp");
    let contents = serde_json::to_vec(&settings).map_err(|_| AppError::storage())?;
    fs::write(&temporary, contents).map_err(|_| AppError::storage())?;
    fs::rename(&temporary, &state.path).map_err(|_| AppError::storage())
}

pub(crate) fn read_overlay_settings(path: &std::path::Path) -> Result<OverlaySettings, AppError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| AppError::storage()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(OverlaySettings::default())
        }
        Err(_) => Err(AppError::storage()),
    }
}
