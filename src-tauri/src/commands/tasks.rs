use crate::app::error::AppError;
use crate::app::state::{AppState, with_store};
use crate::domain::models::{HistoryDay, Task};
use crate::persistence::store::TaskStore;
use tauri::State;

#[tauri::command]
pub(crate) fn list_tasks(state: State<'_, AppState>) -> Result<Vec<Task>, AppError> {
    with_store(&state, TaskStore::list_tasks)
}

#[tauri::command]
pub(crate) fn create_task(title: String, state: State<'_, AppState>) -> Result<Task, AppError> {
    with_store(&state, |store| store.create_task(&title))
}

#[tauri::command]
pub(crate) fn rename_task(
    id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_store(&state, |store| store.rename_task(&id, &title))
}

#[tauri::command]
pub(crate) fn reorder_tasks(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.reorder_tasks(&ids))
}

#[tauri::command]
pub(crate) fn complete_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.complete_task(&id))
}

#[tauri::command]
pub(crate) fn reopen_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.reopen_task(&id))
}

#[tauri::command]
pub(crate) fn archive_expired_tasks(state: State<'_, AppState>) -> Result<usize, AppError> {
    with_store(&state, |store| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        store.archive_expired_tasks(now)
    })
}

#[tauri::command]
pub(crate) fn list_history_for_range(
    start: i64,
    end: i64,
    state: State<'_, AppState>,
) -> Result<HistoryDay, AppError> {
    with_store(&state, |store| store.list_history_for_range(start, end))
}

#[tauri::command]
pub(crate) fn list_task_creation_times(
    start: i64,
    end: i64,
    state: State<'_, AppState>,
) -> Result<Vec<i64>, AppError> {
    with_store(&state, |store| store.list_task_creation_times(start, end))
}

#[tauri::command]
pub(crate) fn restore_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.restore_task(&id))
}

#[tauri::command]
pub(crate) fn set_task_reminder(
    id: String,
    reminder_at: i64,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_store(&state, |store| store.set_reminder(&id, reminder_at))
}

#[tauri::command]
pub(crate) fn clear_task_reminder(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.clear_reminder(&id))
}
