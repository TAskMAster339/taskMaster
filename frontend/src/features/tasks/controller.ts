import { appState } from "../../app/state.ts";
import { isSameLocalDay } from "../../shared/dates.ts";
import { announce, escapeHtml, root, waitForMotion } from "../../shared/dom.ts";
import { backendMessage } from "../../shared/errors.ts";
import { locale, t } from "../../shared/i18n.ts";
import { displayShortcut } from "../../shared/shortcuts.ts";
import { invoke } from "../../shared/tauri.ts";
import { type Task } from "../../shared/types.ts";
import { remindersState } from "../reminders/state.ts";
import { settingsState } from "../settings/state.ts";
import { tasksState } from "./state.ts";
export const taskAnimationLocks = new Set<string>();
export const taskAnimationErrors: string[] = [];
export const enteringTaskIds = new Set<string>();
export function focusTaskWhenRendered(id: string): void {
    const row = root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    if (row) {
        row.focus();
        tasksState.pendingTaskFocusId = null;
    }
    else
        tasksState.pendingTaskFocusId = id;
}
export function captureTaskPositions(): Map<string, string> {
    const positions = new Map<string, string>();
    root.querySelectorAll<HTMLLIElement>('.task-row[data-reorderable="true"]').forEach((row) => {
        const id = row.dataset.taskId;
        const label = row.firstElementChild as HTMLElement | null;
        const oldPosition = label?.classList.contains("is-changing") ? label.firstElementChild?.textContent : "";
        const position = oldPosition || label?.dataset.position;
        if (id && position)
            positions.set(id, position);
    });
    return positions;
}
export function animatePositionChanges(previous: Map<string, string>, scope: ParentNode = root): void {
    if (!previous.size)
        return;
    scope.querySelectorAll<HTMLLIElement>('.task-row[data-reorderable="true"]').forEach((row) => {
        const oldPosition = previous.get(row.dataset.taskId ?? "");
        const position = row.querySelector<HTMLElement>(".task-position");
        if (!oldPosition || !position || oldPosition === position.dataset.position)
            return;
        const oldValue = position.querySelector<HTMLElement>(".position-old");
        if (!oldValue)
            return;
        oldValue.textContent = oldPosition;
        position.classList.add("is-changing");
        requestAnimationFrame(() => position.classList.add("is-changed"));
        const finish = (): void => {
            position.classList.remove("is-changing", "is-changed");
            oldValue.textContent = "";
            oldValue.removeEventListener("transitionend", finish);
        };
        oldValue.addEventListener("transitionend", finish, { once: true });
        window.setTimeout(finish, 320);
    });
}
export function animateEnteringTasks(): void {
    enteringTaskIds.forEach((id) => {
        const row = root.querySelector<HTMLLIElement>(`.task-row[data-task-id="${CSS.escape(id)}"]`);
        if (!row || row.classList.contains("is-entering"))
            return;
        row.classList.add("is-entering");
        const finish = (): void => {
            row.classList.remove("is-entering");
            enteringTaskIds.delete(id);
        };
        row.querySelector<HTMLElement>(".task-title")?.addEventListener("animationend", finish, { once: true });
        window.setTimeout(finish, 900);
    });
}
export async function completeTaskWithAnimation(task: Task, row: HTMLLIElement, button: HTMLButtonElement): Promise<void> {
    if (tasksState.saving || taskAnimationLocks.has(task.id))
        return;
    taskAnimationLocks.add(task.id);
    row.classList.add("is-task-animating");
    tasksState.errorMessage = "";
    button.disabled = true;
    button.classList.add("checked", "is-checking");
    button.setAttribute("aria-pressed", "true");
    button.setAttribute("aria-label", `${t("Выполнена —")} ${task.title}`);
    const mark = button.querySelector<HTMLElement>("span");
    if (mark)
        mark.textContent = "✓";
    row.classList.add("is-completing");
    await waitForMotion(450);
    row.classList.add("is-striking");
    await waitForMotion(650);
    const height = row.getBoundingClientRect().height;
    row.style.height = `${height}px`;
    row.style.overflow = "hidden";
    requestAnimationFrame(() => {
        row.classList.add("is-collapsing");
        row.style.height = "0px";
        row.style.paddingBlock = "0px";
        row.style.borderBottomWidth = "0px";
    });
    await waitForMotion(850);
    let operationError: unknown;
    try {
        await invoke("complete_task", { id: task.id });
    }
    catch (error) {
        operationError = error;
    }
    await finishTaskAnimation(task.id, operationError);
}
export async function reopenTaskWithAnimation(task: Task, row: HTMLLIElement, button: HTMLButtonElement): Promise<void> {
    if (tasksState.saving || taskAnimationLocks.has(task.id))
        return;
    taskAnimationLocks.add(task.id);
    row.classList.add("is-task-animating");
    button.disabled = true;
    button.classList.remove("checked");
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", `${t("Вернуть в очередь —")} ${task.title}`);
    const mark = button.querySelector<HTMLElement>("span");
    if (mark)
        mark.textContent = "";
    row.classList.add("is-restoring");
    await waitForMotion(350);
    const height = row.getBoundingClientRect().height;
    row.style.height = `${height}px`;
    row.style.overflow = "hidden";
    requestAnimationFrame(() => {
        row.classList.add("is-collapsing");
        row.style.height = "0px";
        row.style.paddingBlock = "0px";
        row.style.borderBottomWidth = "0px";
    });
    await waitForMotion(850);
    let operationError: unknown;
    try {
        await invoke("reopen_task", { id: task.id });
    }
    catch (error) {
        operationError = error;
    }
    await finishTaskAnimation(task.id, operationError);
}
export async function finishTaskAnimation(taskId: string, operationError?: unknown): Promise<void> {
    taskAnimationLocks.delete(taskId);
    if (operationError !== undefined)
        taskAnimationErrors.push(backendMessage(operationError));
    if (taskAnimationLocks.size > 0)
        return;
    await refreshTasks();
    if (taskAnimationErrors.length) {
        tasksState.errorMessage = taskAnimationErrors.splice(0).join(" ");
        effects.render();
    }
}
export async function createTask(title: string): Promise<void> {
    if (tasksState.saving)
        return;
    tasksState.saving = true;
    tasksState.errorMessage = "";
    effects.render();
    try {
        const created = await invoke("create_task", { title });
        announce(t("Задача добавлена"));
        enteringTaskIds.add(created.id);
        tasksState.saving = false;
        await refreshTasks();
        if (appState.activeView === "today" && !tasksState.loadFailed) {
            root.querySelector<HTMLElement>(".task-list")?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" });
        }
        else {
            enteringTaskIds.delete(created.id);
        }
    }
    catch (error) {
        tasksState.saving = false;
        tasksState.errorMessage = backendMessage(error);
        effects.render();
    }
}
export function activeTasks(): Task[] {
    return tasksState.tasks.filter((task) => task.status === "active");
}
export function completedTasks(): Task[] {
    return tasksState.tasks.filter((task) => task.status === "completed");
}
export function completedTodayTasks(): Task[] {
    const today = new Date();
    return completedTasks().filter((task) => isSameLocalDay(task.completedAt, today));
}
export function renderTask(task: Task, index: number, completed = false): string {
    const isEditing = tasksState.editingTaskId === task.id;
    const position = String(index + 1).padStart(2, "0");
    const title = isEditing
        ? `<form class="rename-form" data-rename-form="${task.id}">
        <input class="rename-input" name="title" aria-label="${t("Новое название задачи")}" value="${escapeHtml(task.title)}" required />
      </form>`
        : `<span class="task-title">${escapeHtml(task.title)}</span>`;
    return `
    <li class="task-row ${completed ? "is-completed" : ""} ${remindersState.highlightedReminderTaskId === task.id ? "is-reminder-highlighted" : ""} ${taskAnimationLocks.has(task.id) ? "is-task-animating" : ""}" data-task-id="${task.id}" data-reorderable="${!completed}" ${completed ? "" : `tabindex="0" aria-keyshortcuts="${settingsState.shortcuts.move_up} ${settingsState.shortcuts.move_down} ${settingsState.shortcuts.rename}" aria-label="${escapeHtml(task.title)}. ${escapeHtml(displayShortcut(settingsState.shortcuts.move_up))} ${t("и")} ${escapeHtml(displayShortcut(settingsState.shortcuts.move_down))} ${t("меняют порядок.")} ${escapeHtml(displayShortcut(settingsState.shortcuts.rename))} ${t("изменяет название.")}"`}>
      <span class="task-position ${completed ? "completed-position" : ""}" data-position="${position}" aria-label="${t("Задача")} ${index + 1}"><span class="position-old" aria-hidden="true"></span><span class="position-current">${position}</span></span>
      <button class="task-check ${completed ? "checked" : ""}" type="button"
        data-toggle-task="${task.id}" aria-label="${completed ? t("Вернуть в очередь") : t("Отметить выполненной")} — ${escapeHtml(task.title)}"
        aria-pressed="${completed}" ${tasksState.saving || taskAnimationLocks.has(task.id) ? "disabled" : ""}>
        <span aria-hidden="true">${completed ? "✓" : ""}</span>
      </button>
      <div class="task-content">${title}</div>
      ${completed ? "" : `<button class="reminder-button ${task.reminderAt !== null ? "has-reminder" : ""}" type="button" data-edit-reminder="${task.id}" aria-label="${task.reminderAt !== null ? `${t("Изменить напоминание:")} ${escapeHtml(task.title)}` : `${t("Добавить напоминание:")} ${escapeHtml(task.title)}`}">${task.reminderAt !== null ? `<time>${new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(task.reminderAt)}</time>` : "◷"}</button>`}
      <button class="task-delete" type="button" data-delete-task="${task.id}" aria-label="${t("Удалить задачу:")} ${escapeHtml(task.title)}" title="${t("Удалить задачу")}" ${tasksState.saving || taskAnimationLocks.has(task.id) ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>
    </li>`;
}
export async function refreshTasks(): Promise<void> {
    try {
        tasksState.tasks = await invoke("list_tasks");
        tasksState.errorMessage = "";
        tasksState.loadFailed = false;
    }
    catch (error) {
        tasksState.errorMessage = backendMessage(error);
        tasksState.loadFailed = true;
    }
    finally {
        tasksState.loading = false;
        effects.render();
    }
}
export function bindTasksEvents(scope: ParentNode): void {
    scope.querySelector<HTMLButtonElement>("[data-retry-load]")?.addEventListener("click", () => {
        tasksState.loading = true;
        tasksState.errorMessage = "";
        effects.render();
        void refreshTasks();
    });
    scope.querySelector<HTMLFormElement>("#quick-add-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = root.querySelector<HTMLInputElement>("#new-task-title");
        const title = input?.value.trim() ?? "";
        if (!title) {
            tasksState.errorMessage = t("Введите название задачи.");
            effects.render();
            root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
            return;
        }
        void createTask(title);
    });
    scope.querySelectorAll<HTMLButtonElement>("[data-toggle-task]").forEach((button) => {
        button.addEventListener("click", () => {
            if (tasksState.saving)
                return;
            const task = tasksState.tasks.find((item) => item.id === button.dataset.toggleTask);
            if (!task)
                return;
            if (task.status === "active") {
                const row = button.closest<HTMLLIElement>(".task-row");
                if (row)
                    void completeTaskWithAnimation(task, row, button);
            }
            else {
                const row = button.closest<HTMLLIElement>(".task-row");
                if (row)
                    void reopenTaskWithAnimation(task, row, button);
            }
        });
    });
    scope.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
        row.querySelector<HTMLElement>(".task-content")?.addEventListener("dblclick", () => {
            if (tasksState.saving || taskAnimationLocks.has(row.dataset.taskId ?? "") || tasksState.editingTaskId === row.dataset.taskId)
                return;
            tasksState.editingTaskId = row.dataset.taskId ?? null;
            tasksState.errorMessage = "";
            effects.render();
        });
    });
    scope.querySelectorAll<HTMLFormElement>("[data-rename-form]").forEach((form) => {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const taskId = form.dataset.renameForm;
            const input = form.querySelector<HTMLInputElement>("[name=title]");
            const title = input?.value.trim() ?? "";
            if (!taskId || !title) {
                tasksState.errorMessage = t("Введите название задачи.");
                effects.render();
                return;
            }
            void effects.perform(() => invoke("rename_task", { id: taskId, title }));
        });
        form.querySelector<HTMLInputElement>(".rename-input")?.addEventListener("keydown", (event) => {
            if (event.key !== "Escape")
                return;
            event.preventDefault();
            const taskId = form.dataset.renameForm;
            tasksState.editingTaskId = null;
            effects.render();
            if (taskId)
                root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`)?.focus();
        });
    });
    scope.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
        row.addEventListener("pointerdown", (event) => {
            if (tasksState.saving || tasksState.mouseDragActive || taskAnimationLocks.size || event.button !== 0 || (event.target as HTMLElement).closest("button, input, a"))
                return;
            tasksState.taskPointerHeld = true;
            const list = row.closest<HTMLOListElement>(".task-list")!;
            const original = [...list.querySelectorAll<HTMLLIElement>(".task-row")];
            const originalIds = original.map((item) => item.dataset.taskId!);
            let ordered = [...original];
            let preview: HTMLElement | null = null;
            let x = event.clientX, y = event.clientY;
            let frame = 0;
            const bounds = row.getBoundingClientRect();
            const offsetX = x - bounds.left, offsetY = y - bounds.top;
            const animations = new Map<HTMLElement, Animation>();
            const arrange = (): void => {
                const before = new Map(original.map((item) => [item, item.getBoundingClientRect()]));
                for (const animation of animations.values())
                    animation.cancel();
                ordered.forEach((item, index) => {
                    item.style.order = String(index);
                    const number = item.querySelector<HTMLElement>(".position-current");
                    if (number)
                        number.textContent = String(index + 1).padStart(2, "0");
                    item.querySelector("[data-position]")?.setAttribute("aria-label", `${t("Задача")} ${index + 1}`);
                });
                if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
                    for (const item of original) {
                        if (item === row)
                            continue;
                        const previous = before.get(item)!;
                        const next = item.getBoundingClientRect();
                        animations.set(item, item.animate([{ transform: `translateY(${previous.top - next.top}px)` }, { transform: "translateY(0)" }], { duration: 200, easing: "ease-out" }));
                    }
            };
            original.forEach((item, index) => { item.style.order = String(index); });
            const tick = (): void => {
                if (!preview)
                    return;
                preview.style.left = `${Math.max(0, Math.min(window.innerWidth - bounds.width, x - offsetX))}px`;
                preview.style.top = `${Math.max(0, Math.min(window.innerHeight - bounds.height, y - offsetY))}px`;
                const listBounds = list.getBoundingClientRect();
                if (y > listBounds.bottom - 40)
                    list.scrollTop += 10;
                else if (y < listBounds.top + 40)
                    list.scrollTop -= 10;
                let targetIndex = ordered.indexOf(row), distance = Infinity;
                for (const [index, item] of ordered.entries()) {
                    const d = Math.abs(y - (listBounds.top + item.offsetTop - list.scrollTop + item.offsetHeight / 2));
                    if (d < distance) {
                        distance = d;
                        targetIndex = index;
                    }
                }
                if (targetIndex !== ordered.indexOf(row)) {
                    ordered.splice(ordered.indexOf(row), 1);
                    ordered.splice(targetIndex, 0, row);
                    arrange();
                    const number = preview.querySelector<HTMLElement>(".position-current");
                    if (number)
                        number.textContent = String(targetIndex + 1).padStart(2, "0");
                }
                frame = requestAnimationFrame(tick);
            };
            const hold = window.setTimeout(() => {
                tasksState.mouseDragActive = true;
                window.getSelection()?.removeAllRanges();
                document.body.classList.add("is-task-dragging");
                row.setPointerCapture(event.pointerId);
                preview = row.cloneNode(true) as HTMLElement;
                preview.classList.add("task-drag-preview");
                preview.removeAttribute("data-task-id");
                preview.setAttribute("aria-hidden", "true");
                preview.style.width = `${bounds.width}px`;
                preview.style.height = `${bounds.height}px`;
                document.body.append(preview);
                row.classList.add("is-drag-source");
                tick();
            }, 180);
            const finish = (cancelled = false): void => {
                tasksState.taskPointerHeld = false;
                clearTimeout(hold);
                cancelAnimationFrame(frame);
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointercancel", cancel);
                window.removeEventListener("blur", cancel);
                window.removeEventListener("keydown", escape);
                if (row.hasPointerCapture(event.pointerId))
                    row.releasePointerCapture(event.pointerId);
                preview?.remove();
                row.classList.remove("is-drag-source");
                document.body.classList.remove("is-task-dragging");
                const didDrag = tasksState.mouseDragActive;
                tasksState.mouseDragActive = false;
                const ids = [...ordered.map((item) => item.dataset.taskId!), ...activeTasks().slice(originalIds.length).map((task) => task.id)];
                if (!cancelled && didDrag && ids.slice(0, originalIds.length).some((id, index) => id !== originalIds[index]))
                    void saveOrder(ids, ids.indexOf(row.dataset.taskId!));
                else {
                    ordered = [...original];
                    arrange();
                }
            };
            const move = (e: PointerEvent): void => { x = e.clientX; y = e.clientY; if (preview) {
                e.preventDefault();
                window.getSelection()?.removeAllRanges();
            } };
            const up = (): void => finish();
            const cancel = (): void => finish(true);
            const escape = (e: KeyboardEvent): void => { if (e.key === "Escape")
                finish(true); };
            window.addEventListener("pointermove", move, { passive: false });
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", cancel);
            window.addEventListener("blur", cancel);
            window.addEventListener("keydown", escape);
        });
    });
}
export async function saveOrder(ids: string[], movedIndex: number): Promise<void> {
    const movedId = ids[movedIndex];
    const saved = await effects.perform(() => invoke("reorder_tasks", { ids }));
    if (!saved)
        return;
    const index = activeTasks().findIndex((task) => task.id === movedId);
    if (index >= 0) {
        announce(`${t("Задача перемещена на позицию")} ${index + 1} ${t("из")} ${activeTasks().length}.`);
    }
    effects.render();
    if (index >= 0)
        focusTaskWhenRendered(movedId);
}
type Effects = {
    render: typeof import("../../app/view.ts").render;
    perform: typeof import("../../app/view.ts").perform;
};
let effects: Effects;
export function configureTasks(callbacks: Effects): void { effects = callbacks; }
