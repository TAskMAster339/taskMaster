use crate::AppError;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

fn autostart_error() -> AppError {
    AppError {
        code: "autostart_error",
        message: "Не удалось проверить или изменить автозапуск Windows. Повторите попытку.".into(),
    }
}

#[cfg(windows)]
fn registration_exists() -> Result<bool, AppError> {
    match windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .and_then(|key| key.get_value("taskMaster"))
    {
        Ok(_) => Ok(true),
        Err(error) if error.code().0 == 0x80070002_u32 as i32 => Ok(false), // ERROR_FILE_NOT_FOUND
        Err(_) => Err(autostart_error()),
    }
}

#[tauri::command]
pub fn get_autostart_enabled(app: AppHandle) -> Result<bool, AppError> {
    #[cfg(windows)]
    if !registration_exists()? {
        return Ok(false);
    }
    app.autolaunch().is_enabled().map_err(|_| autostart_error())
}

#[tauri::command]
pub fn set_autostart_enabled(enabled: bool, app: AppHandle) -> Result<bool, AppError> {
    let manager = app.autolaunch();
    if enabled {
        #[cfg(windows)]
        windows_registry::CURRENT_USER
            .create(r"Software\Microsoft\Windows\CurrentVersion\Run")
            .map_err(|_| autostart_error())?;
        manager.enable().map_err(|_| autostart_error())?;
        #[cfg(windows)]
        {
            // The official plugin registers per user; quote its executable path for Program Files.
            let executable = std::env::current_exe().map_err(|_| autostart_error())?;
            windows_registry::CURRENT_USER
                .create(r"Software\Microsoft\Windows\CurrentVersion\Run")
                .and_then(|key| key.set_string("taskMaster", startup_command(&executable)))
                .map_err(|_| autostart_error())?;
        }
    } else if manager.disable().is_err() {
        #[cfg(windows)]
        if registration_exists()? {
            return Err(autostart_error());
        }
        #[cfg(not(windows))]
        return Err(autostart_error());
    }
    let actual = get_autostart_enabled(app.clone())?;
    if actual != enabled {
        return Err(autostart_error());
    }
    Ok(actual)
}

#[cfg(any(windows, test))]
fn startup_command(executable: &std::path::Path) -> String {
    format!("\"{}\"", executable.display())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_command_quotes_paths_with_spaces() {
        assert_eq!(
            startup_command(std::path::Path::new(
                r"C:\Program Files\taskMaster\taskmaster.exe"
            )),
            r#""C:\Program Files\taskMaster\taskmaster.exe""#
        );
    }
}

fn link_error() -> AppError {
    AppError {
        code: "link_error",
        message: "Не удалось открыть ссылку в браузере Windows.".into(),
    }
}
fn validate_about_url(url: &str) -> Result<(), AppError> {
    if [
        "https://taskmaster339.github.io/",
        "https://github.com/TAskMAster339/taskMaster",
    ]
    .contains(&url)
    {
        Ok(())
    } else {
        Err(link_error())
    }
}
#[tauri::command]
pub fn open_about_link(url: String) -> Result<(), AppError> {
    validate_about_url(&url)?;
    #[cfg(windows)]
    {
        use windows::{
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
            core::{PCWSTR, w},
        };
        let wide: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        // Only fixed HTTPS addresses reach ShellExecute; no shell or command arguments.
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err(link_error())
        }
    }
    #[cfg(not(windows))]
    {
        Err(link_error())
    }
}
#[cfg(test)]
mod about_tests {
    use super::*;
    #[test]
    fn about_links_allow_only_exact_public_addresses() {
        for url in [
            "https://taskmaster339.github.io/",
            "https://github.com/TAskMAster339/taskMaster",
        ] {
            assert!(validate_about_url(url).is_ok());
        }
        for url in [
            "https://evil.example/",
            "file:///C:/Windows",
            "javascript:alert(1)",
            "https://taskmaster339.github.io/?token=secret",
            "https://github.com/TAskMAster339/taskMaster/other",
        ] {
            assert!(validate_about_url(url).is_err(), "{url}");
        }
    }
}
