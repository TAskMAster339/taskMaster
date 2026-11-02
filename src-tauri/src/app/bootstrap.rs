use crate::app::error::AppError;
use crate::app::lifecycle::register_window_events;
use crate::app::runtime::{register_notification_actions, start_reminder_scheduler};
use crate::app::state::{AppState, BackupState, OverlayState, PermanentDeletionState, with_store};
use crate::domain::shortcuts;
use crate::persistence::backups as storage;
use crate::persistence::overlay::read_overlay_settings;
use crate::persistence::store::TaskStore;
use crate::platform::tray::{localized_tray_menu, setup_tray};
use crate::platform::{diagnostics, presentation, reset};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager, WebviewWindowBuilder};

pub(crate) fn open_store(path: PathBuf) -> Result<TaskStore, AppError> {
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

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let directory = app.path().app_data_dir()?;
    // No WebView, SQLite handle or diagnostic log may be open during cleanup.
    let reset_completed = match reset::execute_pending(
        &app.config().identifier,
        &directory,
        &app.path().app_local_data_dir()?,
        &app.path().app_cache_dir()?,
    ) {
        Ok(completed) => completed,
        Err(error) => {
            use tauri_plugin_dialog::DialogExt;
            eprintln!("Factory reset failed: {error}");
            let handle = app.handle().clone();
            app.dialog().message(presentation::text("Полный сброс не завершён. Закройте другие экземпляры приложения, проверьте доступ к папкам данных и запустите taskMaster снова."))
                        .title("taskMaster").show(move |_| handle.exit(1));
            return Ok(());
        }
    };
    fs::create_dir_all(&directory)?;
    diagnostics::initialize(&directory.join("logs"));
    presentation::initialize(app.handle(), &directory);
    let store = open_store(directory.clone());
    let warning = match &store {
        Ok(store) if !reset_completed => {
            let day: Result<String, _> =
                store
                    .connection
                    .query_row("SELECT date('now','localtime')", [], |row| row.get(0));
            day.map_err(|_| AppError::storage())
                .and_then(|day| storage::daily_backup(store, &directory.join("backups"), &day))
                .err()
                .map(|error| error.message)
        }
        Ok(_) => None,
        Err(_) => Some("Рабочая база недоступна. Восстановите данные из резервной копии.".into()),
    };
    app.manage(PermanentDeletionState::default());
    if warning.is_some() {
        diagnostics::record(diagnostics::Event::BackupWarning, None);
    }
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
    let registered = compatible && app.global_shortcut().register(shortcut.as_str()).is_ok();
    *app.state::<OverlayState>()
        .shortcut_available
        .lock()
        .map_err(|_| std::io::Error::other("overlay shortcut state lock failed"))? = registered;
    if !registered {
        diagnostics::record(diagnostics::Event::ShortcutConflict, None);
        let _ = app.emit(
            "overlay-shortcut-error",
            format!("Не удалось зарегистрировать {shortcut}."),
        );
    }
    let main_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or_else(|| std::io::Error::other("main window configuration missing"))?;
    WebviewWindowBuilder::from_config(app, main_config)?.build()?;
    start_reminder_scheduler(app.handle().clone());
    register_notification_actions(app.handle());

    let _menu = localized_tray_menu(app.handle())?;

    setup_tray(app)?;

    register_window_events(app)?;
    Ok(())
}
