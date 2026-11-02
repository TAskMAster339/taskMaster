use std::io;
use std::{fs, path::Path};

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
#[path = "../tests/reset_tests.rs"]
mod tests;
