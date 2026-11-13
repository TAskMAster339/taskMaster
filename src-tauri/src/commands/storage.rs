use crate::app::error::AppError;
use crate::app::state::{AppState, BackupState, OverlayState, with_store};
#[cfg(not(target_os = "linux"))]
use crate::domain::shortcuts;
use crate::persistence::backups as storage;
use crate::persistence::store::TaskStore;
use crate::platform::presentation;
use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupStatus {
    directory: String,
    warning: Option<String>,
    database_available: bool,
    has_daily_copy: bool,
}

#[tauri::command]
pub(crate) fn get_backup_status(app: AppHandle) -> Result<BackupStatus, AppError> {
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
pub(crate) async fn create_database_backup(app: AppHandle) -> Result<Option<String>, AppError> {
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
pub(crate) async fn prepare_database_restore(
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
pub(crate) fn cancel_database_restore(app: AppHandle) -> Result<(), AppError> {
    app.state::<BackupState>()
        .pending
        .lock()
        .map_err(|_| AppError::lock())?
        .take();
    Ok(())
}

#[tauri::command]
pub(crate) async fn confirm_database_restore(
    token: String,
    app: AppHandle,
) -> Result<String, AppError> {
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
        #[cfg(not(target_os = "linux"))]
        let restored_keys = guard.as_ref().map_err(Clone::clone)?.shortcuts()?;
        drop(guard);
        #[cfg(not(target_os = "linux"))]
        {
            let overlay = app.state::<OverlayState>();
            let global = overlay.settings.lock().map_err(|_| AppError::lock())?.shortcut.clone();
            if shortcuts::validate(&restored_keys, &global).is_err() {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let _ = app.global_shortcut().unregister(global.as_str());
                *overlay.shortcut_available.lock().map_err(|_| AppError::lock())? = false;
                *backup.warning.lock().map_err(|_| AppError::lock())? = Some("Горячая клавиша оверлея конфликтует с восстановленными сочетаниями. Измените её в настройках.".into());
            }
        }
        let _=app.emit("database-restored",());
        Ok(safety.to_string_lossy().into_owned())
    }).await.map_err(|_|storage::error("Не удалось завершить восстановление."))?
}

#[tauri::command]
pub(crate) async fn open_data_directory(app: AppHandle) -> Result<(), AppError> {
    let directory = app.state::<BackupState>().directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::platform::desktop::open_data_directory(&directory)
    })
    .await
    .map_err(|_| storage::error("Не удалось открыть папку данных."))?
}

#[tauri::command]
pub(crate) fn export_user_data(
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
    let document = serde_json::json!({ "format": "taskmaster", "formatVersion": 1, "appVersion": env!("CARGO_PKG_VERSION"), "exportedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64, "data": data, "settings": { "theme": theme, "overlay": overlay, "display": presentation::get_display_settings(app.state())? } });
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
