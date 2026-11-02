use crate::app::error::AppError;
use crate::app::state::OverlayState;
use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

pub(crate) fn clamp_overlay_position(app: &AppHandle, x: i32, y: i32) -> (i32, i32) {
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
pub(crate) fn clamp_to_monitor(
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

pub(crate) fn overlay_timer_rows(height: f64) -> usize {
    ((height - 162.0) / 372.0).floor().max(1.0) as usize
}

pub(crate) fn overlay_timer_window_size(
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

pub(crate) fn ensure_overlay_window(app: &AppHandle) -> Result<WebviewWindow, AppError> {
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

pub(crate) fn toggle_overlay(app: &AppHandle) -> Result<bool, AppError> {
    let window = ensure_overlay_window(app)?;
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|_| AppError::storage())?;
        Ok(false)
    } else {
        window.show().map_err(|_| AppError::storage())?;
        Ok(true)
    }
}
