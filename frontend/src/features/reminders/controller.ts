import { appState } from "../../app/state.ts";
import { announce, escapeHtml, root } from "../../shared/dom.ts";
import { backendMessage } from "../../shared/errors.ts";
import { backendText, t } from "../../shared/i18n.ts";
import { invoke } from "../../shared/tauri.ts";
import { settingsState } from "../settings/state.ts";
import { tasksState } from "../tasks/state.ts";
import { remindersState } from "./state.ts";
export function reminderListSignature(): string {
    return JSON.stringify(effects.activeTasks().map(({ id, title, status, position }) => [id, title, status, position]));
}
export function updateRetainedReminder(list: HTMLOListElement): void {
    if (!remindersState.reminderReturn)
        return;
    const { id } = remindersState.reminderReturn;
    const task = tasksState.tasks.find((item) => item.id === id);
    const old = list.querySelector<HTMLButtonElement>(`[data-edit-reminder="${CSS.escape(id)}"]`);
    if (!task || !old)
        return;
    const template = document.createElement("template");
    template.innerHTML = effects.renderTask(task, task.position);
    const next = template.content.querySelector<HTMLButtonElement>("[data-edit-reminder]");
    if (!next || old.outerHTML === next.outerHTML)
        return;
    const fragment = document.createDocumentFragment();
    fragment.append(next);
    effects.bindEvents(fragment);
    old.replaceWith(fragment);
}
export function renderReminderDialog(): void {
    let dialog = document.querySelector<HTMLDialogElement>("[data-reminder-dialog]");
    if (!remindersState.reminderEditingTaskId) {
        dialog?.close();
        dialog?.remove();
        return;
    }
    const task = tasksState.tasks.find((item) => item.id === remindersState.reminderEditingTaskId);
    if (!task)
        return;
    if (!dialog) {
        const template = document.createElement("template");
        template.innerHTML = `<dialog class="reminder-dialog" data-reminder-dialog aria-labelledby="reminder-heading" aria-describedby="reminder-error"><form data-reminder-form="${task.id}"><h2 id="reminder-heading">${t("Напоминание")}</h2><label for="reminder-time">${t("Время сегодня")}</label><input aria-describedby="reminder-error" id="reminder-time" name="reminderAt" type="time" step="60" required aria-invalid="${Boolean(remindersState.reminderDialogError)}" value="${escapeHtml(remindersState.reminderDraft)}"/><p id="reminder-error" class="reminder-dialog-error" role="alert">${escapeHtml(remindersState.reminderDialogError)}</p><div data-reminder-notification-warning ${settingsState.notificationStatus !== null && !settingsState.notificationStatus.canTest ? "" : "hidden"}><p>${escapeHtml(backendText(settingsState.notificationStatus?.message ?? ""))}</p><button class="retry-button" type="button" data-open-notification-settings>${t("Настройки Windows")}</button></div><div class="reminder-actions">${task.reminderAt !== null ? `<button type="button" data-clear-reminder="${task.id}">${t("Удалить")}</button>` : ""}<button type="button" data-close-reminder>${t("Отмена")}</button><button type="submit">${t("Сохранить")}</button></div></form></dialog>`;
        dialog = template.content.querySelector<HTMLDialogElement>("dialog")!;
        bindReminderDialog(dialog);
        effects.bindNotificationControls(dialog);
        document.body.append(dialog);
    }
    const input = dialog.querySelector<HTMLInputElement>("#reminder-time")!;
    if (input.value !== remindersState.reminderDraft)
        input.value = remindersState.reminderDraft;
    input.setAttribute("aria-invalid", String(Boolean(remindersState.reminderDialogError)));
    dialog.querySelector<HTMLElement>("#reminder-error")!.textContent = remindersState.reminderDialogError;
    dialog.setAttribute("aria-busy", String(remindersState.reminderSaving));
    dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((control) => { control.disabled = remindersState.reminderSaving; });
    if (!dialog.open)
        dialog.showModal();
}
export function bindReminderDialog(dialog: HTMLDialogElement): void {
    const scope = dialog;
    scope.querySelector<HTMLInputElement>("#reminder-time")?.addEventListener("input", (event) => { remindersState.reminderDraft = (event.target as HTMLInputElement).value; });
    scope.querySelector<HTMLButtonElement>("[data-close-reminder]")?.addEventListener("click", closeReminder);
    dialog.addEventListener("click", (event) => {
        if (event.target === event.currentTarget)
            closeReminder();
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeReminder(); });
    const saveReminder = async (id: string, clear: boolean): Promise<void> => {
        if (remindersState.reminderSaving)
            return;
        remindersState.reminderSaving = true;
        const dialog = document.querySelector<HTMLDialogElement>("[data-reminder-dialog]");
        dialog?.setAttribute("aria-busy", "true");
        dialog?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((control) => { control.disabled = true; });
        try {
            if (clear)
                await invoke("clear_task_reminder", { id });
            else
                await invoke("set_task_reminder", { id, reminderAt: todayTimestampForTime(remindersState.reminderDraft) });
            const next = await invoke("list_tasks");
            tasksState.tasks = next;
            tasksState.errorMessage = "";
            tasksState.loadFailed = false;
            remindersState.reminderEditingTaskId = null;
            remindersState.reminderDialogError = "";
            if (remindersState.reminderReturn)
                remindersState.reminderReturn.restoreFocus = true;
            announce(clear ? t("Напоминание удалено") : t("Напоминание сохранено"));
            remindersState.reminderSaving = false;
            const list = root.querySelector<HTMLOListElement>(".task-list");
            renderReminderDialog();
            if (list && remindersState.reminderReturn?.signature === reminderListSignature()) {
                updateRetainedReminder(list);
                restoreReminderPosition(list, true);
            }
            else
                effects.render(true);
        }
        catch (error) {
            remindersState.reminderDialogError = backendMessage(error);
        }
        finally {
            remindersState.reminderSaving = false;
            renderReminderDialog();
        }
    };
    scope.querySelector<HTMLFormElement>("[data-reminder-form]")?.addEventListener("submit", (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const id = form.dataset.reminderForm;
        const value = new FormData(form).get("reminderAt");
        if (!id || typeof value !== "string")
            return;
        remindersState.reminderDraft = value;
        void saveReminder(id, false);
    });
    scope.querySelector<HTMLButtonElement>("[data-clear-reminder]")?.addEventListener("click", (event) => {
        const id = (event.currentTarget as HTMLButtonElement).dataset.clearReminder;
        if (id)
            void saveReminder(id, true);
    });
}
export function closeReminder(): void {
    if (remindersState.reminderSaving)
        return;
    remindersState.reminderEditingTaskId = null;
    remindersState.reminderDialogError = "";
    remindersState.reminderDraft = "";
    if (remindersState.reminderReturn)
        remindersState.reminderReturn.restoreFocus = true;
    renderReminderDialog();
    restoreReminderPosition(root.querySelector<HTMLOListElement>(".task-list"), true);
}
export function restoreReminderPosition(list: HTMLOListElement | null, complete: boolean): void {
    const bookmark = remindersState.reminderReturn;
    if (!bookmark)
        return;
    if (bookmark.view !== appState.activeView) {
        remindersState.reminderReturn = null;
        return;
    }
    const target = list?.querySelector<HTMLButtonElement>(`[data-edit-reminder="${CSS.escape(bookmark.id)}"]`);
    if (list)
        list.scrollTop = bookmark.scrollTop;
    if (!bookmark.restoreFocus)
        return;
    const enoughRows = list && list.scrollHeight - list.clientHeight >= bookmark.scrollTop - 1;
    if ((target && enoughRows) || complete) {
        const focusTarget = target ?? list ?? root.querySelector<HTMLElement>(".queue-section");
        if (focusTarget) {
            if (!target)
                focusTarget.tabIndex = -1;
            focusTarget.focus({ preventScroll: true });
        }
        remindersState.reminderReturn = null;
    }
}
export function reminderInputValue(timestamp: number | null): string {
    if (timestamp === null)
        return defaultReminderTimeValue();
    return formatReminderTime(new Date(timestamp));
}
export function formatReminderTime(date: Date): string {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
export function defaultReminderTimeValue(now = new Date()): string {
    const reminderDate = new Date(now);
    const needsNextMinute = now.getSeconds() > 0 || now.getMilliseconds() > 0;
    reminderDate.setSeconds(0, 0);
    reminderDate.setMinutes(reminderDate.getMinutes() + settingsState.preferences.reminderMinutes + Number(needsNextMinute));
    if (reminderDate.getFullYear() !== now.getFullYear()
        || reminderDate.getMonth() !== now.getMonth()
        || reminderDate.getDate() !== now.getDate())
        return "";
    return formatReminderTime(reminderDate);
}
export function todayTimestampForTime(value: string): number {
    const [hours, minutes] = value.split(":").map(Number);
    const reminderDate = new Date();
    reminderDate.setHours(hours, minutes, 0, 0);
    return reminderDate.getTime();
}
export function bindRemindersEvents(scope: ParentNode): void {
    scope.querySelectorAll<HTMLButtonElement>("[data-edit-reminder]").forEach((button) => button.addEventListener("click", async () => {
        if (remindersState.reminderOpening || remindersState.reminderEditingTaskId)
            return;
        remindersState.reminderOpening = true;
        try {
            settingsState.preferences = await invoke("get_preferences");
            settingsState.preferencesReady = true;
            const task = tasksState.tasks.find((item) => item.id === button.dataset.editReminder && item.status === "active");
            if (!task || appState.activeView !== "today")
                return;
            remindersState.reminderReturn = { id: task.id, view: appState.activeView, scrollTop: root.querySelector<HTMLElement>(".task-list")?.scrollTop ?? 0, restoreFocus: false, signature: reminderListSignature() };
            remindersState.reminderEditingTaskId = task.id;
            remindersState.reminderDraft = reminderInputValue(task.reminderAt);
            remindersState.reminderDialogError = "";
            renderReminderDialog();
        }
        catch (error) {
            tasksState.errorMessage = backendMessage(error);
            effects.render(true);
        }
        finally {
            remindersState.reminderOpening = false;
        }
    }));
}
type Effects = {
    activeTasks: typeof import("../tasks/controller.ts").activeTasks;
    renderTask: typeof import("../tasks/controller.ts").renderTask;
    bindEvents: typeof import("../../app/view.ts").bindEvents;
    bindNotificationControls: typeof import("../settings/controller.ts").bindNotificationControls;
    render: typeof import("../../app/view.ts").render;
};
let effects: Effects;
export function configureReminders(callbacks: Effects): void { effects = callbacks; }
