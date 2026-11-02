use super::*;
#[test]
fn rejects_duplicate_and_global_conflicts() {
    let mut keys = defaults();
    assert!(validate(&keys, "Ctrl+Alt+Space").is_ok());
    keys.insert("new_task".into(), "Shift+Ctrl+N".into());
    assert!(validate(&keys, "Ctrl+Alt+Space").is_err());
    keys = defaults();
    keys.insert("new_task".into(), "Alt+Ctrl+Space".into());
    assert!(validate(&keys, "Ctrl+Alt+Space").is_err());
}
#[test]
fn validates_supported_keys_and_reserved_combinations() {
    assert_eq!(normalize(" shift + control + n ").unwrap(), "Ctrl+Shift+N");
    assert_eq!(normalize("Ctrl+,").unwrap(), "Ctrl+Comma");
    for key in [
        "",
        "N",
        "Ctrl",
        "Ctrl+Ctrl+N",
        "Alt+F4",
        "Ctrl+Alt+Delete",
        "Ctrl+Shift+Escape",
        "Ctrl+Unknown",
        "F",
    ] {
        assert!(normalize(key).is_err(), "{key}");
    }
}
