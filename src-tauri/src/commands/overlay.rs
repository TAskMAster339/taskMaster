use crate::app::error::AppError;
use crate::app::state::{AppState, OverlayState, with_store};
use crate::domain::overlay::OverlayShortcutStatus;
use crate::domain::shortcuts;
use crate::persistence::overlay::save_overlay_settings;
use crate::platform::windows::{
    overlay_timer_rows, overlay_timer_window_size, show_main_window, toggle_overlay,
};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State};

#[tauri::command]
pub(crate) fn toggle_task_overlay(app: AppHandle) -> Result<bool, AppError> {
    toggle_overlay(&app)
}

#[tauri::command]
pub(crate) fn set_overlay_pinned(
    pinned: bool,
    app: AppHandle,
    state: State<'_, OverlayState>,
) -> Result<(), AppError> {
    let previous = state.settings.lock().map_err(|_| AppError::lock())?.pinned;
    state.settings.lock().map_err(|_| AppError::lock())?.pinned = pinned;
    if save_overlay_settings(&state).is_err() {
        state.settings.lock().map_err(|_| AppError::lock())?.pinned = previous;
        return Err(AppError::storage());
    }
    if let Some(window) = app.get_webview_window("overlay")
        && window.set_always_on_top(pinned).is_err()
    {
        state.settings.lock().map_err(|_| AppError::lock())?.pinned = previous;
        let _ = save_overlay_settings(&state);
        return Err(AppError::storage());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_overlay_pinned(state: State<'_, OverlayState>) -> Result<bool, AppError> {
    Ok(state.settings.lock().map_err(|_| AppError::lock())?.pinned)
}

#[tauri::command]
pub(crate) fn get_overlay_shortcut_status(
    state: State<'_, OverlayState>,
) -> Result<OverlayShortcutStatus, AppError> {
    let settings = state.settings.lock().map_err(|_| AppError::lock())?;
    Ok(OverlayShortcutStatus {
        shortcut: settings.shortcut.clone(),
        available: *state
            .shortcut_available
            .lock()
            .map_err(|_| AppError::lock())?,
    })
}

#[tauri::command]
pub(crate) fn set_overlay_shortcut(
    shortcut: String,
    app: AppHandle,
    state: State<'_, OverlayState>,
    store: State<'_, AppState>,
) -> Result<OverlayShortcutStatus, AppError> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcut = shortcuts::normalize(&shortcut)?;
    with_store(&store, |store| {
        shortcuts::validate(&store.shortcuts()?, &shortcut)
    })?;
    let shortcut = shortcut.as_str();
    let old_shortcut = state
        .settings
        .lock()
        .map_err(|_| AppError::lock())?
        .shortcut
        .clone();
    let was_available = *state
        .shortcut_available
        .lock()
        .map_err(|_| AppError::lock())?;
    if old_shortcut != shortcut || !was_available {
        app.global_shortcut()
            .register(shortcut)
            .map_err(|_| AppError {
                code: "shortcut_unavailable",
                message: "Не удалось зарегистрировать сочетание. Выберите другое.".into(),
            })?;
        if old_shortcut != shortcut {
            let _ = app.global_shortcut().unregister(old_shortcut.as_str());
        }
    }
    {
        let mut settings = state.settings.lock().map_err(|_| AppError::lock())?;
        settings.shortcut = shortcut.to_owned();
    }
    *state
        .shortcut_available
        .lock()
        .map_err(|_| AppError::lock())? = true;
    if save_overlay_settings(&state).is_err() {
        if let Ok(mut settings) = state.settings.lock() {
            settings.shortcut = old_shortcut.clone();
        }
        if old_shortcut != shortcut {
            let _ = app.global_shortcut().unregister(shortcut);
            let _ = app.global_shortcut().register(old_shortcut.as_str());
        }
        *state
            .shortcut_available
            .lock()
            .map_err(|_| AppError::lock())? = false;
        return Err(AppError::storage());
    }
    get_overlay_shortcut_status(state)
}

#[tauri::command]
pub(crate) fn complete_overlay_task(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_store(&state, |store| store.complete_task(&id))?;
    let _ = app.emit("tasks-changed", ());
    Ok(())
}

#[tauri::command]
pub(crate) fn open_task_list(app: AppHandle) {
    show_main_window(&app);
    let _ = app.emit("overlay-open-today", ());
}

#[tauri::command]
pub(crate) fn open_overlay_timer_focus(id: String, app: AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    show_main_window(&app);
    let _ = app.emit("overlay-open-timer-focus", id);
}

#[tauri::command]
pub(crate) fn resize_overlay_for_timers(
    timer_count: usize,
    app: AppHandle,
) -> Result<usize, AppError> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(1);
    };
    let max_width = window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| {
            let position = window.outer_position().ok()?;
            let origin = monitor.position();
            let right = origin.x.saturating_add(monitor.size().width as i32);
            Some(
                (right.saturating_sub(position.x).max(360) as f64 / monitor.scale_factor())
                    .max(360.0),
            )
        })
        .unwrap_or(960.0);
    let available_height = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / m.scale_factor() - 48.0)
        .unwrap_or(1000.0);
    let (width, height) = overlay_timer_window_size(timer_count, max_width, available_height);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|_| AppError::storage())?;
    Ok(overlay_timer_rows(available_height))
}
