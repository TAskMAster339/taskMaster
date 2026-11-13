pub(crate) fn toggle_requested(
    args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>,
) -> bool {
    args.into_iter()
        .skip(1)
        .take_while(|arg| arg.as_ref() != "--")
        .any(|arg| arg.as_ref() == "--toggle-overlay")
}

pub(crate) fn can_hide_to_tray(icon_created: bool, host_registered: bool) -> bool {
    icon_created && host_registered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_flag_is_read_only_from_arguments() {
        assert!(!toggle_requested(["--toggle-overlay"]));
        assert!(!toggle_requested(["taskmaster", "--toggle-overlay=true"]));
        assert!(toggle_requested(["taskmaster", "--toggle-overlay"]));
        assert!(!toggle_requested(["taskmaster", "--", "--toggle-overlay"]));
    }

    #[test]
    fn hiding_requires_a_tray_icon_and_a_host() {
        assert!(can_hide_to_tray(true, true));
        assert!(!can_hide_to_tray(true, false));
        assert!(!can_hide_to_tray(false, true));
        assert!(!can_hide_to_tray(false, false));
    }
}
