mod tasks;

use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::Serialize;
use tasks::{DueReminder, FocusSession, HistoryDay, Task, TaskStore};
use tauri::{
    AppHandle, Emitter, Manager, State, WindowEvent,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppError {
    code: &'static str,
    message: String,
}

impl AppError {
    fn invalid_reminder_time() -> Self {
        Self {
            code: "invalid_reminder_time",
            message: "Выберите время позже текущего.".into(),
        }
    }
    fn invalid_title() -> Self {
        Self {
            code: "invalid_title",
            message: "Введите название длиной от 1 до 300 символов.".into(),
        }
    }

    fn invalid_order() -> Self {
        Self {
            code: "invalid_order",
            message: "Не удалось сохранить порядок задач. Обновите список.".into(),
        }
    }

    fn invalid_state() -> Self {
        Self {
            code: "invalid_state",
            message: "Статус задачи уже изменился. Обновите список.".into(),
        }
    }

    fn storage() -> Self {
        Self {
            code: "storage_error",
            message: "Не удалось открыть локальную базу данных.".into(),
        }
    }

    fn lock() -> Self {
        Self {
            code: "storage_error",
            message: "Хранилище задач временно недоступно.".into(),
        }
    }
}

struct AppState {
    store: Mutex<Result<TaskStore, AppError>>,
}

fn with_store<T>(
    state: &AppState,
    action: impl FnOnce(&TaskStore) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let guard: MutexGuard<'_, Result<TaskStore, AppError>> =
        state.store.lock().map_err(|_| AppError::lock())?;
    action(guard.as_ref().map_err(Clone::clone)?)
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> Result<Vec<Task>, AppError> {
    with_store(&state, TaskStore::list_tasks)
}

#[tauri::command]
fn create_task(title: String, state: State<'_, AppState>) -> Result<Task, AppError> {
    with_store(&state, |store| store.create_task(&title))
}

#[tauri::command]
fn rename_task(id: String, title: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.rename_task(&id, &title))
}

#[tauri::command]
fn reorder_tasks(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.reorder_tasks(&ids))
}

#[tauri::command]
fn complete_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.complete_task(&id))
}

#[tauri::command]
fn reopen_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.reopen_task(&id))
}

#[tauri::command]
fn archive_expired_tasks(state: State<'_, AppState>) -> Result<usize, AppError> {
    with_store(&state, |store| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        store.archive_expired_tasks(now)
    })
}

#[tauri::command]
fn list_history_for_range(
    start: i64,
    end: i64,
    state: State<'_, AppState>,
) -> Result<HistoryDay, AppError> {
    with_store(&state, |store| store.list_history_for_range(start, end))
}

#[tauri::command]
fn list_task_creation_times(
    start: i64,
    end: i64,
    state: State<'_, AppState>,
) -> Result<Vec<i64>, AppError> {
    with_store(&state, |store| store.list_task_creation_times(start, end))
}

#[tauri::command]
fn restore_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.restore_task(&id))
}

#[tauri::command]
fn set_task_reminder(
    id: String,
    reminder_at: i64,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_store(&state, |store| store.set_reminder(&id, reminder_at))
}

#[tauri::command]
fn clear_task_reminder(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.clear_reminder(&id))
}

#[tauri::command]
fn get_focus_session(state: State<'_, AppState>) -> Result<Option<FocusSession>, AppError> {
    with_store(&state, TaskStore::get_focus)
}

#[tauri::command]
fn start_focus(
    id: String,
    duration_seconds: i64,
    state: State<'_, AppState>,
) -> Result<FocusSession, AppError> {
    with_store(&state, |store| store.start_focus(&id, duration_seconds))
}

#[tauri::command]
fn pause_focus(state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |s| s.pause_focus())
}
#[tauri::command]
fn resume_focus(state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |s| s.resume_focus())
}
#[tauri::command]
fn finish_focus(state: State<'_, AppState>) -> Result<FocusSession, AppError> {
    with_store(&state, |s| s.finish_focus())
}
#[tauri::command]
fn cancel_focus(state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |s| s.cancel_focus())
}

fn open_store(path: PathBuf) -> Result<TaskStore, AppError> {
    std::fs::create_dir_all(&path).map_err(|_| AppError::storage())?;
    let store =
        TaskStore::open(path.join("taskmaster.sqlite3")).map_err(|_| AppError::storage())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    store.archive_expired_tasks(now)?;
    store.mark_missed_reminders(now)?;
    store.clear_non_active_reminders(now)?;
    store.recover_focus_at(now)?;
    Ok(store)
}

fn notify_reminder(app: &AppHandle, reminder: DueReminder) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("taskMaster")
        .body(&reminder.title)
        .extra("taskId", serde_json::Value::String(reminder.task_id))
        .show()
        .map_err(|_| app.emit("reminder-delivery-error", ()))
        .ok();
}

fn notify_focus_finished(app: &AppHandle, session: FocusSession) {
    use tauri_plugin_notification::NotificationExt;
    if app
        .notification()
        .builder()
        .title("Фокус-таймер завершён")
        .body(&session.task_title)
        .show()
        .is_err()
    {
        let _ = app.emit("focus-notification-error", ());
    }
    let _ = app.emit("focus-session-finished", session);
}

fn register_notification_actions(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let handle = app.clone();
    let _ = app.notification().on_action(move |action| {
        if action.action_id() == "tap"
            && let Some(id) = action
                .notification()
                .and_then(|n| n.extra().get("taskId"))
                .and_then(|v| v.as_str())
        {
            show_main_window(&handle);
            let _ = handle.emit("reminder-open-task", id.to_owned());
        }
    });
}

fn start_reminder_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let Ok(guard) = state.store.lock() else {
                continue;
            };
            let Ok(store) = guard.as_ref() else {
                continue;
            };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            // Give the 5-second polling window room, but treat longer gaps (including sleep)
            // as missed instead of displaying stale notifications after wake.
            if store
                .mark_missed_reminders(now.saturating_sub(30_000))
                .is_err()
            {
                let _ = app.emit("reminder-runtime-error", ());
                continue;
            }
            let reminders = match store.take_due_reminders(now) {
                Ok(reminders) => reminders,
                Err(_) => {
                    let _ = app.emit("reminder-runtime-error", ());
                    Vec::new()
                }
            };
            let finished_focus = match store.finish_expired_focus_at(now) {
                Ok(session) => session,
                Err(_) => {
                    let _ = app.emit("focus-runtime-error", ());
                    None
                }
            };
            drop(guard);
            for reminder in reminders {
                notify_reminder(&app, reminder);
            }
            if let Some(session) = finished_focus {
                notify_focus_finished(&app, session);
            }
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            let store = app
                .path()
                .app_data_dir()
                .map_err(|_| AppError::storage())
                .and_then(open_store);
            app.manage(AppState {
                store: Mutex::new(store),
            });
            start_reminder_scheduler(app.handle().clone());
            register_notification_actions(app.handle());

            let show = MenuItemBuilder::with_id("show", "Показать").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Выход").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .expect("default window icon is configured")
                        .clone(),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = close_window.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            create_task,
            rename_task,
            reorder_tasks,
            complete_task,
            reopen_task,
            archive_expired_tasks,
            list_history_for_range,
            list_task_creation_times,
            restore_task,
            set_task_reminder,
            clear_task_reminder,
            get_focus_session,
            start_focus,
            pause_focus,
            resume_focus,
            finish_focus,
            cancel_focus
        ])
        .run(tauri::generate_context!())
        .expect("failed to run taskMaster");
}

#[cfg(test)]
mod tests;
