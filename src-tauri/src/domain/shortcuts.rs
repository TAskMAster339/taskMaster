use crate::app::error::AppError;
use std::collections::{BTreeMap, HashSet};

pub fn defaults() -> BTreeMap<String, String> {
    [
        ("new_task", "Ctrl+N"),
        ("new_timer", "Ctrl+Shift+N"),
        ("settings", "Ctrl+Comma"),
        ("today", "Ctrl+1"),
        ("completed", "Ctrl+2"),
        ("history", "Ctrl+3"),
        ("timers", "Ctrl+4"),
        ("reminder", "Ctrl+R"),
        ("rename", "F2"),
        ("move_up", "Alt+ArrowUp"),
        ("move_down", "Alt+ArrowDown"),
    ]
    .into_iter()
    .map(|(a, k)| (a.into(), k.into()))
    .collect()
}

fn invalid() -> AppError {
    AppError { code: "invalid_shortcut", message: "Нажмите сочетание с Ctrl или Alt либо функциональную клавишу. Системные сочетания недоступны.".into() }
}

pub fn normalize(value: &str) -> Result<String, AppError> {
    let parts: Vec<_> = value.split('+').map(str::trim).collect();
    let mut modifiers = HashSet::new();
    let mut key = None;
    for part in parts {
        let lower = part.to_ascii_lowercase();
        let modifier = match lower.as_str() {
            "ctrl" | "control" => Some("Ctrl"),
            "shift" => Some("Shift"),
            "alt" => Some("Alt"),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if !modifiers.insert(modifier) {
                return Err(invalid());
            }
        } else {
            if key.is_some() {
                return Err(invalid());
            }
            let normalized = match lower.as_str() {
                "," | "comma" => "Comma".into(),
                "space" => "Space".into(),
                "arrowup" | "up" => "ArrowUp".into(),
                "arrowdown" | "down" => "ArrowDown".into(),
                "arrowleft" | "left" => "ArrowLeft".into(),
                "arrowright" | "right" => "ArrowRight".into(),
                "escape" | "esc" => "Escape".into(),
                "delete" => "Delete".into(),
                _ if lower.len() == 1 && lower.as_bytes()[0].is_ascii_alphanumeric() => {
                    lower.to_ascii_uppercase()
                }
                _ if lower
                    .strip_prefix('f')
                    .and_then(|n| n.parse::<u8>().ok())
                    .is_some_and(|n| (1..=12).contains(&n)) =>
                {
                    lower.to_ascii_uppercase()
                }
                _ => return Err(invalid()),
            };
            key = Some(normalized);
        }
    }
    let key = key.ok_or_else(invalid)?;
    if !modifiers.contains("Ctrl")
        && !modifiers.contains("Alt")
        && !key
            .strip_prefix('F')
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (1..=12).contains(&n))
    {
        return Err(invalid());
    }
    let mut ordered: Vec<String> = ["Ctrl", "Shift", "Alt"]
        .into_iter()
        .filter(|m| modifiers.contains(m))
        .map(str::to_owned)
        .collect();
    ordered.push(key);
    let result = ordered.join("+");
    if ["Alt+F4", "Ctrl+Alt+Delete", "Ctrl+Shift+Escape"].contains(&result.as_str()) {
        return Err(invalid());
    }
    Ok(result)
}

pub fn validate(bindings: &BTreeMap<String, String>, overlay: &str) -> Result<(), AppError> {
    if bindings.keys().ne(defaults().keys()) {
        return Err(invalid());
    }
    let mut occupied = HashSet::from([normalize(overlay)?]);
    for value in bindings.values() {
        if !occupied.insert(normalize(value)?) {
            return Err(AppError {
                code: "shortcut_conflict",
                message: "Это сочетание уже используется другим действием.".into(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "../tests/shortcuts_tests.rs"]
mod tests;
