use crate::{
    app::error::AppError,
    platform::{desktop, notifications},
};
use tauri::AppHandle;

#[tauri::command]
pub(crate) fn get_autostart_enabled(app: AppHandle) -> Result<bool, AppError> {
    desktop::get_autostart_enabled(app)
}
#[tauri::command]
pub(crate) fn set_autostart_enabled(enabled: bool, app: AppHandle) -> Result<bool, AppError> {
    desktop::set_autostart_enabled(enabled, app)
}
#[tauri::command]
pub(crate) fn open_about_link(url: String) -> Result<(), AppError> {
    desktop::open_about_link(url)
}
#[tauri::command]
pub(crate) async fn get_notification_status(
    app: AppHandle,
) -> Result<notifications::NotificationStatus, AppError> {
    notifications::get_notification_status(app).await
}
#[tauri::command]
pub(crate) async fn send_test_notification(app: AppHandle) -> Result<(), AppError> {
    notifications::send_test_notification(app).await
}
#[tauri::command]
pub(crate) fn open_notification_settings() -> Result<(), AppError> {
    notifications::open_notification_settings()
}
