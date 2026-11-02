mod desktop;
mod shortcuts;
mod storage;
mod tasks;

use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tasks::{DueReminder, HistoryDay, Task, TaskStore, Timer};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
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

struct BackupState {
    directory: PathBuf,
    warning: Mutex<Option<String>>,
    pending: Mutex<Option<storage::Prepared>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupStatus {
    directory: String,
    warning: Option<String>,
    database_available: bool,
    has_daily_copy: bool,
}

#[tauri::command]
fn get_backup_status(app: AppHandle) -> Result<BackupStatus, AppError> {
    let backup = app.state::<BackupState>();
    let state = app.state::<AppState>();
    let warning = backup.warning.lock().map_err(|_| AppError::lock())?.clone();
    let database_available = state.store.lock().map_err(|_| AppError::lock())?.is_ok();
    let has_daily_copy = !storage::daily_files(&backup.directory.join("backups"))?.is_empty();
    Ok(BackupStatus {
        directory: backup.directory.to_string_lossy().into_owned(),
        warning,
        database_available,
        has_daily_copy,
    })
}

#[tauri::command]
async fn create_database_backup(app: AppHandle) -> Result<Option<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file();
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let Some(file) = dialog
            .add_filter("SQLite", &["sqlite3", "db"])
            .set_file_name("taskMaster.sqlite3")
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|_| storage::error("Выберите локальный файл."))?;
        with_store(&app.state::<AppState>(), |store| {
            storage::snapshot(&store.connection, &path)
        })?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| storage::error("Не удалось завершить создание копии."))?
}

#[tauri::command]
async fn prepare_database_restore(
    latest: bool,
    app: AppHandle,
) -> Result<Option<storage::Preview>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let backup = app.state::<BackupState>();
        let copies = backup.directory.join("backups");
        backup.pending.lock().map_err(|_| AppError::lock())?.take();
        let candidate = if latest {
            let mut selected = None;
            for file in storage::daily_files(&copies)? {
                if let Ok(prepared) = storage::prepare(&file, &copies) {
                    selected = Some(prepared);
                    break;
                }
            }
            selected.ok_or_else(|| {
                storage::error("Нет исправных ежедневных копий. Выберите файл вручную.")
            })?
        } else {
            let mut dialog = app.dialog().file();
            if let Some(window) = app.get_webview_window("main") {
                dialog = dialog.set_parent(&window);
            }
            let Some(file) = dialog
                .add_filter("SQLite", &["sqlite3", "db"])
                .set_directory(&copies)
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            let path = file
                .into_path()
                .map_err(|_| storage::error("Выберите локальный файл."))?;
            storage::prepare(&path, &copies)?
        };
        let preview = candidate.preview.clone();
        *backup.pending.lock().map_err(|_| AppError::lock())? = Some(candidate);
        Ok(Some(preview))
    })
    .await
    .map_err(|_| storage::error("Не удалось проверить копию."))?
}

#[tauri::command]
fn cancel_database_restore(app: AppHandle) -> Result<(), AppError> {
    app.state::<BackupState>()
        .pending
        .lock()
        .map_err(|_| AppError::lock())?
        .take();
    Ok(())
}

#[tauri::command]
async fn confirm_database_restore(token: String, app: AppHandle) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let backup=app.state::<BackupState>();
        let mut pending=backup.pending.lock().map_err(|_|AppError::lock())?;
        if pending.as_ref().is_none_or(|p|p.preview.token!=token) { return Err(storage::error("Проверка копии устарела. Выберите файл повторно.")); }
        let candidate=pending.take().ok_or_else(AppError::lock)?; drop(pending);
        let state=app.state::<AppState>();
        let mut guard=state.store.lock().map_err(|_|AppError::lock())?;
        let copies=backup.directory.join("backups");
        let safety=match guard.as_mut() {
            Ok(store)=>storage::restore_live(store,&candidate,&copies)?,
            Err(_)=> { let (store,safety)=storage::recover_unreadable(&backup.directory.join("taskmaster.sqlite3"),&candidate,&copies)?; *guard=Ok(store); safety }
        };
        *backup.warning.lock().map_err(|_| AppError::lock())?=None;
        // Missed reminders remain diagnostic events; restoring must not deliver old alerts.
        if let Ok(store)=guard.as_ref() {
            let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
            if store.mark_missed_reminders(now).and_then(|_|store.clear_non_active_reminders(now)).is_err() {
                *backup.warning.lock().map_err(|_|AppError::lock())?=Some("Данные восстановлены, но напоминания не удалось проверить. Перезапустите приложение.".into());
            }
        }
        let restored_keys=guard.as_ref().map_err(Clone::clone)?.shortcuts()?;
        drop(guard);
        let overlay=app.state::<OverlayState>();
        let global=overlay.settings.lock().map_err(|_|AppError::lock())?.shortcut.clone();
        if shortcuts::validate(&restored_keys,&global).is_err() {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _=app.global_shortcut().unregister(global.as_str());
            *overlay.shortcut_available.lock().map_err(|_|AppError::lock())?=false;
            *backup.warning.lock().map_err(|_|AppError::lock())?=Some("Горячая клавиша оверлея конфликтует с восстановленными сочетаниями. Измените её в настройках.".into());
        }
        let _=app.emit("database-restored",());
        Ok(safety.to_string_lossy().into_owned())
    }).await.map_err(|_|storage::error("Не удалось завершить восстановление."))?
}

#[tauri::command]
fn open_data_directory(app: AppHandle) -> Result<(), AppError> {
    let directory = app.state::<BackupState>().directory.clone();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(directory)
            .spawn()
            .map_err(|_| storage::error("Не удалось открыть папку данных."))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = directory;
        Err(storage::error("Открытие папки поддерживается в Windows."))
    }
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
fn get_shortcuts(
    state: State<'_, AppState>,
) -> Result<std::collections::BTreeMap<String, String>, AppError> {
    with_store(&state, TaskStore::shortcuts)
}
#[tauri::command]
fn update_shortcut(
    action: String,
    combination: String,
    state: State<'_, AppState>,
    overlay: State<'_, OverlayState>,
    app: AppHandle,
) -> Result<std::collections::BTreeMap<String, String>, AppError> {
    let global = overlay
        .settings
        .lock()
        .map_err(|_| AppError::lock())?
        .shortcut
        .clone();
    let result = with_store(&state, |store| {
        store.set_shortcut(&action, &combination, &global)
    })?;
    let _ = app.emit("shortcuts-changed", &result);
    Ok(result)
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Result<tasks::Preferences, AppError> {
    with_store(&state, TaskStore::preferences)
}
#[tauri::command]
fn update_preferences(
    reminder_minutes: i64,
    archive_hours: i64,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_store(&state, |store| {
        store.set_preferences(reminder_minutes, archive_hours)
    })
}

#[tauri::command]
fn export_user_data(
    theme: String,
    app: AppHandle,
    state: State<'_, AppState>,
    overlay: State<'_, OverlayState>,
) -> Result<String, AppError> {
    use std::io::Write;
    if !["system", "dark", "light"].contains(&theme.as_str()) {
        return Err(AppError::invalid_state());
    }
    let data = with_store(&state, TaskStore::export_data)?;
    let overlay = overlay
        .settings
        .lock()
        .map_err(|_| AppError::lock())?
        .clone();
    let document = serde_json::json!({ "format": "taskmaster", "formatVersion": 1, "appVersion": env!("CARGO_PKG_VERSION"), "exportedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64, "data": data, "settings": { "theme": theme, "overlay": overlay } });
    let path = app
        .path()
        .download_dir()
        .map_err(|_| AppError::storage())?
        .join(format!("taskMaster-{}.json", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(&document).map_err(|_| AppError::storage())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| AppError {
            code: "export_error",
            message: "Не удалось создать JSON в папке загрузок.".into(),
        })?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&path);
        return Err(AppError {
            code: "export_error",
            message: "Не удалось записать JSON. Проверьте свободное место и права доступа.".into(),
        });
    }
    Ok(path.to_string_lossy().into_owned())
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
    if storage::restore_marker(&path.join("taskmaster.sqlite3")).exists() {
        return Err(storage::error(
            "Предыдущее восстановление прервано. Выберите резервную копию повторно; исходные файлы сохранены в папке данных.",
        ));
    }
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

#[expect(
    clippy::too_many_arguments,
    reason = "Monitor and window rectangles use explicit physical coordinates"
)]
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

fn overlay_timer_rows(height: f64) -> usize {
    ((height - 162.0) / 372.0).floor().max(1.0) as usize
}

fn overlay_timer_window_size(
    timer_count: usize,
    max_width: f64,
    available_height: f64,
) -> (f64, f64) {
    if timer_count == 0 {
        return (360.0, 154.0);
    }
    let rows = timer_count.min(overlay_timer_rows(available_height));
    let columns = timer_count.div_ceil(rows.max(1));
    let width = (360.0 + columns.saturating_sub(1) as f64 * 372.0).min(max_width.max(360.0));
    let height = 174.0 + rows as f64 * 360.0 + rows.saturating_sub(1) as f64 * 12.0;
    (width, height)
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
            .transparent(true)
            .shadow(false)
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

#[tauri::command]
fn open_overlay_timer_focus(id: String, app: AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    show_main_window(&app);
    let _ = app.emit("overlay-open-timer-focus", id);
}

#[tauri::command]
fn resize_overlay_for_timers(timer_count: usize, app: AppHandle) -> Result<usize, AppError> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("taskMaster")
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
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
            let directory = app.path().app_data_dir()?;
            let store = open_store(directory.clone());
            let warning = match &store {
                Ok(store) => {
                    let day: Result<String, _> =
                        store
                            .connection
                            .query_row("SELECT date('now','localtime')", [], |row| row.get(0));
                    day.map_err(|_| AppError::storage())
                        .and_then(|day| {
                            storage::daily_backup(store, &directory.join("backups"), &day)
                        })
                        .err()
                        .map(|error| error.message)
                }
                Err(_) => {
                    Some("Рабочая база недоступна. Восстановите данные из резервной копии.".into())
                }
            };
            app.manage(BackupState {
                directory,
                warning: Mutex::new(warning),
                pending: Mutex::new(None),
            });
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
            let compatible = with_store(&app.state::<AppState>(), |store| {
                shortcuts::validate(&store.shortcuts()?, &shortcut)
            })
            .is_ok();
            let registered =
                compatible && app.global_shortcut().register(shortcut.as_str()).is_ok();
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
            let overlay = MenuItemBuilder::with_id("overlay", "Оверлей").build(app)?;
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
                if let WindowEvent::Moved(position) = event
                    && let Some(state) = overlay_handle.try_state::<OverlayState>()
                    && let Ok(mut settings) = state.settings.lock()
                {
                    settings.x = position.x;
                    settings.y = position.y;
                    drop(settings);
                    if save_overlay_settings(&state).is_err() {
                        let _ = overlay_handle.emit("overlay-settings-error", ());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop::get_autostart_enabled,
            desktop::set_autostart_enabled,
            get_backup_status,
            create_database_backup,
            prepare_database_restore,
            cancel_database_restore,
            confirm_database_restore,
            open_data_directory,
            get_shortcuts,
            update_shortcut,
            get_preferences,
            update_preferences,
            export_user_data,
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
            open_overlay_timer_focus,
            resize_overlay_for_timers,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run taskMaster");
}

#[cfg(test)]
mod tests;
