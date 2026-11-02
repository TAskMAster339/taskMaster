use crate::app::error::AppError;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU8, Ordering};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    Ja,
    Ru,
    En,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub language: Language,
    pub high_contrast: bool,
}

fn settings_error(read: bool) -> AppError {
    AppError {
        code: "presentation_error",
        message: if read {
            "Не удалось прочитать настройки отображения. Исходный файл сохранён."
        } else {
            "Не удалось сохранить настройки отображения. Повторите попытку."
        }
        .into(),
    }
}

pub fn read(path: &Path) -> Result<Settings, AppError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| settings_error(true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(_) => Err(settings_error(true)),
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), AppError> {
    use std::io::Write;
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| settings_error(false))?;
    let mut file = std::fs::File::create(&temporary).map_err(|_| settings_error(false))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| settings_error(false))?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|_| settings_error(false))
}

static LANGUAGE: AtomicU8 = AtomicU8::new(0);

static CATALOG: OnceLock<serde_json::Value> = OnceLock::new();

pub fn text(key: &str) -> &str {
    let lang = match LANGUAGE.load(Ordering::Relaxed) {
        1 => "ru",
        2 => "en",
        _ => "ja",
    };
    CATALOG
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../../frontend/src/shared/messages.json"))
                .expect("bundled messages are valid")
        })
        .get(key)
        .and_then(|v| v.get(lang))
        .and_then(|v| v.as_str())
        .unwrap_or(key)
}

fn activate(language: Language) {
    LANGUAGE.store(
        match language {
            Language::Ja => 0,
            Language::Ru => 1,
            Language::En => 2,
        },
        Ordering::Relaxed,
    );
}

pub struct PresentationState {
    path: std::path::PathBuf,
    current: Mutex<Result<Settings, AppError>>,
}

pub fn initialize(app: &AppHandle, directory: &Path) {
    let path = directory.join("display-settings.json");
    let current = read(&path);
    if let Ok(settings) = &current {
        activate(settings.language);
    }
    app.manage(PresentationState {
        path,
        current: Mutex::new(current),
    });
}

pub fn get_display_settings(state: State<'_, PresentationState>) -> Result<Settings, AppError> {
    state.current.lock().map_err(|_| AppError::lock())?.clone()
}

pub fn update_display_settings(
    settings: Settings,
    state: State<'_, PresentationState>,
    app: AppHandle,
) -> Result<Settings, AppError> {
    let mut current = state.current.lock().map_err(|_| AppError::lock())?;
    // Never overwrite an unreadable settings file with defaults.
    current.as_ref().map_err(Clone::clone)?;
    save(&state.path, &settings)?;
    activate(settings.language);
    *current = Ok(settings.clone());
    let menu_error = || AppError {
        code: "tray_language_error",
        message: "Настройки сохранены, но меню трея не удалось обновить. Перезапустите приложение."
            .into(),
    };
    let menu = crate::platform::tray::localized_tray_menu(&app).map_err(|_| menu_error());
    let menu_result = menu.and_then(|menu| {
        app.tray_by_id("main-tray")
            .ok_or_else(menu_error)?
            .set_menu(Some(menu))
            .map_err(|_| menu_error())
    });
    let _ = app.emit("display-settings-changed", &settings);
    drop(current);
    menu_result?;
    Ok(settings)
}

#[cfg(test)]
#[path = "../tests/presentation_tests.rs"]
mod tests;
