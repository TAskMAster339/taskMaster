pub(crate) const MAX_TIMER_SECONDS: i64 = 359_999;

pub(crate) fn task_title(raw: &str) -> Option<&str> {
    let title = raw.trim();
    (!title.is_empty() && title.chars().count() <= 300).then_some(title)
}

pub(crate) fn timer_name(raw: &str, duration_seconds: i64) -> Option<&str> {
    let name = raw.trim();
    (!name.is_empty()
        && name.chars().count() <= 80
        && (1..=MAX_TIMER_SECONDS).contains(&duration_seconds))
    .then_some(name)
}
