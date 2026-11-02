import { appState } from "../../app/state.ts";
import { escapeHtml, root } from "../../shared/dom.ts";
import { backendMessage } from "../../shared/errors.ts";
import { language, t } from "../../shared/i18n.ts";
import { invoke } from "../../shared/tauri.ts";
import { type ClearMode } from "../../shared/types.ts";
import { taskAnimationLocks } from "../tasks/controller.ts";
import { tasksState } from "../tasks/state.ts";
import { deletionsState } from "./state.ts";
export async function openPermanentDeletion(id: string): Promise<void> {
    if (deletionsState.purgeOpening || document.querySelector("[data-purge-dialog]"))
        return;
    deletionsState.purgeOpening = true;
    try {
        const preview = await invoke("prepare_permanent_deletion", { id });
        const dialog = document.createElement("dialog");
        dialog.className = "reminder-dialog purge-confirm";
        dialog.dataset.purgeDialog = "";
        dialog.setAttribute("aria-labelledby", "purge-heading");
        dialog.setAttribute("aria-describedby", "purge-description");
        dialog.innerHTML = `<form><h2 id="purge-heading">${t("Удалить навсегда?")}</h2><p class="purge-title">${escapeHtml(preview.task.title)}</p><p id="purge-description">${t("Задача и вся её история будут удалены без возможности отмены.")}</p>${preview.task.status === "active" ? `<p>${t("Сейчас задача находится в активной очереди.")}</p>` : ""}<p>${t("Событий:")} ${preview.eventCount}${preview.sessionCount ? ` · ${t("Сессий:")} ${preview.sessionCount}` : ""}</p><div class="reminder-actions"><button type="button" data-purge-cancel autofocus>${t("Отмена")}</button><button type="submit" class="danger-action">${t("Удалить навсегда")}</button></div></form>`;
        document.body.append(dialog);
        let busy = false;
        const close = (): void => { dialog.close(); dialog.remove(); root.querySelector<HTMLButtonElement>(`[data-purge-task="${id}"]`)?.focus(); };
        const cancel = (): void => {
            if (busy)
                return;
            close();
            void invoke("cancel_permanent_deletion", { token: preview.token }).catch((error) => { tasksState.errorMessage = backendMessage(error); effects.render(); });
        };
        dialog.querySelector("[data-purge-cancel]")?.addEventListener("click", cancel);
        dialog.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
        dialog.querySelector("form")?.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (busy)
                return;
            busy = true;
            dialog.querySelectorAll("button").forEach((button) => { button.disabled = true; });
            try {
                await invoke("confirm_permanent_deletion", { token: preview.token });
                close();
                await effects.refreshTasks();
                await effects.refreshHistory();
                await refreshDeletionUndos();
            }
            catch (error) {
                close();
                tasksState.errorMessage = backendMessage(error);
                effects.render();
            }
        });
        dialog.showModal();
    }
    catch (error) {
        tasksState.errorMessage = backendMessage(error);
        effects.render();
    }
    finally {
        deletionsState.purgeOpening = false;
    }
}
export const undoBusy = new Set<string>();
export function renderDeletionUndos(): void {
    deletionsState.deletionUndos = deletionsState.deletionUndos.filter((item) => item.expiresAt > Date.now());
    if (deletionsState.undoExpiryTimer !== null)
        window.clearTimeout(deletionsState.undoExpiryTimer);
    deletionsState.undoExpiryTimer = deletionsState.deletionUndos.length ? window.setTimeout(renderDeletionUndos, Math.max(1, Math.min(...deletionsState.deletionUndos.map((item) => item.expiresAt)) - Date.now())) : null;
    let region = document.querySelector<HTMLElement>("#deletion-undos");
    if (!region) {
        region = document.createElement("aside");
        region.id = "deletion-undos";
        region.className = "undo-notices";
        region.setAttribute("aria-label", t("Удалённые задачи"));
        region.setAttribute("aria-live", "polite");
        document.body.append(region);
    }
    region.setAttribute("aria-label", t("Удалённые задачи"));
    region.hidden = deletionsState.deletionUndos.length === 0 && !deletionsState.undoMessage;
    const key = JSON.stringify([language(), deletionsState.deletionUndos, [...undoBusy], deletionsState.undoMessage]);
    if (key === deletionsState.undoRenderKey)
        return;
    deletionsState.undoRenderKey = key;
    region.innerHTML = `${deletionsState.undoMessage ? `<div class="undo-error" role="alert"><span>${escapeHtml(deletionsState.undoMessage)}</span><button type="button" data-dismiss-undo-message aria-label="${t("Закрыть сообщение")}">×</button></div>` : ""}<ul>${deletionsState.deletionUndos.map((item) => `<li><span><small>${t("Задача удалена")}</small><strong>${escapeHtml(item.title)}</strong></span><button type="button" data-undo-deletion="${item.token}" aria-label="${t("Отменить удаление:")} ${escapeHtml(item.title)}" ${undoBusy.has(item.token) ? "disabled" : ""}>${t("Отменить")}</button></li>`).join("")}</ul>`;
    region.querySelector<HTMLButtonElement>("[data-dismiss-undo-message]")?.addEventListener("click", () => { deletionsState.undoMessage = ""; renderDeletionUndos(); });
    region.querySelectorAll<HTMLButtonElement>("[data-undo-deletion]").forEach((button) => button.addEventListener("click", async () => {
        const token = button.dataset.undoDeletion!;
        if (undoBusy.has(token))
            return;
        undoBusy.add(token);
        deletionsState.undoMessage = "";
        renderDeletionUndos();
        try {
            const restored = await invoke("undo_task_deletion", { token });
            deletionsState.deletionUndos = deletionsState.deletionUndos.filter((item) => item.token !== token);
            await effects.refreshTasks();
            if (appState.activeView === "history")
                await effects.refreshHistory();
            if (restored.status === "archived")
                deletionsState.undoMessage = t("Удаление отменено. Срок задачи истёк, она находится в архиве.");
            else
                root.querySelector<HTMLButtonElement>(`[data-toggle-task="${CSS.escape(restored.id)}"]`)?.focus();
        }
        catch (error) {
            deletionsState.undoMessage = backendMessage(error);
        }
        finally {
            undoBusy.delete(token);
            await refreshDeletionUndos();
            renderDeletionUndos();
        }
    }));
}
export async function refreshDeletionUndos(): Promise<void> {
    try {
        deletionsState.deletionUndos = await invoke("list_deletion_undos");
    }
    catch (error) {
        deletionsState.undoMessage = backendMessage(error);
    }
    renderDeletionUndos();
}
export function openClearData(mode: ClearMode): void {
    if (deletionsState.clearingData || document.querySelector("[data-clear-dialog]"))
        return;
    const dialog = document.createElement("dialog");
    dialog.className = "reminder-dialog";
    dialog.dataset.clearDialog = "";
    dialog.setAttribute("aria-labelledby", "clear-heading");
    dialog.setAttribute("aria-describedby", "clear-description");
    const description = mode === "tasks"
        ? `${t("Все задачи, архив, история и напоминания будут удалены.")} ${t("Таймеры, настройки и существующие резервные копии сохранятся. Новая копия не создаётся. Отменить действие нельзя.")}`
        : t("Будут удалены все задачи, история, таймеры, настройки, журналы и резервные копии приложения. Автозапуск будет отключён. Отменить действие нельзя. Приложение перезапустится с настройками по умолчанию.");
    dialog.innerHTML = `<form><h2 id="clear-heading">${mode === "tasks" ? t("Очистить задачи?") : t("Сбросить данные?")}</h2><p id="clear-description">${description}</p><p role="alert" data-clear-error></p><p role="status" data-clear-status></p><div class="reminder-actions"><button type="button" data-clear-cancel autofocus>${t("Отмена")}</button><button type="submit" class="danger-action">${mode === "tasks" ? t("Очистить задачи") : t("Сбросить данные")}</button></div></form>`;
    const close = (): void => { if (deletionsState.clearingData)
        return; dialog.close(); dialog.remove(); root.querySelector<HTMLButtonElement>(`[data-clear-data="${mode}"]`)?.focus({ preventScroll: true }); };
    dialog.querySelector("[data-clear-cancel]")!.addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.querySelector("form")!.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (deletionsState.clearingData)
            return;
        deletionsState.clearingData = true;
        dialog.querySelector<HTMLElement>("[data-clear-error]")!.textContent = "";
        dialog.querySelectorAll("button").forEach((button) => { button.disabled = true; });
        try {
            await invoke("clear_user_data", { mode });
            if (mode === "allData") {
                dialog.querySelector<HTMLElement>("[data-clear-status]")!.textContent = t("Перезапуск…");
                return;
            }
            deletionsState.clearingData = false;
            close();
        }
        catch (error) {
            deletionsState.clearingData = false;
            dialog.querySelector<HTMLElement>("[data-clear-error]")!.textContent = backendMessage(error);
            dialog.querySelectorAll("button").forEach((button) => { button.disabled = false; });
        }
    });
    document.body.append(dialog);
    dialog.showModal();
}
export function bindDeletionsEvents(scope: ParentNode): void {
    scope.querySelectorAll<HTMLButtonElement>("[data-purge-task]").forEach((button) => button.addEventListener("click", () => { if (button.dataset.purgeTask)
        void openPermanentDeletion(button.dataset.purgeTask); }));
    scope.querySelectorAll<HTMLButtonElement>("[data-delete-task]").forEach((button) => button.addEventListener("click", async () => {
        const id = button.dataset.deleteTask;
        if (!id || tasksState.saving || taskAnimationLocks.has(id))
            return;
        const deleted = await effects.perform(async () => {
            const undo = await invoke("delete_task", { id });
            deletionsState.deletionUndos = [...deletionsState.deletionUndos.filter((item) => item.taskId !== id), undo];
            deletionsState.undoMessage = "";
            renderDeletionUndos();
        });
        if (deleted) {
            await refreshDeletionUndos();
            if (appState.activeView === "history")
                await effects.refreshHistory();
        }
    }));
}
type Effects = {
    render: typeof import("../../app/view.ts").render;
    refreshTasks: typeof import("../tasks/controller.ts").refreshTasks;
    refreshHistory: typeof import("../history/controller.ts").refreshHistory;
    perform: typeof import("../../app/view.ts").perform;
};
let effects: Effects;
export function configureDeletions(callbacks: Effects): void { effects = callbacks; }
