use crate::platform::windows::{show_main_window, toggle_main_window, toggle_overlay};
use crate::platform::{diagnostics, presentation};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

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
    TrayIconBuilder::with_id("main-tray")
        .icon(
            app.default_window_icon()
                .expect("default window icon is configured")
                .clone(),
        )
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "hide" => {
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
