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
