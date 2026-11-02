use super::*;
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("taskmaster-logs-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        Self(directory)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn writes_structured_records_without_user_content() {
    let temp = Temp::new();
    let log = LocalLog {
        directory: temp.0.clone(),
        max_bytes: MAX_BYTES,
    };
    log.write_at(Event::StorageError, Some("storage_error"), 123)
        .unwrap();
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(temp.0.join("diagnostics.jsonl")).unwrap())
            .unwrap();
    assert_eq!(
        value,
        serde_json::json!({"timestamp":123,"event":"storage_error","code":"storage_error"})
    );
}
#[test]
fn rotates_only_owned_logs_and_bounds_retention() {
    let temp = Temp::new();
    fs::write(temp.0.join("keep.txt"), "unchanged").unwrap();
    let log = LocalLog {
        directory: temp.0.clone(),
        max_bytes: 100,
    };
    for now in 0..12 {
        log.write_at(Event::AppStarted, None, now).unwrap();
    }
    let files: Vec<_> = fs::read_dir(&temp.0)
        .unwrap()
        .map(|v| v.unwrap().path())
        .collect();
    assert_eq!(files.len(), ARCHIVES + 2);
    assert_eq!(
        fs::read_to_string(temp.0.join("keep.txt")).unwrap(),
        "unchanged"
    );
    for name in [
        "diagnostics.jsonl",
        "diagnostics.1.jsonl",
        "diagnostics.2.jsonl",
        "diagnostics.3.jsonl",
    ] {
        let content = fs::read_to_string(temp.0.join(name)).unwrap();
        assert!(content.len() <= 100);
        for line in content.lines() {
            let _: serde_json::Value = serde_json::from_str(line).unwrap();
        }
    }
}
#[test]
fn reports_write_failure_without_touching_other_files() {
    let temp = Temp::new();
    let path = temp.0.join("not-a-directory");
    fs::write(&path, "keep").unwrap();
    let log = LocalLog {
        directory: path.clone(),
        max_bytes: MAX_BYTES,
    };
    assert!(log.write_at(Event::AppStarted, None, 0).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "keep");
}
