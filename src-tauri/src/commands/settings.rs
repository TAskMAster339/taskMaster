use crate::app::error::AppError;
use crate::app::state::{AppState, OverlayState, with_store};
use crate::persistence::store::TaskStore;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub(crate) fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub(crate) fn get_shortcuts(
    state: State<'_, AppState>,
) -> Result<std::collections::BTreeMap<String, String>, AppError> {
    with_store(&state, TaskStore::shortcuts)
}

#[tauri::command]
pub(crate) fn update_shortcut(
    action: String,
    combination: String,
    state: State<'_, AppState>,
    overlay: State<'_, OverlayState>,
    app: AppHandle,
) -> Result<std::collections::BTreeMap<String, String>, AppError> {
    #[cfg(not(target_os = "linux"))]
    let global = overlay
        .settings
        .lock()
        .map_err(|_| AppError::lock())?
        .shortcut
        .clone();
    #[cfg(target_os = "linux")]
    let global = {
        let _ = overlay;
        ""
    };
    #[cfg(not(target_os = "linux"))]
    let global = global.as_str();
    let result = with_store(&state, |store| {
        store.set_shortcut(&action, &combination, global)
    })?;
    let _ = app.emit("shortcuts-changed", &result);
    Ok(result)
}

#[tauri::command]
pub(crate) fn get_preferences(
    state: State<'_, AppState>,
) -> Result<crate::domain::models::Preferences, AppError> {
    with_store(&state, TaskStore::preferences)
}

#[tauri::command]
pub(crate) fn update_preferences(
    reminder_minutes: i64,
    archive_hours: i64,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_store(&state, |store| {
        store.set_preferences(reminder_minutes, archive_hours)
    })
}

#[tauri::command]
pub(crate) fn get_display_settings(
    state: State<'_, crate::platform::presentation::PresentationState>,
) -> Result<crate::platform::presentation::Settings, AppError> {
    crate::platform::presentation::get_display_settings(state)
}
#[tauri::command]
pub(crate) fn update_display_settings(
    settings: crate::platform::presentation::Settings,
    state: State<'_, crate::platform::presentation::PresentationState>,
    app: AppHandle,
) -> Result<crate::platform::presentation::Settings, AppError> {
    crate::platform::presentation::update_display_settings(settings, state, app)
}
#[tauri::command]
pub(crate) fn get_diagnostics_warning() -> Option<String> {
    crate::platform::diagnostics::get_diagnostics_warning()
}
