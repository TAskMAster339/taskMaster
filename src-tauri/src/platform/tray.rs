use crate::platform::windows::{show_main_window, toggle_main_window, toggle_overlay};
use crate::platform::{diagnostics, presentation};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const TRAY_ID: &str = "main-tray";

pub(crate) fn localized_tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let mut items = Vec::new();
    for (id, key) in [
        ("show", "Показать"),
        ("hide", "Скрыть приложение"),
        ("overlay", "Оверлей"),
        ("settings", "Настройки"),
        ("quit", "Выход"),
    ] {
        items.push(MenuItemBuilder::with_id(id, presentation::text(key)).build(app)?);
    }
    let mut builder = MenuBuilder::new(app);
    for item in &items {
        builder = builder.item(item);
    }
    builder.build()
}

pub(crate) fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = localized_tray_menu(app.handle())?;
    let icon =
        app.default_window_icon()
            .ok_or(tauri::Error::InvalidIcon(std::io::Error::other(
                "default tray icon is missing",
            )))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "hide" => {
                #[cfg(target_os = "linux")]
                {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = hide_to_tray(app).await;
                    });
                }
                #[cfg(not(target_os = "linux"))]
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "settings" => {
                show_main_window(app);
                let _ = app.emit("open-settings", ());
            }
            "overlay" => {
                let _ = toggle_overlay(app);
            }
            "quit" => {
                diagnostics::record(diagnostics::Event::AppStopped, None);
                app.exit(0);
            }
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

    Ok(())
}

#[cfg(target_os = "linux")]
fn tray_host_registered() -> bool {
    let Ok(connection) = zbus::blocking::Connection::session() else {
        return false;
    };
    zbus::blocking::Proxy::new(
        &connection,
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher",
    )
    .and_then(|watcher| watcher.get_property::<bool>("IsStatusNotifierHostRegistered"))
    .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn hide_main_window(app: &AppHandle) -> Result<(), crate::app::error::AppError> {
    let error = || crate::app::error::AppError {
        code: "tray_unavailable",
        message: "Не удалось свернуть приложение в трей.".into(),
    };
    if !super::linux_launch::can_hide_to_tray(
        app.tray_by_id(TRAY_ID).is_some(),
        tray_host_registered(),
    ) {
        return Err(error());
    }
    app.get_webview_window("main")
        .ok_or_else(error)?
        .hide()
        .map_err(|_| error())
}

#[tauri::command]
pub(crate) async fn hide_to_tray(app: AppHandle) -> Result<(), crate::app::error::AppError> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || hide_main_window(&app))
            .await
            .map_err(|_| crate::app::error::AppError::invalid_state())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Err(crate::app::error::AppError::invalid_state())
    }
}
