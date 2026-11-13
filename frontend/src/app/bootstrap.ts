import { getCurrentWindow } from "@tauri-apps/api/window";
import { refreshDeletionUndos } from "../features/deletions/controller.ts";
import { deletionsState } from "../features/deletions/state.ts";
import { refreshHistory } from "../features/history/controller.ts";
import { historyState } from "../features/history/state.ts";
import { renderOverlay } from "../features/overlay/controller.ts";
import { remindersState } from "../features/reminders/state.ts";
import { applyDisplaySettings, applyTheme, loadShortcuts, refreshAutostart, refreshBackupStatus, refreshDiagnosticsWarning, refreshNotificationStatus, updateNotificationControls } from "../features/settings/controller.ts";
import { settingsState } from "../features/settings/state.ts";
import { activeTasks, enteringTaskIds, refreshTasks, saveOrder, taskAnimationLocks } from "../features/tasks/controller.ts";
import { tasksState } from "../features/tasks/state.ts";
import { refreshTimers, timerSnapshots } from "../features/timers/controller.ts";
import { timersState } from "../features/timers/state.ts";
import { isSameLocalDay, monthStart, parseLocalDate, toLocalDateString } from "../shared/dates.ts";
import { announce, displayWarning, liveStatus, root, skipLink } from "../shared/dom.ts";
import { backendMessage } from "../shared/errors.ts";
import { backendText, language, setLanguage, t } from "../shared/i18n.ts";
import { keyboardCombination, type ShortcutAction } from "../shared/shortcuts.ts";
import { invoke, listen } from "../shared/tauri.ts";
import { readTheme, themeStorageKey } from "../shared/theme.ts";
import { type ClearMode, type DisplaySettings, type Timer, type View } from "../shared/types.ts";
import { configureFeatures } from "./configure.ts";
import { appState } from "./state.ts";
import { render } from "./view.ts";
export async function startApp(): Promise<void> {
    configureFeatures();
    settingsState.usesLinuxDesktop = (await invoke("uses_linux_desktop").catch(() => false)) === true;
    try {
        settingsState.displaySettings = await invoke("get_display_settings");
        setLanguage(settingsState.displaySettings.language);
        settingsState.displaySettingsReady = true;
    }
    catch (error) {
        settingsState.displaySettingsError = backendMessage(error);
    }
    document.documentElement.lang = language();
    displayWarning.className = "display-warning";
    displayWarning.setAttribute("role", "alert");
    displayWarning.hidden = !settingsState.displaySettingsError;
    displayWarning.textContent = settingsState.displaySettingsError;
    document.body.append(displayWarning);
    liveStatus.id = "app-status";
    liveStatus.className = "visually-hidden";
    liveStatus.setAttribute("role", "status");
    liveStatus.setAttribute("aria-live", "polite");
    liveStatus.setAttribute("aria-atomic", "true");
    document.body.append(liveStatus);
    skipLink.className = "skip-link";
    skipLink.href = "#today";
    skipLink.textContent = t("Перейти к содержимому");
    skipLink.addEventListener("click", (event) => { event.preventDefault(); const main = root.querySelector<HTMLElement>("main"); main?.setAttribute("tabindex", "-1"); main?.focus({ preventScroll: true }); });
    document.body.prepend(skipLink);
    for (const name of ["wheel", "pointerdown", "keydown"] as const)
        window.addEventListener(name, () => {
            if (remindersState.reminderReturn?.restoreFocus && !remindersState.reminderEditingTaskId)
                remindersState.reminderReturn = null;
        }, { capture: true, passive: true });
    void listen<DisplaySettings>("display-settings-changed", ({ payload }) => applyDisplaySettings(payload));
    window.addEventListener("storage", (event) => { if (event.key === themeStorageKey) {
        settingsState.theme = readTheme();
        applyTheme();
    } });
    void listen<ClearMode>("data-cleared", ({ payload }) => {
        announce(t("Данные очищены"));
        tasksState.tasks = [];
        deletionsState.deletionUndos = [];
        tasksState.editingTaskId = null;
        remindersState.reminderEditingTaskId = null;
        remindersState.reminderReturn = null;
        remindersState.highlightedReminderTaskId = null;
        tasksState.pendingTaskFocusId = null;
        enteringTaskIds.clear();
        taskAnimationLocks.clear();
        if (payload === "allData") {
            timersState.timers = [];
            timerSnapshots.clear();
            timersState.fullscreenTimerId = null;
            timersState.timerDialogOpen = false;
        }
        if (getCurrentWindow().label !== "overlay") {
            render(true);
            void refreshTasks();
            void refreshHistory();
            if (payload === "allData")
                void refreshTimers();
        }
    });
    void loadShortcuts();
    void listen<typeof settingsState.shortcuts>("shortcuts-changed", ({ payload }) => { settingsState.shortcuts = payload; settingsState.shortcutsReady = true; });
    if (getCurrentWindow().label === "overlay") {
        applyTheme();
        document.body.classList.add("overlay-mode");
        void renderOverlay();
        void listen("database-restored", () => window.location.reload());
    }
    else {
        applyTheme();
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
            if (settingsState.theme === "system")
                applyTheme();
        });
        const syncViewFromHash = (): void => {
            const nextView: View = window.location.hash === "#settings" ? "settings" : window.location.hash === "#completed" ? "completed" : window.location.hash === "#history" ? "history" : window.location.hash === "#timers" ? "timers" : "today";
            if (nextView === appState.activeView)
                return;
            appState.activeView = nextView;
            render(true);
            if (appState.activeView === "history")
                void refreshHistory();
            if (appState.activeView === "timers")
                void refreshTimers();
        };
        window.addEventListener("popstate", syncViewFromHash);
        window.addEventListener("hashchange", syncViewFromHash);
        void listen<string>("reminder-open-task", async ({ payload }) => {
            await refreshTasks();
            const task = tasksState.tasks.find((item) => item.id === payload);
            if (!task)
                return;
            if (task.status === "active") {
                appState.activeView = "today";
            }
            else if (task.status === "completed" && isSameLocalDay(task.completedAt, new Date())) {
                appState.activeView = "completed";
            }
            else {
                appState.activeView = "history";
                const eventTime = task.status === "archived" ? task.archivedAt : task.completedAt;
                if (eventTime !== null) {
                    historyState.selectedHistoryDate = toLocalDateString(new Date(eventTime));
                    historyState.calendarMonth = monthStart(parseLocalDate(historyState.selectedHistoryDate));
                    await refreshHistory();
                }
            }
            window.history.pushState(null, "", `#${appState.activeView}`);
            remindersState.highlightedReminderTaskId = payload;
            render(true);
            const row = root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(payload)}"]`);
            row?.scrollIntoView({ behavior: "smooth", block: "center" });
            window.setTimeout(() => { remindersState.highlightedReminderTaskId = null; render(true); }, 4000);
        });
        void listen<string | null>("reminder-delivery-error", ({ payload }) => {
            tasksState.errorMessage = typeof payload === "string" ? backendText(payload) : t("Не удалось отправить уведомление. Проверьте Параметры Windows → Система → Уведомления.");
            settingsState.notificationActionMessage = tasksState.errorMessage;
            if (appState.activeView === "settings")
                updateNotificationControls();
            else
                render(true);
            void refreshNotificationStatus();
        });
        void listen("reminder-runtime-error", () => {
            tasksState.errorMessage = t("Не удалось обработать напоминание. Перезапустите приложение.");
            render(true);
        });
        void refreshAutostart();
        void invoke("get_app_version").then((value) => { settingsState.appVersion = value; if (appState.activeView === "settings")
            render(true); }).catch((error) => { settingsState.appVersionError = backendMessage(error); if (appState.activeView === "settings")
            render(true); });
        void listen("open-settings", () => {
            appState.activeView = "settings";
            window.history.pushState(null, "", "#settings");
            render(true);
            void refreshAutostart();
            void refreshNotificationStatus();
        });
        void refreshNotificationStatus();
        window.addEventListener("focus", () => { if (appState.activeView === "settings") {
            void refreshAutostart();
            void refreshDiagnosticsWarning();
        } void refreshNotificationStatus(); });
        void refreshBackupStatus();
        void invoke("get_preferences").then((value) => { settingsState.preferences = value; settingsState.preferencesReady = true; if (appState.activeView === "settings")
            render(true); }).catch((error) => { settingsState.preferencesError = backendMessage(error); if (appState.activeView === "settings")
            render(true); });
        render();
        void refreshTasks();
        if (appState.activeView === "history")
            void refreshHistory();
        if (appState.activeView === "timers")
            void refreshTimers();
        window.addEventListener("keydown", (event) => {
            if (event.defaultPrevented || event.repeat || !settingsState.shortcutsReady || tasksState.mouseDragActive || (event.target as HTMLElement).closest("[data-shortcut-capture]"))
                return;
            const combination = keyboardCombination(event);
            const action = (Object.keys(settingsState.shortcuts) as ShortcutAction[]).find((key) => settingsState.shortcuts[key] === combination);
            if (!action)
                return;
            event.preventDefault();
            if (document.querySelector("dialog[open]"))
                return;
            const target = event.target as HTMLElement;
            const taskAction = ["rename", "reminder", "move_up", "move_down"].includes(action);
            const row = target.closest<HTMLElement>("[data-task-id][data-reorderable='true']");
            if (taskAction && (!row || target.closest("input, textarea, select, [contenteditable='true']") || tasksState.saving || taskAnimationLocks.has(row.dataset.taskId ?? "")))
                return;
            event.preventDefault();
            if (taskAction && row) {
                const id = row.dataset.taskId!;
                if (action === "rename") {
                    tasksState.editingTaskId = id;
                    render(true);
                }
                else if (action === "reminder")
                    row.querySelector<HTMLButtonElement>("[data-edit-reminder]")?.click();
                else {
                    const ids = activeTasks().map((task) => task.id);
                    const index = ids.indexOf(id);
                    const next = index + (action === "move_up" ? -1 : 1);
                    if (index >= 0 && next >= 0 && next < ids.length) {
                        [ids[index], ids[next]] = [ids[next], ids[index]];
                        void saveOrder(ids, next);
                    }
                }
                return;
            }
            if (action === "new_task" && appState.activeView === "today" && !timersState.fullscreenTimerId) {
                root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
                return;
            }
            timersState.fullscreenTimerId = null;
            const nextView: View = action === "new_task" ? "today" : action === "new_timer" ? "timers" : action as View;
            appState.activeView = nextView;
            window.history.pushState(null, "", `#${nextView}`);
            if (action === "new_timer") {
                timersState.timerDialogOpen = true;
                timersState.timerError = "";
            }
            render(true);
            if (nextView === "history")
                void refreshHistory();
            if (nextView === "timers")
                void refreshTimers();
            if (action === "new_task")
                root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
        });
        window.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && timersState.fullscreenTimerId) {
                timersState.fullscreenTimerId = null;
                render(true);
            }
        });
        void listen<Timer>("timer-finished", async ({ payload }) => {
            announce(`${t("Таймер завершён:")} ${payload.name}.`);
            await refreshTimers();
        });
        void listen<string | null>("timer-notification-error", ({ payload }) => {
            timersState.timerError = typeof payload === "string" ? backendText(payload) : t("Не удалось отправить уведомление. Проверьте Параметры Windows → Система → Уведомления.");
            settingsState.notificationActionMessage = timersState.timerError;
            if (appState.activeView === "timers")
                render(true);
            else if (appState.activeView === "settings")
                updateNotificationControls();
            void refreshNotificationStatus();
        });
        void listen("timer-runtime-error", () => {
            timersState.timerError = t("Не удалось сохранить состояние таймера.");
            if (appState.activeView === "timers")
                render(true);
        });
        void listen("archive-runtime-error", () => {
            tasksState.errorMessage = t("Не удалось проверить срок задач. Перезапустите приложение.");
            render();
        });
        window.setInterval(() => { if (appState.activeView === "timers")
            void refreshTimers(false); }, 1000);
        void listen("tasks-changed", () => { void refreshTasks(); void refreshDeletionUndos(); if (appState.activeView === "history")
            void refreshHistory(); });
        void listen("overlay-open-today", () => {
            appState.activeView = "today";
            window.history.pushState(null, "", "#today");
            render(true);
            root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
        });
        void listen<string>("overlay-open-timer-focus", ({ payload }) => {
            appState.activeView = "timers";
            timersState.fullscreenTimerId = payload;
            window.history.pushState(null, "", "#timers");
            void refreshTimers();
        });
        void listen<string>("overlay-shortcut-error", ({ payload }) => {
            settingsState.overlayShortcutAvailable = false;
            tasksState.errorMessage = `${backendText(payload)} ${t("Проверьте, не занято ли сочетание другой программой.")}`;
            render(true);
        });
        if (!settingsState.usesLinuxDesktop) {
            void invoke("get_overlay_shortcut_status").then((status) => {
                settingsState.overlayShortcut = status.shortcut;
                settingsState.overlayShortcutAvailable = status.available;
                if (!status.available)
                    tasksState.errorMessage = `${t("Не удалось зарегистрировать")} ${status.shortcut}. ${t("Можно выбрать другое сочетание клавиш.")}`;
                render(true);
            }).catch((error) => {
                tasksState.errorMessage = backendMessage(error);
                render(true);
            });
        }
    }
}
