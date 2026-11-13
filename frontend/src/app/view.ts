import { bindDeletionsEvents } from "../features/deletions/controller.ts";
import { bindHistoryEvents } from "../features/history/controller.ts";
import { historyState } from "../features/history/state.ts";
import { bindRemindersEvents } from "../features/reminders/controller.ts";
import { remindersState } from "../features/reminders/state.ts";
import { bindNotificationControls, bindSettingsEvents } from "../features/settings/controller.ts";
import { settingsState } from "../features/settings/state.ts";
import { bindTasksEvents, enteringTaskIds, taskAnimationLocks } from "../features/tasks/controller.ts";
import { tasksState } from "../features/tasks/state.ts";
import { bindTimersEvents } from "../features/timers/controller.ts";
import { timersState } from "../features/timers/state.ts";
import { appendInBatches } from "../shared/batches.ts";
import { parseLocalDate } from "../shared/dates.ts";
import { escapeHtml, root, skipLink } from "../shared/dom.ts";
import { backendMessage } from "../shared/errors.ts";
import { locale, t } from "../shared/i18n.ts";
import { type View } from "../shared/types.ts";
import { bindNavigationEvents } from "./navigation.ts";
import { appState } from "./state.ts";
export function renderSidebar(): string {
    const sections: {
        view: View;
        label: string;
        count?: number;
    }[] = [
        { view: "today", label: t("Сегодня"), count: effects.activeTasks().length },
        { view: "completed", label: t("Выполнено"), count: effects.completedTodayTasks().length },
        { view: "history", label: t("История") },
        { view: "timers", label: t("Таймеры") },
    ];
    return `<aside class="sidebar" aria-label="taskMaster"><nav class="navigation" aria-label="${t("Разделы")}">
    ${sections.map(({ view, label, count }, index) => `<a class="nav-item ${appState.activeView === view ? "is-current" : ""}" href="#${view}" data-view="${view}" ${appState.activeView === view ? 'aria-current="page"' : ""}><span class="nav-index">${String(index + 1).padStart(2, "0")}</span>${label}${count === undefined ? "" : `<span class="nav-count">${count}</span>`}</a>`).join("")}
  </nav><button class="theme-switch" type="button" data-view="settings" ${appState.activeView === "settings" ? 'aria-current="page"' : ""} aria-label="${t("Настройки")}"><span class="theme-icon" aria-hidden="true">⚙</span><span class="theme-copy">${t("Настройки")}</span></button></aside>`;
}
export function render(allowDuringAnimation = false): void {
    skipLink.href = `#${appState.activeView}`;
    if (tasksState.mouseDragActive)
        return;
    if (taskAnimationLocks.size > 0 && !allowDuringAnimation)
        return;
    tasksState.cancelListAppend();
    tasksState.cancelListAppend = () => { };
    if (appState.activeView !== "today" && appState.activeView !== "completed")
        tasksState.pendingTaskFocusId = null;
    if (appState.activeView === "settings") {
        effects.renderSettings();
        return;
    }
    if (appState.activeView === "timers") {
        effects.renderTimers();
        return;
    }
    if (timersState.timerAnimationFrame !== null) {
        cancelAnimationFrame(timersState.timerAnimationFrame);
        timersState.timerAnimationFrame = null;
    }
    if (remindersState.reminderEditingTaskId && !tasksState.tasks.some((task) => task.id === remindersState.reminderEditingTaskId && task.status === "active")) {
        remindersState.reminderEditingTaskId = null;
        if (remindersState.reminderReturn)
            remindersState.reminderReturn.restoreFocus = true;
    }
    const previousPositions = root.querySelector("main")?.id === appState.activeView ? effects.captureTaskPositions() : new Map<string, string>();
    const active = effects.activeTasks();
    const completedToday = effects.completedTodayTasks();
    const showingToday = appState.activeView === "today";
    const showingCompleted = appState.activeView === "completed";
    const showingHistory = appState.activeView === "history";
    const visibleTasks = showingToday ? active : completedToday;
    const historyCount = historyState.historyDay.completed.length + historyState.historyDay.archived.length;
    const headingDate = showingHistory ? parseLocalDate(historyState.selectedHistoryDate) : new Date();
    const headingDateLabel = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(headingDate);
    const taskList = showingHistory
        ? effects.renderHistoryLists()
        : tasksState.loading
            ? `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>${t("Загружаем очередь…")}</span></div>`
            : visibleTasks.length
                ? `<ol class="task-list ${showingToday ? "" : "completed-list"}" aria-label="${showingToday ? t("Очередь задач") : t("Выполненные сегодня задачи")}">${visibleTasks.slice(0, 32).map((task, index) => effects.renderTask(task, index, !showingToday)).join("")}</ol>`
                : tasksState.loadFailed
                    ? `<div class="empty-state load-error-state">
             <span class="empty-mark" aria-hidden="true">!</span>
             <strong>${showingToday ? t("Очередь недоступна") : t("Список недоступен")}</strong>
             <span>${t("Попробуйте загрузить задачи ещё раз.")}</span>
             <button class="retry-button" type="button" data-retry-load>${t("Повторить")}</button><button class="retry-button" type="button" data-view="settings">${t("Восстановление данных")}</button>
           </div>`
                    : `<div class="empty-state">
           <strong>${showingToday ? t("Задач пока нет") : t("Выполненных задач сегодня нет")}</strong>
         </div>`;
    const retainedList = remindersState.reminderReturn?.view === appState.activeView && remindersState.reminderReturn.signature === effects.reminderListSignature()
        ? root.querySelector<HTMLOListElement>(".task-list") : null;
    root.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}

      <main class="main-content ${showingToday ? "is-today-view" : showingHistory ? "is-history-view" : "is-completed-view"}" id="${appState.activeView}">
        <section class="day-heading" aria-labelledby="page-title">
          <div>
            <p class="eyebrow">${escapeHtml(headingDateLabel)} / ${new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric" }).format(headingDate)}</p>
            <h1 id="page-title">${showingToday ? `${t("План на день")}<span class="heading-period">.</span>` : showingHistory ? `${t("История")}<span class="heading-period">.</span>` : `${t("Выполнено")}<span class="heading-period">.</span>`}</h1>
          </div>
          <div class="day-actions">
            <div class="day-progress" aria-label="${showingHistory ? t("Задач за дату") : showingToday ? t("Активных") : t("Выполненных сегодня")} ${t("задач:")} ${showingHistory ? historyCount : visibleTasks.length}">
              <span class="progress-count">${String(showingHistory ? historyCount : visibleTasks.length).padStart(2, "0")}</span>
            </div>
            <button class="overlay-toggle" type="button" data-toggle-overlay>${t("Оверлей")}</button>
            ${settingsState.usesLinuxDesktop || settingsState.overlayShortcutAvailable ? "" : `<button class="overlay-shortcut-warning" type="button" data-open-overlay-shortcut>${t("Настроить клавишу")}</button>`}
          </div>
        </section>

        ${showingToday ? `<form class="quick-add" id="quick-add-form">
          <input id="new-task-title" name="title" type="text" autocomplete="off"
            placeholder="${t("Новая задача")}" aria-label="${t("Название новой задачи")}" ${tasksState.saving ? "disabled" : ""} />
          <kbd>ENTER <span aria-hidden="true">↵</span></kbd>
          <button class="add-button" type="submit" aria-label="${t("Добавить задачу")}" ${tasksState.saving ? "disabled" : ""}>＋</button>
        </form>` : ""}

        <p class="error-banner" role="alert" ${tasksState.errorMessage ? "" : "hidden"}>
          <span aria-hidden="true">!</span> ${escapeHtml(tasksState.errorMessage)}
        </p>

        <section class="queue-section" aria-labelledby="queue-title">
          <div class="section-heading" ${showingHistory ? "hidden" : ""}>
            <div class="section-title-wrap">
              <h2 id="queue-title">${showingToday ? t("Очередь") : showingCompleted ? t("Сегодня") : ""}</h2>
            </div>
          </div>
          ${showingHistory ? `<div class="history-list-container">${historyState.historyLoading ? `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>${t("Загружаем список…")}</span></div>` : taskList}</div>` : taskList}
        </section>
        ${showingHistory ? effects.renderCalendar() : ""}
        ${settingsState.overlayShortcutDialogOpen ? `<dialog class="reminder-dialog" data-overlay-shortcut-dialog aria-labelledby="overlay-shortcut-heading"><form data-overlay-shortcut-form><h2 id="overlay-shortcut-heading">${t("Горячая клавиша")}</h2><label for="overlay-shortcut-input">${t("Сочетание клавиш")}</label><input id="overlay-shortcut-input" name="shortcut" type="text" value="${escapeHtml(settingsState.overlayShortcut)}" placeholder="Ctrl+Shift+O" required aria-describedby="overlay-shortcut-help"/><small id="overlay-shortcut-help">${t("Например: Ctrl+Shift+O")}</small><p class="reminder-dialog-error" role="alert">${escapeHtml(settingsState.overlayShortcutError)}</p><div class="reminder-actions"><button type="button" data-close-overlay-shortcut>${t("Отмена")}</button><button type="submit">${t("Сохранить")}</button></div></form></dialog>` : ""}

      </main>

    </div>`;
    bindEvents();
    if (retainedList) {
        effects.updateRetainedReminder(retainedList);
        root.querySelector(".task-list")?.replaceWith(retainedList);
    }
    effects.animatePositionChanges(previousPositions);
    const list = root.querySelector<HTMLOListElement>(".task-list");
    const firstPending = list?.children.length ?? 0;
    if (list && visibleTasks.length > firstPending && !showingHistory) {
        const schedule = (callback: () => void): void => {
            requestAnimationFrame(() => { if (tasksState.mouseDragActive || tasksState.taskPointerHeld)
                schedule(callback);
            else
                callback(); });
        };
        tasksState.cancelListAppend = appendInBatches(visibleTasks.slice(firstPending), (batch, start) => {
            const template = document.createElement("template");
            template.innerHTML = batch.map((task, index) => effects.renderTask(task, start + firstPending + index, !showingToday)).join("");
            bindEvents(template.content);
            effects.animatePositionChanges(previousPositions, template.content);
            const rename = template.content.querySelector<HTMLInputElement>(".rename-input");
            const entering = batch.find((task) => enteringTaskIds.has(task.id));
            list.append(template.content);
            effects.restoreReminderPosition(list, list.children.length === visibleTasks.length);
            if (rename) {
                rename.focus();
                rename.select();
            }
            if (tasksState.pendingTaskFocusId && batch.some((task) => task.id === tasksState.pendingTaskFocusId))
                effects.focusTaskWhenRendered(tasksState.pendingTaskFocusId);
            if (entering)
                list.querySelector<HTMLElement>(`[data-task-id="${entering.id}"]`)?.scrollIntoView({ block: "nearest" });
            effects.animateEnteringTasks();
        }, schedule);
    }
    effects.animateEnteringTasks();
    if (tasksState.pendingTaskFocusId && root.querySelector(`[data-task-id="${CSS.escape(tasksState.pendingTaskFocusId)}"]`))
        effects.focusTaskWhenRendered(tasksState.pendingTaskFocusId);
    effects.renderReminderDialog();
    effects.restoreReminderPosition(list, !list || list.children.length === visibleTasks.length);
    const shortcutDialog = root.querySelector<HTMLDialogElement>("[data-overlay-shortcut-dialog]");
    if (shortcutDialog && !shortcutDialog.open)
        shortcutDialog.showModal();
    if (tasksState.editingTaskId) {
        const input = root.querySelector<HTMLInputElement>(".rename-input");
        input?.focus();
        input?.select();
    }
}
export async function perform(action: () => Promise<unknown>): Promise<boolean> {
    tasksState.saving = true;
    tasksState.errorMessage = "";
    render();
    try {
        await action();
        tasksState.editingTaskId = null;
        await effects.refreshTasks();
        return !tasksState.loadFailed;
    }
    catch (error) {
        tasksState.errorMessage = backendMessage(error);
        tasksState.saving = false;
        render();
        return false;
    }
    finally {
        tasksState.saving = false;
        render();
    }
}
export function bindEvents(scope: ParentNode = root): void {
    bindDeletionsEvents(scope);
    if (scope === root)
        bindNotificationControls();
    bindTimersEvents(scope);
    bindRemindersEvents(scope);
    bindNavigationEvents(scope);
    bindHistoryEvents(scope);
    bindSettingsEvents(scope);
    bindTasksEvents(scope);
}
type Effects = {
    activeTasks: typeof import("../features/tasks/controller.ts").activeTasks;
    completedTodayTasks: typeof import("../features/tasks/controller.ts").completedTodayTasks;
    renderSettings: typeof import("../features/settings/controller.ts").renderSettings;
    renderTimers: typeof import("../features/timers/controller.ts").renderTimers;
    captureTaskPositions: typeof import("../features/tasks/controller.ts").captureTaskPositions;
    renderHistoryLists: typeof import("../features/history/controller.ts").renderHistoryLists;
    renderTask: typeof import("../features/tasks/controller.ts").renderTask;
    reminderListSignature: typeof import("../features/reminders/controller.ts").reminderListSignature;
    renderCalendar: typeof import("../features/history/controller.ts").renderCalendar;
    updateRetainedReminder: typeof import("../features/reminders/controller.ts").updateRetainedReminder;
    animatePositionChanges: typeof import("../features/tasks/controller.ts").animatePositionChanges;
    restoreReminderPosition: typeof import("../features/reminders/controller.ts").restoreReminderPosition;
    focusTaskWhenRendered: typeof import("../features/tasks/controller.ts").focusTaskWhenRendered;
    animateEnteringTasks: typeof import("../features/tasks/controller.ts").animateEnteringTasks;
    renderReminderDialog: typeof import("../features/reminders/controller.ts").renderReminderDialog;
    refreshTasks: typeof import("../features/tasks/controller.ts").refreshTasks;
};
let effects: Effects;
export function configureView(callbacks: Effects): void { effects = callbacks; }
