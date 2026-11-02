import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { BackupStatus, ClearMode, DisplaySettings, HistoryDay, NotificationStatus, OverlayShortcutStatus, PermanentDeletionPreview, RestorePreview, Task, Theme, Timer, UndoDeletion } from "./types.ts";
export { listen } from "@tauri-apps/api/event";
interface Commands {
    cancel_database_restore: {
        args: undefined;
        result: void;
    };
    cancel_permanent_deletion: {
        args: {
            token: string;
        };
        result: void;
    };
    clear_task_reminder: {
        args: {
            id: string;
        };
        result: void;
    };
    clear_user_data: {
        args: {
            mode: ClearMode;
        };
        result: void;
    };
    complete_overlay_task: {
        args: {
            id: string;
        };
        result: void;
    };
    complete_task: {
        args: {
            id: string;
        };
        result: void;
    };
    confirm_database_restore: {
        args: {
            token: string;
        };
        result: string;
    };
    confirm_permanent_deletion: {
        args: {
            token: string;
        };
        result: void;
    };
    create_database_backup: {
        args: undefined;
        result: string | null;
    };
    create_task: {
        args: {
            title: string;
        };
        result: Task;
    };
    create_timer: {
        args: {
            name: string;
            durationSeconds: number;
        };
        result: Timer;
    };
    delete_task: {
        args: {
            id: string;
        };
        result: UndoDeletion;
    };
    delete_timer: {
        args: {
            id: string;
        };
        result: void;
    };
    export_user_data: {
        args: {
            theme: Theme;
        };
        result: string;
    };
    get_app_version: {
        args: undefined;
        result: string;
    };
    get_autostart_enabled: {
        args: undefined;
        result: boolean;
    };
    get_backup_status: {
        args: undefined;
        result: BackupStatus;
    };
    get_diagnostics_warning: {
        args: undefined;
        result: string | null;
    };
    get_display_settings: {
        args: undefined;
        result: DisplaySettings;
    };
    get_notification_status: {
        args: undefined;
        result: NotificationStatus;
    };
    get_overlay_pinned: {
        args: undefined;
        result: boolean;
    };
    get_overlay_shortcut_status: {
        args: undefined;
        result: OverlayShortcutStatus;
    };
    get_preferences: {
        args: undefined;
        result: {
            reminderMinutes: number;
            archiveHours: number;
        };
    };
    get_shortcuts: {
        args: undefined;
        result: {
            new_task: string;
            new_timer: string;
            settings: string;
            today: string;
            completed: string;
            history: string;
            timers: string;
            reminder: string;
            rename: string;
            move_up: string;
            move_down: string;
        };
    };
    list_deletion_undos: {
        args: undefined;
        result: UndoDeletion[];
    };
    list_history_for_range: {
        args: {
            start: number;
            end: number;
        };
        result: HistoryDay;
    };
    list_task_creation_times: {
        args: {
            start: number;
            end: number;
        };
        result: number[];
    };
    list_tasks: {
        args: undefined;
        result: Task[];
    };
    list_timers: {
        args: undefined;
        result: Timer[];
    };
    open_about_link: {
        args: {
            url: string;
        };
        result: void;
    };
    open_data_directory: {
        args: undefined;
        result: void;
    };
    open_notification_settings: {
        args: undefined;
        result: void;
    };
    open_overlay_timer_focus: {
        args: {
            id: string;
        };
        result: void;
    };
    open_task_list: {
        args: undefined;
        result: void;
    };
    pause_timer: {
        args: {
            id: string;
        };
        result: void;
    };
    prepare_database_restore: {
        args: {
            latest: boolean;
        };
        result: RestorePreview | null;
    };
    prepare_permanent_deletion: {
        args: {
            id: string;
        };
        result: PermanentDeletionPreview;
    };
    rename_task: {
        args: {
            id: string;
            title: string;
        };
        result: void;
    };
    reopen_task: {
        args: {
            id: string;
        };
        result: void;
    };
    reorder_tasks: {
        args: {
            ids: string[];
        };
        result: void;
    };
    reset_timer: {
        args: {
            id: string;
        };
        result: void;
    };
    resize_overlay_for_timers: {
        args: {
            timerCount: number;
        };
        result: number;
    };
    restore_task: {
        args: {
            id: string;
        };
        result: void;
    };
    send_test_notification: {
        args: undefined;
        result: void;
    };
    set_autostart_enabled: {
        args: {
            enabled: boolean;
        };
        result: boolean;
    };
    set_overlay_pinned: {
        args: {
            pinned: boolean;
        };
        result: void;
    };
    set_overlay_shortcut: {
        args: {
            shortcut: string;
        };
        result: OverlayShortcutStatus;
    };
    set_task_reminder: {
        args: {
            id: string;
            reminderAt: number;
        };
        result: void;
    };
    start_timer: {
        args: {
            id: string;
        };
        result: void;
    };
    toggle_task_overlay: {
        args: undefined;
        result: boolean;
    };
    undo_task_deletion: {
        args: {
            token: string;
        };
        result: Task;
    };
    update_display_settings: {
        args: {
            settings: DisplaySettings;
        };
        result: DisplaySettings;
    };
    update_preferences: {
        args: {
            reminderMinutes: number;
            archiveHours: number;
        };
        result: void;
    };
    update_shortcut: {
        args: {
            action: "new_task" | "new_timer" | "settings" | "today" | "completed" | "history" | "timers" | "reminder" | "rename" | "move_up" | "move_down";
            combination: string | undefined;
        };
        result: {
            new_task: string;
            new_timer: string;
            settings: string;
            today: string;
            completed: string;
            history: string;
            timers: string;
            reminder: string;
            rename: string;
            move_up: string;
            move_down: string;
        };
    };
}
export function invoke<K extends keyof Commands>(command: K, ...args: Commands[K]["args"] extends undefined ? [
] : [
    Commands[K]["args"]
]): Promise<Commands[K]["result"]> {
    return tauriInvoke(command, args[0]);
}
