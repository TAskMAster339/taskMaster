use crate::app::error::AppError;
use crate::app::state::{AppState, PermanentDeletionState, with_store};
use crate::domain::models::Task;
use crate::persistence::deletions;
use crate::platform::{desktop, reset};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermanentDeletionPreview {
    token: String,
    #[serde(flatten)]
    summary: deletions::PurgeSummary,
}

#[tauri::command]
pub(crate) fn prepare_permanent_deletion(
    id: String,
    state: State<'_, AppState>,
    pending: State<'_, PermanentDeletionState>,
) -> Result<PermanentDeletionPreview, AppError> {
    let summary = with_store(&state, |store| store.prepare_permanent_deletion(&id))?;
    let token = uuid::Uuid::new_v4().to_string();
    *pending.0.lock().map_err(|_| AppError::lock())? = Some((token.clone(), summary.clone()));
    Ok(PermanentDeletionPreview { token, summary })
}

#[tauri::command]
pub(crate) fn cancel_permanent_deletion(
    token: String,
    pending: State<'_, PermanentDeletionState>,
) -> Result<(), AppError> {
    let mut current = pending.0.lock().map_err(|_| AppError::lock())?;
    if current.as_ref().is_some_and(|(value, _)| value == &token) {
        *current = None;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn confirm_permanent_deletion(
    token: String,
    state: State<'_, AppState>,
    pending: State<'_, PermanentDeletionState>,
    app: AppHandle,
) -> Result<(), AppError> {
    let mut current = pending.0.lock().map_err(|_| AppError::lock())?;
    if !current.as_ref().is_some_and(|(value, _)| value == &token) {
        return Err(AppError::invalid_state());
    }
    let (_, expected) = current.take().ok_or_else(AppError::invalid_state)?;
    with_store(&state, |store| store.permanently_delete_task(&expected))?;
    let _ = app.emit("tasks-changed", ());
    Ok(())
}

#[tauri::command]
pub(crate) fn clear_user_data(
    mode: deletions::ClearMode,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), AppError> {
    if matches!(mode, deletions::ClearMode::AllData) {
        // Disable the OS registration before scheduling destructive cleanup. On failure
        // the request is not created and the app can still show an actionable error.
        desktop::set_autostart_enabled(false, app.clone())?;
        reset::request(&app.path().app_data_dir().map_err(|_| AppError::storage())?).map_err(
            |_| AppError {
                code: "reset_error",
                message:
                    "Не удалось подготовить полный сброс. Данные не удалены. Повторите попытку."
                        .into(),
            },
        )?;
        app.request_restart();
        return Ok(());
    }
    with_store(&state, |store| store.clear_data(mode))?;
    let _ = app.emit("data-cleared", mode);
    let _ = app.emit("tasks-changed", ());
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_task(
    id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<deletions::UndoDeletion, AppError> {
    let undo = with_store(&state, |store| {
        store.delete_task_at(&id, crate::persistence::common::now_millis())
    })?;
    let _ = app.emit("tasks-changed", ());
    Ok(undo)
}

#[tauri::command]
pub(crate) fn undo_task_deletion(
    token: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Task, AppError> {
    let task = with_store(&state, |store| {
        store.undo_task_deletion_at(&token, crate::persistence::common::now_millis())
    })?;
    let _ = app.emit("tasks-changed", ());
    Ok(task)
}

#[tauri::command]
pub(crate) fn list_deletion_undos(
    state: State<'_, AppState>,
) -> Result<Vec<deletions::UndoDeletion>, AppError> {
    with_store(&state, |store| {
        store.list_deletion_undos(crate::persistence::common::now_millis())
    })
}
