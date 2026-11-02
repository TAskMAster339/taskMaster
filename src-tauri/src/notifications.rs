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

pub fn delivery_error() -> crate::AppError {
    crate::AppError {
        code: "notification_error",
        message:
            "Не удалось отправить уведомление. Проверьте Параметры Windows → Система → Уведомления."
                .into(),
    }
}
pub fn ensure_available(app: &tauri::AppHandle) -> Result<(), crate::AppError> {
    let status = query_status(app);
    if status.can_test {
        Ok(())
    } else {
        Err(crate::AppError {
            code: "notifications_blocked",
            message: status.message,
        })
    }
}

#[tauri::command]
pub async fn get_notification_status(
    app: tauri::AppHandle,
) -> Result<NotificationStatus, crate::AppError> {
    tauri::async_runtime::spawn_blocking(move || query_status(&app))
        .await
        .map_err(|_| delivery_error())
}
#[tauri::command]
pub async fn send_test_notification(app: tauri::AppHandle) -> Result<(), crate::AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_notification::NotificationExt;
        ensure_available(&app)?;
        app.notification()
            .builder()
            .title("taskMaster")
            .body("Проверка уведомлений taskMaster.")
            .show()
            .map_err(|_| delivery_error())
    })
    .await
    .map_err(|_| delivery_error())?
}
#[tauri::command]
pub fn open_notification_settings() -> Result<(), crate::AppError> {
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
mod tests {
    use super::*;
    #[test]
    fn windows_blocks_are_not_reported_as_permission_granted() {
        for code in 1..=4 {
            let state = status_for_setting(Some(code), false);
            assert_ne!(state.state, Permission::Enabled);
            assert!(!state.can_test);
        }
        assert!(status_for_setting(Some(0), false).can_test);
    }
    #[test]
    fn failed_or_unknown_check_never_claims_permission_granted() {
        for setting in [None, Some(99)] {
            let state = status_for_setting(setting, false);
            assert_eq!(state.state, Permission::Unknown);
            assert!(state.can_test);
        }
    }
    #[test]
    fn notification_identity_matches_the_actual_delivery_identity() {
        let target = std::path::Path::new("workspace").join("target");
        for profile in ["debug", "release"] {
            let (id, system) = notification_identity(
                &target.join(profile).join("taskmaster.exe"),
                "ru.taskmaster.desktop",
            );
            assert!(system);
            assert!(id.ends_with(r"WindowsPowerShell\v1.0\powershell.exe"));
        }
        let (id, system) = notification_identity(
            &std::path::Path::new("Program Files")
                .join("taskMaster")
                .join("taskmaster.exe"),
            "ru.taskmaster.desktop",
        );
        assert!(!system);
        assert_eq!(id, "ru.taskmaster.desktop");
    }
}
