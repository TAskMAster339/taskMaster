use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Permission {
    Enabled,
    DisabledForApplication,
    DisabledForUser,
    DisabledByPolicy,
    Unavailable,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationStatus {
    state: Permission,
    message: String,
    can_test: bool,
    uses_system_identity: bool,
}

// Windows.UI.Notifications.NotificationSetting, documented by Microsoft.
fn status_for_setting(setting: Option<i32>, uses_system_identity: bool) -> NotificationStatus {
    let (state, message, can_test) = match setting {
        Some(0) => (
            Permission::Enabled,
            "Уведомления разрешены в Windows.",
            true,
        ),
        Some(1) => (
            Permission::DisabledForApplication,
            "Уведомления приложения отключены в Windows.",
            false,
        ),
        Some(2) => (
            Permission::DisabledForUser,
            "Уведомления отключены для текущего пользователя Windows.",
            false,
        ),
        Some(3) => (
            Permission::DisabledByPolicy,
            "Уведомления отключены политикой Windows.",
            false,
        ),
        Some(4) => (
            Permission::Unavailable,
            "Windows не распознаёт эту сборку для уведомлений. Запустите установленную версию taskMaster.",
            false,
        ),
        _ => (
            Permission::Unknown,
            "Не удалось определить состояние уведомлений Windows.",
            true,
        ),
    };
    NotificationStatus {
        state,
        message: message.into(),
        can_test,
        uses_system_identity,
    }
}

#[cfg(any(windows, test))]
fn notification_identity(executable: &std::path::Path, identifier: &str) -> (String, bool) {
    // Match tauri-plugin-notification 2.8.0 and tauri-winrt-notification 0.8.1.
    let system = executable.parent().is_some_and(|parent| {
        parent.ends_with(std::path::Path::new("target").join("debug"))
            || parent.ends_with(std::path::Path::new("target").join("release"))
    });
    let id = if system {
        r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    } else {
        identifier
    };
    (id.into(), system)
}

fn query_status(app: &tauri::AppHandle) -> NotificationStatus {
    #[cfg(windows)]
    {
        use windows::{UI::Notifications::ToastNotificationManager, core::HSTRING};
        let Ok(executable) = std::env::current_exe() else {
            return status_for_setting(None, false);
        };
        let (identifier, system) = notification_identity(&executable, &app.config().identifier);
        let setting =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(identifier))
                .and_then(|notifier| notifier.Setting())
                .ok()
                .map(|value| value.0);
        status_for_setting(setting, system)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        status_for_setting(None, false)
    }
}

pub fn delivery_error() -> crate::app::error::AppError {
    crate::app::error::AppError {
        code: "notification_error",
        message:
            "Не удалось отправить уведомление. Проверьте Параметры Windows → Система → Уведомления."
                .into(),
    }
}

pub fn ensure_available(app: &tauri::AppHandle) -> Result<(), crate::app::error::AppError> {
    let status = query_status(app);
    if status.can_test {
        Ok(())
    } else {
        Err(crate::app::error::AppError {
            code: "notifications_blocked",
            message: status.message,
        })
    }
}

pub async fn get_notification_status(
    app: tauri::AppHandle,
) -> Result<NotificationStatus, crate::app::error::AppError> {
    tauri::async_runtime::spawn_blocking(move || query_status(&app))
        .await
        .map_err(|_| delivery_error())
}

pub async fn send_test_notification(
    app: tauri::AppHandle,
) -> Result<(), crate::app::error::AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_notification::NotificationExt;
        ensure_available(&app)?;
        app.notification()
            .builder()
            .title("taskMaster")
            .body(crate::platform::presentation::text(
                "Проверка уведомлений taskMaster.",
            ))
            .show()
            .map_err(|_| delivery_error())
    })
    .await
    .map_err(|_| delivery_error())?
}

pub fn open_notification_settings() -> Result<(), crate::app::error::AppError> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:notifications")
            .spawn()
            .map_err(|_| delivery_error())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(delivery_error())
    }
}

#[cfg(test)]
#[path = "../tests/notifications_tests.rs"]
mod tests;
