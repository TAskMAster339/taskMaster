import { formatTime, monthStart, parseLocalDate, toLocalDateString } from "../../shared/dates.ts";
import { escapeHtml } from "../../shared/dom.ts";
import { backendMessage } from "../../shared/errors.ts";
import { locale, t } from "../../shared/i18n.ts";
import { invoke } from "../../shared/tauri.ts";
import { type HistoryTask } from "../../shared/types.ts";
import { remindersState } from "../reminders/state.ts";
import { tasksState } from "../tasks/state.ts";
import { historyState } from "./state.ts";
export function renderCalendar(): string {
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const first = monthStart(historyState.calendarMonth);
    const dayOffset = (first.getDay() + 6) % 7;
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const leadingCells = "<span class=\"calendar-empty\" aria-hidden=\"true\"></span>".repeat(dayOffset);
    const dayCells = Array.from({ length: days }, (_, index) => {
        const date = new Date(first.getFullYear(), first.getMonth(), index + 1);
        const value = toLocalDateString(date);
        const disabled = date > todayStart;
        const isToday = value === toLocalDateString(todayStart);
        const hasTasks = historyState.createdTaskDays.has(value);
        return `<button class="calendar-day ${value === historyState.selectedHistoryDate ? "is-selected" : ""} ${hasTasks ? "has-tasks" : ""}" type="button" data-calendar-date="${value}" aria-label="${new Intl.DateTimeFormat(locale(), { dateStyle: "full" }).format(date)}${isToday ? `, ${t("сегодня")}` : ""}${hasTasks ? `, ${t("есть задачи")}` : ""}" ${isToday ? 'aria-current="date"' : ""} ${value === historyState.selectedHistoryDate ? 'aria-pressed="true"' : ""} ${disabled ? "disabled" : ""}><span>${date.getDate()}</span></button>`;
    }).join("");
    const trailingCells = "<span class=\"calendar-empty\" aria-hidden=\"true\"></span>".repeat(42 - dayOffset - days);
    const cells = `${leadingCells}${dayCells}${trailingCells}`;
    const nextMonthDisabled = first.getFullYear() === today.getFullYear() && first.getMonth() >= today.getMonth();
    return `<section class="history-calendar" aria-label="${t("Календарь истории")}">
    <div class="calendar-heading"><button type="button" data-calendar-shift="-1" aria-label="${t("Предыдущий месяц")}">←</button><h2>${new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" }).format(first)}</h2><button type="button" data-calendar-shift="1" aria-label="${t("Следующий месяц")}" ${nextMonthDisabled ? "disabled" : ""}>→</button></div>
    <div class="calendar-grid calendar-weekdays" aria-hidden="true">${[t("Пн"), t("Вт"), t("Ср"), t("Чт"), t("Пт"), t("Сб"), t("Вс")].map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="calendar-grid">${cells}</div>
  </section>`;
}
export function renderHistoryColumn(title: string, items: HistoryTask[], type: "completed" | "archived"): string {
    const list = historyState.historyLoading
        ? `<li class="history-empty">${t("Загружаем…")}</li>`
        : items.length
            ? items.map(({ task, occurredAt, createdAt }) => `<li class="history-task-row ${remindersState.highlightedReminderTaskId === task.id ? "is-reminder-highlighted" : ""}" data-task-id="${task.id}">
          <span class="history-task-copy"><span class="history-task-title">${escapeHtml(task.title)}</span></span>
          <time>${formatTime(type === "completed" ? occurredAt : createdAt)}</time>
          ${type === "archived" && task.status === "archived" ? `<button class="history-restore" type="button" data-restore-task="${task.id}" aria-label="${t("Восстановить задачу:")} ${escapeHtml(task.title)}">↶</button>` : ""}
          <button class="task-delete" type="button" data-purge-task="${task.id}" aria-label="${t("Удалить навсегда:")} ${escapeHtml(task.title)}" title="${t("Удалить навсегда")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button>
        </li>`).join("")
            : `<li class="history-empty">${t("Нет задач")}</li>`;
    return `<section class="history-column history-column-${type}" aria-labelledby="history-${type}-title">
    <div class="history-column-heading"><h2 id="history-${type}-title">${title}</h2><span>${items.length}</span></div>
    <ul class="history-task-list">${list}</ul>
  </section>`;
}
export function renderHistoryLists(): string {
    return `<div class="history-columns">${renderHistoryColumn(t("Выполнено"), historyState.historyDay.completed, "completed")}${renderHistoryColumn(t("Архив"), historyState.historyDay.archived, "archived")}</div>`;
}
export async function refreshHistory(): Promise<void> {
    historyState.historyLoading = true;
    historyState.historyDay = { completed: [], archived: [] };
    historyState.createdTaskDays = new Set();
    tasksState.errorMessage = "";
    effects.render(true);
    try {
        const selected = parseLocalDate(historyState.selectedHistoryDate);
        const start = selected.getTime();
        const end = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() + 1).getTime();
        const month = monthStart(historyState.calendarMonth);
        const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime();
        const [day, creationTimes] = await Promise.all([
            invoke("list_history_for_range", { start, end }),
            invoke("list_task_creation_times", { start: month.getTime(), end: monthEnd }),
        ]);
        historyState.historyDay = day;
        historyState.createdTaskDays = new Set(creationTimes.map((timestamp) => toLocalDateString(new Date(timestamp))));
        tasksState.errorMessage = "";
    }
    catch (error) {
        tasksState.errorMessage = backendMessage(error);
    }
    finally {
        historyState.historyLoading = false;
        effects.render(true);
    }
}
export function bindHistoryEvents(scope: ParentNode): void {
    scope.querySelectorAll<HTMLButtonElement>("[data-calendar-date]").forEach((button) => {
        button.addEventListener("click", () => {
            const value = button.dataset.calendarDate;
            if (!value)
                return;
            historyState.selectedHistoryDate = value;
            historyState.calendarMonth = monthStart(parseLocalDate(value));
            effects.render(true);
            void refreshHistory();
        });
    });
    scope.querySelectorAll<HTMLButtonElement>("[data-calendar-shift]").forEach((button) => {
        button.addEventListener("click", () => {
            const shift = Number(button.dataset.calendarShift);
            const target = new Date(historyState.calendarMonth.getFullYear(), historyState.calendarMonth.getMonth() + shift, 1);
            const today = new Date();
            if (shift > 0 && (target.getFullYear() > today.getFullYear()
                || (target.getFullYear() === today.getFullYear() && target.getMonth() > today.getMonth())))
                return;
            historyState.calendarMonth = target;
            void refreshHistory();
        });
    });
    scope.querySelectorAll<HTMLButtonElement>("[data-restore-task]").forEach((button) => {
        button.addEventListener("click", async () => {
            const id = button.dataset.restoreTask;
            if (!id || tasksState.saving)
                return;
            const restored = await effects.perform(() => invoke("restore_task", { id }));
            if (restored)
                await refreshHistory();
        });
    });
}
type Effects = {
    render: typeof import("../../app/view.ts").render;
    perform: typeof import("../../app/view.ts").perform;
};
let effects: Effects;
export function configureHistory(callbacks: Effects): void { effects = callbacks; }
