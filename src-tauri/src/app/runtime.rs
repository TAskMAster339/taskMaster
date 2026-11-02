use crate::app::state::AppState;
use crate::domain::models::{DueReminder, Timer};
use crate::platform::windows::show_main_window;
use crate::platform::{diagnostics, notifications, presentation};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn notify_reminder(app: &AppHandle, reminder: DueReminder) {
    use tauri_plugin_notification::NotificationExt;
    let result = notifications::ensure_available(app).and_then(|()| {
        app.notification()
            .builder()
            .title("taskMaster")
            .body(&reminder.title)
            .extra("taskId", serde_json::Value::String(reminder.task_id))
            .show()
            .map_err(|_| notifications::delivery_error())
    });
    if let Err(error) = result {
        diagnostics::record(diagnostics::Event::NotificationError, Some(error.code));
        let _ = app.emit("reminder-delivery-error", error.message);
    }
}

pub(crate) fn notify_timer_finished(app: &AppHandle, timer: Timer) {
    use tauri_plugin_notification::NotificationExt;
    let result = notifications::ensure_available(app).and_then(|()| {
        app.notification()
            .builder()
            .title(presentation::text("Таймер завершён"))
            .body(&timer.name)
            .show()
            .map_err(|_| notifications::delivery_error())
    });
    if let Err(error) = result {
        diagnostics::record(diagnostics::Event::NotificationError, Some(error.code));
        let _ = app.emit("timer-notification-error", error.message);
    }
    let _ = app.emit("timer-finished", timer);
}

pub(crate) fn register_notification_actions(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let handle = app.clone();
    let _ = app.notification().on_action(move |action| {
        if action.action_id() == "tap"
            && let Some(id) = action
                .notification()
                .and_then(|n| n.extra().get("taskId"))
                .and_then(|v| v.as_str())
        {
            show_main_window(&handle);
            let _ = handle.emit("reminder-open-task", id.to_owned());
        }
    });
}

pub(crate) fn start_reminder_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let Ok(guard) = state.store.lock() else {
                continue;
            };
            let Ok(store) = guard.as_ref() else {
                continue;
            };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            // Maintenance runs in Rust even when the WebView is hidden or throttled.
            let (archived, reminders) = match store.poll_reminders_at(now) {
                Ok(result) => result,
                Err(_) => {
                    diagnostics::record(diagnostics::Event::ReminderError, None);
                    let _ = app.emit("reminder-runtime-error", ());
                    (0, Vec::new())
                }
            };
            let finished_timers = match store.take_due_timers() {
                Ok(timers) => timers,
                Err(_) => {
                    diagnostics::record(diagnostics::Event::TimerError, None);
                    let _ = app.emit("timer-runtime-error", ());
                    Vec::new()
                }
            };
            if archived > 0 {
                let _ = app.emit("tasks-changed", ());
            }
            for reminder in reminders {
                notify_reminder(&app, reminder);
            }
            for timer in finished_timers {
                notify_timer_finished(&app, timer);
            }
            drop(guard);
        }
    });
}
