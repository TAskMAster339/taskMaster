#[cfg(not(target_os = "linux"))]
use crate::app::state::OverlayState;
use crate::app::state::{AppState, with_store};
#[cfg(not(target_os = "linux"))]
use crate::persistence::overlay::save_overlay_settings;
#[cfg(not(target_os = "linux"))]
use crate::platform::windows::ensure_overlay_window;
use tauri::{Emitter, Manager, WindowEvent};

pub(crate) fn register_window_events(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(not(target_os = "linux"))]
        let close_window = window.clone();
        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            #[cfg(target_os = "linux")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if crate::platform::tray::hide_to_tray(app.clone())
                        .await
                        .is_err()
                    {
                        use crate::platform::diagnostics::{self, Event};
                        diagnostics::record(Event::AppStopped, None);
                        app.exit(0);
                    }
                });
            }
            #[cfg(not(target_os = "linux"))]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = close_window.hide();
            }
            if matches!(event, WindowEvent::Focused(true)) {
                match with_store(&handle.state::<AppState>(), |store| {
                    store.archive_expired_tasks(crate::persistence::common::now_millis())
                }) {
                    Ok(count) if count > 0 => {
                        let _ = handle.emit("tasks-changed", ());
                    }
                    Err(_) => {
                        let _ = handle.emit("archive-runtime-error", ());
                    }
                    _ => {}
                }
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
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
    }

    Ok(())
}
