use crate::commands::deletions::{
    cancel_permanent_deletion, clear_user_data, confirm_permanent_deletion, delete_task,
    list_deletion_undos, prepare_permanent_deletion, undo_task_deletion,
};
#[cfg(not(target_os = "linux"))]
use crate::commands::overlay::set_overlay_shortcut;
use crate::commands::overlay::{
    complete_overlay_task, get_overlay_pinned, get_overlay_shortcut_status,
    open_overlay_timer_focus, open_task_list, resize_overlay_for_timers, set_overlay_pinned,
    toggle_task_overlay,
};
use crate::commands::settings::{
    get_app_version, get_preferences, get_shortcuts, update_preferences, update_shortcut,
};
use crate::commands::storage::{
    cancel_database_restore, confirm_database_restore, create_database_backup, export_user_data,
    get_backup_status, open_data_directory, prepare_database_restore,
};
use crate::commands::tasks::{
    archive_expired_tasks, clear_task_reminder, complete_task, create_task, list_history_for_range,
    list_task_creation_times, list_tasks, rename_task, reopen_task, reorder_tasks, restore_task,
    set_task_reminder,
};
use crate::commands::timers::{
    create_timer, delete_timer, list_timers, pause_timer, reset_timer, start_timer,
};
use crate::platform::windows::show_main_window;
#[cfg(not(target_os = "linux"))]
use crate::platform::windows::toggle_overlay;
mod app;
mod commands;
mod domain;
mod persistence;
mod platform;
#[cfg(test)]
mod tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            #[cfg(target_os = "linux")]
            if platform::linux_launch::toggle_requested(args) {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    platform::windows::toggle_overlay_from_desktop(&handle)
                });
                return;
            }
            #[cfg(not(target_os = "linux"))]
            let _ = args;
            show_main_window(app);
        }));
    #[cfg(not(target_os = "linux"))]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                use tauri_plugin_global_shortcut::ShortcutState;
                if event.state() == ShortcutState::Pressed {
                    let _ = toggle_overlay(app);
                }
            })
            .build(),
    );
    builder
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("taskMaster")
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(app::bootstrap::setup)
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            commands::desktop::uses_linux_desktop,
            platform::tray::hide_to_tray,
            commands::settings::get_display_settings,
            commands::settings::update_display_settings,
            commands::desktop::open_about_link,
            clear_user_data,
            commands::settings::get_diagnostics_warning,
            commands::desktop::get_notification_status,
            commands::desktop::send_test_notification,
            commands::desktop::open_notification_settings,
            commands::desktop::get_autostart_enabled,
            commands::desktop::set_autostart_enabled,
            get_backup_status,
            create_database_backup,
            prepare_database_restore,
            cancel_database_restore,
            confirm_database_restore,
            open_data_directory,
            get_shortcuts,
            update_shortcut,
            get_preferences,
            update_preferences,
            export_user_data,
            list_tasks,
            delete_task,
            prepare_permanent_deletion,
            confirm_permanent_deletion,
            cancel_permanent_deletion,
            undo_task_deletion,
            list_deletion_undos,
            create_task,
            rename_task,
            reorder_tasks,
            complete_task,
            reopen_task,
            archive_expired_tasks,
            list_history_for_range,
            list_task_creation_times,
            restore_task,
            set_task_reminder,
            clear_task_reminder,
            list_timers,
            create_timer,
            start_timer,
            pause_timer,
            reset_timer,
            delete_timer,
            toggle_task_overlay,
            set_overlay_pinned,
            get_overlay_pinned,
            get_overlay_shortcut_status,
            #[cfg(not(target_os = "linux"))]
            set_overlay_shortcut,
            complete_overlay_task,
            open_task_list,
            open_overlay_timer_focus,
            resize_overlay_for_timers,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run taskMaster");
}
