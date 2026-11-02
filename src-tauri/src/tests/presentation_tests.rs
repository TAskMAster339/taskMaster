use super::*;
#[test]
fn presentation_defaults_persist_and_reject_corruption() {
    let folder = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join("display.json");
    assert_eq!(read(&path).unwrap(), Settings::default());
    let next = Settings {
        language: Language::En,
        high_contrast: true,
    };
    save(&path, &next).unwrap();
    assert_eq!(read(&path).unwrap(), next);
    std::fs::write(&path, b"broken").unwrap();
    assert!(read(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"broken");
    std::fs::write(&path, br#"{"language":"xx","highContrast":false}"#).unwrap();
    assert!(read(&path).is_err());
    std::fs::remove_dir_all(folder).unwrap();
}
#[test]
fn presentation_write_failure_keeps_existing_file() {
    let folder = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join("display.json");
    std::fs::write(&path, b"original").unwrap();
    std::fs::create_dir(path.with_extension("tmp")).unwrap();
    assert!(save(&path, &Settings::default()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"original");
    std::fs::remove_dir_all(folder).unwrap();
}
