use std::{fs, io, path::Path};

const MARKER: &str = "factory-reset.pending";
const REQUEST: &[u8] = b"taskmaster-factory-reset-v1\n";

pub fn request(directory: &Path) -> io::Result<()> {
    use io::Write;
    let path = directory.join(MARKER);
    if validate_request(&path)? {
        return Ok(());
    }
    owned_root(
        directory,
        directory
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(invalid_scope)?,
    )?;
    let temporary = directory.join(format!("factory-reset-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(REQUEST)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn invalid_scope() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid factory reset scope or request",
    )
}

fn validate_request(path: &Path) -> io::Result<bool> {
    match fs::read(path) {
        Ok(bytes) if bytes == REQUEST => Ok(true),
        Ok(_) => Err(invalid_scope()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT, including junctions
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn owned_root(path: &Path, identifier: &str) -> io::Result<Option<std::path::PathBuf>> {
    if path.file_name().and_then(|value| value.to_str()) != Some(identifier) {
        return Err(invalid_scope());
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(invalid_scope());
    }
    let resolved = path.canonicalize()?;
    if resolved
        != path
            .parent()
            .ok_or_else(invalid_scope)?
            .canonicalize()?
            .join(identifier)
    {
        return Err(invalid_scope());
    }
    Ok(Some(resolved))
}

fn remove_owned_entry(root: &Path, path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if is_link(&metadata) {
        return Err(invalid_scope());
    }
    let resolved = path.canonicalize()?;
    if resolved == root || !resolved.starts_with(root) {
        return Err(invalid_scope());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(&resolved)? {
            remove_owned_entry(root, &entry?.path())?;
        }
        fs::remove_dir(resolved)
    } else {
        fs::remove_file(resolved)
    }
}

fn transient_lock(error: &io::Error) -> bool {
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32) | Some(33)) {
        return true;
    }
    error.kind() == io::ErrorKind::PermissionDenied
}

/// Runs before SQLite, diagnostics and WebView are opened. The marker stays until
/// every owned directory is clean, so interrupted resets resume instead of silently
/// opening a partially cleared database. No paths are accepted from the frontend.
pub fn execute_pending(
    identifier: &str,
    data: &Path,
    local: &Path,
    cache: &Path,
) -> io::Result<bool> {
    let marker = data.join(MARKER);
    if !validate_request(&marker)? {
        return Ok(false);
    }
    let mut roots = Vec::new();
    for path in [data, local, cache] {
        if let Some(root) = owned_root(path, identifier)?
            && !roots.contains(&root)
        {
            roots.push(root);
        }
    }
    let marker = marker.canonicalize()?;
    for root in roots {
        for attempt in 0..=20 {
            let result = (|| {
                for entry in fs::read_dir(&root)? {
                    let path = entry?.path();
                    if path == marker {
                        continue;
                    }
                    remove_owned_entry(&root, &path)?;
                }
                Ok::<(), io::Error>(())
            })();
            match result {
                Ok(()) => break,
                Err(error) if transient_lock(&error) && attempt < 20 => {
                    // WebView2 may briefly retain file handles after the old process exits.
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(error) => return Err(error),
            }
        }
    }
    fs::remove_file(marker)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "taskmaster.reset-test";
    struct Sandbox(std::path::PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn app(&self, kind: &str) -> std::path::PathBuf {
            let path = self.0.join(kind).join(ID);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn factory_reset_removes_all_owned_data_including_backups_and_webview() {
        let sandbox = Sandbox::new();
        let data = sandbox.app("roaming");
        let local = sandbox.app("local");
        for name in [
            "taskmaster.sqlite3",
            "taskmaster.sqlite3-wal",
            "display-settings.json",
            "overlay-settings.json",
            "backups/manual.sqlite3",
            "backups/recovery/old.sqlite3",
            "logs/diagnostics.jsonl",
            "future-state/file.json",
        ] {
            let path = data.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"private").unwrap();
        }
        fs::create_dir_all(local.join("EBWebView/Default/Local Storage")).unwrap();
        fs::write(
            local.join("EBWebView/Default/Local Storage/old"),
            b"theme and cache",
        )
        .unwrap();
        let external = sandbox.0.join("manual-export.sqlite3");
        fs::write(&external, b"external").unwrap();
        request(&data).unwrap();
        assert!(execute_pending(ID, &data, &local, &local).unwrap());
        assert_eq!(fs::read_dir(&data).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&local).unwrap().count(), 0);
        assert_eq!(fs::read(external).unwrap(), b"external");
        assert!(!execute_pending(ID, &data, &local, &local).unwrap());
        let store = crate::tasks::TaskStore::open(data.join("taskmaster.sqlite3")).unwrap();
        assert!(store.list_tasks().unwrap().is_empty());
        assert!(store.list_timers_at(0).unwrap().is_empty());
        assert_eq!(store.preferences().unwrap().reminder_minutes, 15);
        assert_eq!(store.shortcuts().unwrap(), crate::shortcuts::defaults());
        assert_eq!(
            crate::presentation::read(&data.join("display-settings.json")).unwrap(),
            crate::presentation::Settings::default()
        );
    }
    #[test]
    fn no_request_or_invalid_request_never_deletes_data() {
        let sandbox = Sandbox::new();
        let data = sandbox.app("data");
        fs::write(data.join("keep"), b"keep").unwrap();
        assert!(!execute_pending(ID, &data, &data, &data).unwrap());
        fs::write(data.join(MARKER), b"invalid").unwrap();
        assert!(execute_pending(ID, &data, &data, &data).is_err());
        assert_eq!(fs::read(data.join("keep")).unwrap(), b"keep");
    }
    #[test]
    fn rejects_roots_outside_the_app_directory_before_deleting_anything() {
        let sandbox = Sandbox::new();
        let data = sandbox.app("data");
        fs::write(data.join("keep"), b"keep").unwrap();
        request(&data).unwrap();
        assert!(execute_pending(ID, &data, &sandbox.0, &data).is_err());
        assert!(data.join(MARKER).exists());
        assert!(data.join("keep").exists());
    }
    #[cfg(windows)]
    #[test]
    fn locked_file_keeps_request_for_retry_and_does_not_create_an_empty_database() {
        use std::os::windows::fs::OpenOptionsExt;
        let sandbox = Sandbox::new();
        let data = sandbox.app("data");
        fs::write(data.join("taskmaster.sqlite3"), b"original").unwrap();
        request(&data).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(data.join("taskmaster.sqlite3"))
            .unwrap();
        assert!(execute_pending(ID, &data, &data, &data).is_err());
        assert!(data.join(MARKER).exists());
        drop(locked);
        assert_eq!(
            fs::read(data.join("taskmaster.sqlite3")).unwrap(),
            b"original"
        );
        assert!(execute_pending(ID, &data, &data, &data).unwrap());
    }
}
