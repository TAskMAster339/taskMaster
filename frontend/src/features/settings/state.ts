import { defaultShortcuts } from "../../shared/shortcuts.ts";
import { readTheme } from "../../shared/theme.ts";
import { type BackupStatus, type DisplaySettings, type NotificationStatus, type RestorePreview, type Theme } from "../../shared/types.ts";
export const settingsState: {
    displaySettings: DisplaySettings;
    displaySettingsReady: boolean;
    displaySettingsError: string;
    theme: Theme;
    appVersion: string;
    appVersionError: string;
    autostartEnabled: boolean | null;
    autostartBusy: boolean;
    autostartMessage: string;
    notificationStatus: NotificationStatus | null;
    notificationBusy: boolean;
    notificationReadError: string;
    notificationActionMessage: string;
    backupStatus: BackupStatus | null;
    backupMessage: string;
    backupBusy: boolean;
    restorePreview: RestorePreview | null;
    preferences: {
        reminderMinutes: number;
        archiveHours: number;
    };
    preferencesReady: boolean;
    preferencesError: string;
    shortcuts: {
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
    shortcutsReady: boolean;
    shortcutsError: string;
    usesLinuxDesktop: boolean;
    overlayShortcut: string;
    overlayShortcutAvailable: boolean;
    overlayShortcutDialogOpen: boolean;
    overlayShortcutError: string;
} = {
    displaySettings: { language: "ja", highContrast: false },
    displaySettingsReady: false,
    displaySettingsError: "",
    theme: readTheme(),
    appVersion: "",
    appVersionError: "",
    autostartEnabled: null,
    autostartBusy: false,
    autostartMessage: "",
    notificationStatus: null,
    notificationBusy: false,
    notificationReadError: "",
    notificationActionMessage: "",
    backupStatus: null,
    backupMessage: "",
    backupBusy: false,
    restorePreview: null,
    preferences: { reminderMinutes: 15, archiveHours: 24 },
    preferencesReady: false,
    preferencesError: "",
    shortcuts: { ...defaultShortcuts },
    shortcutsReady: false,
    shortcutsError: "",
    usesLinuxDesktop: false,
    overlayShortcut: "Ctrl+Alt+Space",
    overlayShortcutAvailable: true,
    overlayShortcutDialogOpen: false,
    overlayShortcutError: "",
};
