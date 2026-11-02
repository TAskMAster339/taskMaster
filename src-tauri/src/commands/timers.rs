use crate::app::error::AppError;
use crate::app::state::{AppState, with_store};
use crate::domain::models::Timer;
use crate::persistence::store::TaskStore;
use tauri::State;

#[tauri::command]
pub(crate) fn list_timers(state: State<'_, AppState>) -> Result<Vec<Timer>, AppError> {
    with_store(&state, TaskStore::list_timers)
}

#[tauri::command]
pub(crate) fn create_timer(
    name: String,
    duration_seconds: i64,
    state: State<'_, AppState>,
) -> Result<Timer, AppError> {
    with_store(&state, |store| {
        store.create_timer(
            &name,
            duration_seconds,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        )
    })
}

#[tauri::command]
pub(crate) fn start_timer(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.start_timer(&id))
}

#[tauri::command]
pub(crate) fn pause_timer(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.pause_timer(&id))
}

#[tauri::command]
pub(crate) fn reset_timer(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.reset_timer(&id))
}

#[tauri::command]
pub(crate) fn delete_timer(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.delete_timer(&id))
}
