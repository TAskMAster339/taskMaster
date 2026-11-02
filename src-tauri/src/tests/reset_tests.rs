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
    let store =
        crate::persistence::store::TaskStore::open(data.join("taskmaster.sqlite3")).unwrap();
    assert!(store.list_tasks().unwrap().is_empty());
    assert!(store.list_timers_at(0).unwrap().is_empty());
    assert_eq!(store.preferences().unwrap().reminder_minutes, 15);
    assert_eq!(
        store.shortcuts().unwrap(),
        crate::domain::shortcuts::defaults()
    );
    assert_eq!(
        crate::platform::presentation::read(&data.join("display-settings.json")).unwrap(),
        crate::platform::presentation::Settings::default()
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
