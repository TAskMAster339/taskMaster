use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlaySettings {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) pinned: bool,
    #[serde(default = "default_overlay_shortcut")]
    pub(crate) shortcut: String,
}

pub(crate) fn default_overlay_shortcut() -> String {
    "Ctrl+Alt+Space".into()
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            x: 24,
            y: 24,
            pinned: false,
            shortcut: default_overlay_shortcut(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayShortcutStatus {
    pub(crate) shortcut: String,
    pub(crate) available: bool,
}
