mod tasks;

use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tasks::{DueReminder, HistoryDay, Task, TaskStore, Timer};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
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

    fn invalid_timer() -> Self {
        Self {
            code: "invalid_timer",
            message: "Укажите название и длительность от 1 секунды до 99 часов 59 минут 59 секунд."
                .into(),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlaySettings {
    x: i32,
    y: i32,
    pinned: bool,
    #[serde(default = "default_overlay_shortcut")]
    shortcut: String,
}

fn default_overlay_shortcut() -> String {
    "Ctrl+Alt+Space".into()
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            x: 24,
            y: 24,
            pinned: false,
            shortcut: default_overlay_shortcut(),
        }
    }
}

struct OverlayState {
    settings: Mutex<OverlaySettings>,
    shortcut_available: Mutex<bool>,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayShortcutStatus {
    shortcut: String,
    available: bool,
}

fn save_overlay_settings(state: &OverlayState) -> Result<(), AppError> {
    let settings = state.settings.lock().map_err(|_| AppError::lock())?.clone();
    let temporary = state.path.with_extension("json.tmp");
    let contents = serde_json::to_vec(&settings).map_err(|_| AppError::storage())?;
    fs::write(&temporary, contents).map_err(|_| AppError::storage())?;
    fs::rename(&temporary, &state.path).map_err(|_| AppError::storage())
}

fn read_overlay_settings(path: &std::path::Path) -> Result<OverlaySettings, AppError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| AppError::storage()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(OverlaySettings::default())
        }
        Err(_) => Err(AppError::storage()),
    }
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
fn list_timers(state: State<'_, AppState>) -> Result<Vec<Timer>, AppError> {
    with_store(&state, TaskStore::list_timers)
}
#[tauri::command]
fn create_timer(
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
fn start_timer(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.start_timer(&id))
}
#[tauri::command]
fn pause_timer(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.pause_timer(&id))
}
#[tauri::command]
fn reset_timer(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.reset_timer(&id))
}
#[tauri::command]
fn delete_timer(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.delete_timer(&id))
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

fn notify_timer_finished(app: &AppHandle, timer: Timer) {
    use tauri_plugin_notification::NotificationExt;
    if app
        .notification()
        .builder()
        .title("Таймер завершён")
        .body(&timer.name)
        .show()
        .is_err()
    {
        let _ = app.emit("timer-notification-error", ());
    }
    let _ = app.emit("timer-finished", timer);
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
            let finished_timers = match store.take_due_timers() {
                Ok(timers) => timers,
                Err(_) => {
                    let _ = app.emit("timer-runtime-error", ());
                    Vec::new()
                }
            };
            drop(guard);
            for reminder in reminders {
                notify_reminder(&app, reminder);
            }
            for timer in finished_timers {
                notify_timer_finished(&app, timer);
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

fn clamp_overlay_position(app: &AppHandle, x: i32, y: i32) -> (i32, i32) {
    let monitors = app.available_monitors().unwrap_or_default();
    for monitor in monitors {
        let origin = monitor.position();
        let size = monitor.size();
        if x >= origin.x
            && y >= origin.y
            && x < origin.x.saturating_add(size.width as i32)
            && y < origin.y.saturating_add(size.height as i32)
        {
            let scale = monitor.scale_factor();
            let width = (360.0 * scale).round() as i32;
            let height = (154.0 * scale).round() as i32;
            let (clamped_x, clamped_y) = clamp_to_monitor(
                x,
                y,
                origin.x,
                origin.y,
                size.width as i32,
                size.height as i32,
                width,
                height,
            );
            return (clamped_x, clamped_y);
        }
    }
    let monitor = app.primary_monitor().ok().flatten();
    if let Some(monitor) = monitor {
        let origin = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let width = (360.0 * scale).round() as i32;
        let height = (154.0 * scale).round() as i32;
        return (
            (origin.x + size.width as i32 - width - (24.0 * scale) as i32).max(origin.x),
            (origin.y + size.height as i32 - height - (24.0 * scale) as i32).max(origin.y),
        );
    }
    (24, 24)
}

fn clamp_to_monitor(
    x: i32,
    y: i32,
    left: i32,
    top: i32,
    monitor_width: i32,
    monitor_height: i32,
    window_width: i32,
    window_height: i32,
) -> (i32, i32) {
    (
        x.clamp(left, (left + monitor_width - window_width).max(left)),
        y.clamp(top, (top + monitor_height - window_height).max(top)),
    )
}

fn ensure_overlay_window(app: &AppHandle) -> Result<WebviewWindow, AppError> {
    if let Some(window) = app.get_webview_window("overlay") {
        return Ok(window);
    }
    let settings_state = app.try_state::<OverlayState>().ok_or_else(AppError::lock)?;
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| AppError::lock())?
        .clone();
    let (x, y) = clamp_overlay_position(app, settings.x, settings.y);
    let window =
        WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html?overlay".into()))
            .title("Следующая задача")
            .inner_size(360.0, 154.0)
            .position(24.0, 24.0)
            .decorations(false)
            .resizable(false)
            .focused(false)
            .visible(false)
            .always_on_top(settings.pinned)
            .build()
            .map_err(|_| AppError::storage())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|_| AppError::storage())?;
    Ok(window)
}

fn toggle_overlay(app: &AppHandle) -> Result<bool, AppError> {
    let window = ensure_overlay_window(app)?;
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|_| AppError::storage())?;
        Ok(false)
    } else {
        window.show().map_err(|_| AppError::storage())?;
        Ok(true)
    }
}

#[tauri::command]
fn toggle_task_overlay(app: AppHandle) -> Result<bool, AppError> {
    toggle_overlay(&app)
}

#[tauri::command]
fn set_overlay_pinned(
    pinned: bool,
    app: AppHandle,
    state: State<'_, OverlayState>,
) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window("overlay") {
        window
            .set_always_on_top(pinned)
            .map_err(|_| AppError::storage())?;
    }
    state.settings.lock().map_err(|_| AppError::lock())?.pinned = pinned;
    save_overlay_settings(&state)
}

#[tauri::command]
fn get_overlay_pinned(state: State<'_, OverlayState>) -> Result<bool, AppError> {
    Ok(state.settings.lock().map_err(|_| AppError::lock())?.pinned)
}

#[tauri::command]
fn get_overlay_shortcut_status(
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
fn set_overlay_shortcut(
    shortcut: String,
    app: AppHandle,
    state: State<'_, OverlayState>,
) -> Result<OverlayShortcutStatus, AppError> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcut = shortcut.trim();
    if shortcut.is_empty() || !shortcut.contains('+') {
        return Err(AppError {
            code: "invalid_shortcut",
            message: "Укажите сочетание клавиш, например Ctrl+Shift+O.".into(),
        });
    }
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
fn complete_overlay_task(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_store(&state, |store| store.complete_task(&id))?;
    let _ = app.emit("tasks-changed", ());
    Ok(())
}

#[tauri::command]
fn open_task_list(app: AppHandle) {
    show_main_window(&app);
    let _ = app.emit("overlay-open-today", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() == ShortcutState::Pressed {
                        let _ = toggle_overlay(app);
                    }
                })
                .build(),
        )
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
            let settings_path = app.path().app_data_dir()?.join("overlay-settings.json");
            if let Some(parent) = settings_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let overlay_settings = read_overlay_settings(&settings_path)
                .map_err(|_| std::io::Error::other("overlay settings could not be read"))?;
            app.manage(OverlayState {
                settings: Mutex::new(overlay_settings),
                shortcut_available: Mutex::new(false),
                path: settings_path,
            });
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let shortcut = app
                .state::<OverlayState>()
                .settings
                .lock()
                .map_err(|_| std::io::Error::other("overlay settings lock failed"))?
                .shortcut
                .clone();
            let registered = app.global_shortcut().register(shortcut.as_str()).is_ok();
            *app.state::<OverlayState>()
                .shortcut_available
                .lock()
                .map_err(|_| std::io::Error::other("overlay shortcut state lock failed"))? =
                registered;
            if !registered {
                let _ = app.emit(
                    "overlay-shortcut-error",
                    format!("Не удалось зарегистрировать {shortcut}."),
                );
            }
            start_reminder_scheduler(app.handle().clone());
            register_notification_actions(app.handle());

            let show = MenuItemBuilder::with_id("show", "Показать").build(app)?;
            let overlay =
                MenuItemBuilder::with_id("overlay", "Показать/скрыть оверлей").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Выход").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show, &overlay, &quit])
                .build()?;

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
                    "overlay" => {
                        let _ = toggle_overlay(app);
                    }
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
            let overlay_window = ensure_overlay_window(app.handle())
                .map_err(|_| std::io::Error::other("overlay window could not be created"))?;
            let overlay_handle = app.handle().clone();
            overlay_window.on_window_event(move |event| {
                if let WindowEvent::Moved(position) = event {
                    if let Some(state) = overlay_handle.try_state::<OverlayState>() {
                        if let Ok(mut settings) = state.settings.lock() {
                            settings.x = position.x;
                            settings.y = position.y;
                            drop(settings);
                            if save_overlay_settings(&state).is_err() {
                                let _ = overlay_handle.emit("overlay-settings-error", ());
                            }
                        }
                    }
                }
            });
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
            list_timers,
            create_timer,
            start_timer,
            pause_timer,
            reset_timer,
            delete_timer,
            toggle_task_overlay,
            set_overlay_pinned,
            get_overlay_pinned,
            get_overlay_shortcut_status,
            set_overlay_shortcut,
            complete_overlay_task,
            open_task_list,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run taskMaster");
}

#[cfg(test)]
mod tests;
