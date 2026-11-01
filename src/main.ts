import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type TaskStatus = "active" | "completed" | "archived";
type Theme = "system" | "dark" | "light";

const themeStorageKey = "taskmaster.theme";
const themeOrder: Theme[] = ["system", "dark", "light"];
const themeLabels: Record<Theme, string> = { system: "Системная", dark: "Тёмная", light: "Светлая" };

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  archivedAt: number | null;
  reminderAt: number | null;
  reminderState: "pending" | "fired" | "missed" | null;
}

interface Timer { id: string; name: string; durationSeconds: number; remainingSeconds: number; status: "ready" | "running" | "paused" | "finished"; }

interface HistoryTask {
  task: Task;
  occurredAt: number;
  createdAt: number;
}

interface HistoryDay {
  completed: HistoryTask[];
  archived: HistoryTask[];
}

interface BackendError {
  code?: string;
  message?: string;
}

const root: HTMLDivElement = document.querySelector<HTMLDivElement>("#app") ?? (() => {
  throw new Error("Application root was not found");
})();

let tasks: Task[] = [];
let loading = true;
let saving = false;
let errorMessage = "";
let loadFailed = false;
let editingTaskId: string | null = null;
let mouseDragActive = false;
const taskAnimationLocks = new Set<string>();
const taskAnimationErrors: string[] = [];
let announcement = "";
let theme: Theme = readTheme();
type View = "today" | "completed" | "history" | "timers";
let activeView: View = window.location.hash === "#completed" ? "completed" : window.location.hash === "#history" ? "history" : window.location.hash === "#timers" ? "timers" : "today";
let historyDay: HistoryDay = { completed: [], archived: [] };
let createdTaskDays = new Set<string>();
let historyLoading = false;
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
let selectedHistoryDate = toLocalDateString(yesterday);
let calendarMonth = monthStart(parseLocalDate(selectedHistoryDate));
const enteringTaskIds = new Set<string>();
let reminderEditingTaskId: string | null = null;
let reminderDialogError = "";
let highlightedReminderTaskId: string | null = null;
let timers: Timer[] = [];
const timerSnapshots = new Map<string, { remainingSeconds: number; sampledAt: number; status: Timer["status"] }>();
let timerAnimationFrame: number | null = null;
let timerDialogOpen = false;
let timerError = "";
let fullscreenTimerId: string | null = null;

function reminderInputValue(timestamp: number | null): string {
  if (timestamp === null) return defaultReminderTimeValue();
  return formatReminderTime(new Date(timestamp));
}

function formatReminderTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function defaultReminderTimeValue(now = new Date()): string {
  const reminderDate = new Date(now);
  const needsNextMinute = now.getSeconds() > 0 || now.getMilliseconds() > 0;
  reminderDate.setSeconds(0, 0);
  reminderDate.setMinutes(reminderDate.getMinutes() + 15 + Number(needsNextMinute));
  if (reminderDate.getFullYear() !== now.getFullYear()
    || reminderDate.getMonth() !== now.getMonth()
    || reminderDate.getDate() !== now.getDate()) return "";
  return formatReminderTime(reminderDate);
}

function todayTimestampForTime(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  const reminderDate = new Date();
  reminderDate.setHours(hours, minutes, 0, 0);
  return reminderDate.getTime();
}

function waitForMotion(milliseconds: number): Promise<void> {
  const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : milliseconds;
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}

function formatTimerTime(seconds: number): string {
  const remaining = Math.max(0, seconds);
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const secondsPart = remaining % 60;
  return [hours, minutes, secondsPart].map((part) => String(part).padStart(2, "0")).join(":");
}

function timerSecondsFromForm(form: HTMLFormElement): number {
  const values = new FormData(form);
  const hours = Number(values.get("hours")); const minutes = Number(values.get("minutes")); const seconds = Number(values.get("seconds"));
  return hours * 3600 + minutes * 60 + seconds;
}

function synchronizeTimerSnapshots(nextTimers: Timer[]): void {
  const now = performance.now();
  const activeIds = new Set(nextTimers.map((timer) => timer.id));
  for (const id of timerSnapshots.keys()) if (!activeIds.has(id)) timerSnapshots.delete(id);

  for (const timer of nextTimers) {
    const previous = timerSnapshots.get(timer.id);
    if (!previous || previous.status !== timer.status || timer.status !== "running") {
      timerSnapshots.set(timer.id, { remainingSeconds: timer.remainingSeconds, sampledAt: now, status: timer.status });
      continue;
    }

    const estimated = Math.max(0, previous.remainingSeconds - (now - previous.sampledAt) / 1_000);
    if (Math.abs(estimated - timer.remainingSeconds) > 1.5) {
      timerSnapshots.set(timer.id, { remainingSeconds: timer.remainingSeconds, sampledAt: now, status: timer.status });
    }
  }
}

function updateTimerVisuals(now: number): void {
  if (activeView !== "timers") return;
  const circumference = 2 * Math.PI * 86;

  for (const timer of timers) {
    const snapshot = timerSnapshots.get(timer.id);
    if (!snapshot) continue;
    const remaining = snapshot.status === "running"
      ? Math.max(0, snapshot.remainingSeconds - (now - snapshot.sampledAt) / 1_000)
      : snapshot.remainingSeconds;
    const card = root.querySelector<HTMLElement>(`[data-timer-card="${CSS.escape(timer.id)}"]`);
    const clock = card?.querySelector<HTMLElement>("[data-timer-clock]");
    if (clock) clock.textContent = formatTimerTime(Math.ceil(remaining));
    const progress = card?.querySelector<SVGCircleElement>(".timer-ring-progress");
    if (progress) {
      const ratio = timer.durationSeconds > 0 ? Math.min(1, remaining / timer.durationSeconds) : 0;
      progress.style.strokeDashoffset = String(circumference * (1 - ratio));
    }
  }
}

function animateTimerFrames(): void {
  if (timerAnimationFrame !== null || !timers.some((timer) => timer.status === "running")) return;
  const tick = (now: number): void => {
    timerAnimationFrame = null;
    if (activeView !== "timers" || !timers.some((timer) => timer.status === "running")) return;
    updateTimerVisuals(now);
    timerAnimationFrame = requestAnimationFrame(tick);
  };
  timerAnimationFrame = requestAnimationFrame(tick);
}

function captureTaskPositions(): Map<string, string> {
  const positions = new Map<string, string>();
  root.querySelectorAll<HTMLLIElement>('.task-row[data-reorderable="true"]').forEach((row) => {
    const id = row.dataset.taskId;
    const label = row.querySelector<HTMLElement>(".task-position");
    const oldPosition = label?.classList.contains("is-changing") ? label.querySelector<HTMLElement>(".position-old")?.textContent : "";
    const position = oldPosition || label?.dataset.position;
    if (id && position) positions.set(id, position);
  });
  return positions;
}

function animatePositionChanges(previous: Map<string, string>): void {
  root.querySelectorAll<HTMLLIElement>('.task-row[data-reorderable="true"]').forEach((row) => {
    const oldPosition = previous.get(row.dataset.taskId ?? "");
    const position = row.querySelector<HTMLElement>(".task-position");
    if (!oldPosition || !position || oldPosition === position.dataset.position) return;
    const oldValue = position.querySelector<HTMLElement>(".position-old");
    if (!oldValue) return;
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

function animateEnteringTasks(): void {
  enteringTaskIds.forEach((id) => {
    const row = root.querySelector<HTMLLIElement>(`.task-row[data-task-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.add("is-entering");
    const finish = (): void => {
      row.classList.remove("is-entering");
      enteringTaskIds.delete(id);
    };
    row.querySelector<HTMLElement>(".task-title")?.addEventListener("animationend", finish, { once: true });
    window.setTimeout(finish, 900);
  });
}

async function completeTaskWithAnimation(task: Task, row: HTMLLIElement, button: HTMLButtonElement): Promise<void> {
  if (saving || taskAnimationLocks.has(task.id)) return;
  taskAnimationLocks.add(task.id);
  row.classList.add("is-task-animating");
  errorMessage = "";
  button.disabled = true;
  button.classList.add("checked", "is-checking");
  button.setAttribute("aria-pressed", "true");
  button.setAttribute("aria-label", `Выполнена — ${task.title}`);
  const mark = button.querySelector<HTMLElement>("span");
  if (mark) mark.textContent = "✓";
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
  try { await invoke("complete_task", { id: task.id }); }
  catch (error) { operationError = error; }
  await finishTaskAnimation(task.id, operationError);
}

async function reopenTaskWithAnimation(task: Task, row: HTMLLIElement, button: HTMLButtonElement): Promise<void> {
  if (saving || taskAnimationLocks.has(task.id)) return;
  taskAnimationLocks.add(task.id);
  row.classList.add("is-task-animating");
  button.disabled = true;
  button.classList.remove("checked");
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", `Вернуть в очередь — ${task.title}`);
  const mark = button.querySelector<HTMLElement>("span");
  if (mark) mark.textContent = "";
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
  try { await invoke("reopen_task", { id: task.id }); }
  catch (error) { operationError = error; }
  await finishTaskAnimation(task.id, operationError);
}

async function finishTaskAnimation(taskId: string, operationError?: unknown): Promise<void> {
  taskAnimationLocks.delete(taskId);
  if (operationError !== undefined) taskAnimationErrors.push(backendMessage(operationError));
  if (taskAnimationLocks.size > 0) return;
  await refreshTasks();
  if (taskAnimationErrors.length) {
    errorMessage = taskAnimationErrors.splice(0).join(" ");
    render();
  }
}

async function createTask(title: string): Promise<void> {
  if (saving) return;
  saving = true;
  errorMessage = "";
  render();
  try {
    const created = await invoke<Task>("create_task", { title });
    enteringTaskIds.add(created.id);
    saving = false;
    await refreshTasks();
    if (activeView === "today" && !loadFailed) {
      root.querySelector<HTMLElement>(".task-list")?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" });
    } else {
      enteringTaskIds.delete(created.id);
    }
  } catch (error) {
    saving = false;
    errorMessage = backendMessage(error);
    render();
  }
}

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(themeStorageKey);
    return themeOrder.includes(value as Theme) ? value as Theme : "system";
  } catch {
    return "system";
  }
}

function applyTheme(): void {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  document.documentElement.dataset.themeMode = theme;
}

function updateThemeButton(): void {
  const button = root.querySelector<HTMLButtonElement>("[data-theme-switch]");
  if (!button) return;
  button.setAttribute("aria-label", `Тема: ${themeLabels[theme]}. Нажмите, чтобы сменить`);
  button.querySelector(".theme-label")!.textContent = themeLabels[theme];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function backendMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as BackendError).message;
    if (typeof message === "string") return message;
  }
  return "Не удалось сохранить изменения. Попробуйте ещё раз.";
}

function activeTasks(): Task[] {
  return tasks.filter((task) => task.status === "active");
}

function completedTasks(): Task[] {
  return tasks.filter((task) => task.status === "completed");
}

function isSameLocalDay(timestamp: number | null, date: Date): boolean {
  if (timestamp === null) return false;
  const taskDate = new Date(timestamp);
  return taskDate.getFullYear() === date.getFullYear()
    && taskDate.getMonth() === date.getMonth()
    && taskDate.getDate() === date.getDate();
}

function toLocalDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function renderCalendar(): string {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const first = monthStart(calendarMonth);
  const dayOffset = (first.getDay() + 6) % 7;
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const leadingCells = "<span class=\"calendar-empty\" aria-hidden=\"true\"></span>".repeat(dayOffset);
  const dayCells = Array.from({ length: days }, (_, index) => {
    const date = new Date(first.getFullYear(), first.getMonth(), index + 1);
    const value = toLocalDateString(date);
    const disabled = date > todayStart;
    const isToday = value === toLocalDateString(todayStart);
    const hasTasks = createdTaskDays.has(value);
    return `<button class="calendar-day ${value === selectedHistoryDate ? "is-selected" : ""} ${hasTasks ? "has-tasks" : ""}" type="button" data-calendar-date="${value}" aria-label="${new Intl.DateTimeFormat("ru-RU", { dateStyle: "full" }).format(date)}${isToday ? ", сегодня" : ""}${hasTasks ? ", есть задачи" : ""}" ${isToday ? 'aria-current="date"' : ""} ${value === selectedHistoryDate ? 'aria-pressed="true"' : ""} ${disabled ? "disabled" : ""}><span>${date.getDate()}</span></button>`;
  }).join("");
  const trailingCells = "<span class=\"calendar-empty\" aria-hidden=\"true\"></span>".repeat(42 - dayOffset - days);
  const cells = `${leadingCells}${dayCells}${trailingCells}`;
  const nextMonthDisabled = first.getFullYear() === today.getFullYear() && first.getMonth() >= today.getMonth();
  return `<section class="history-calendar" aria-label="Календарь истории">
    <div class="calendar-heading"><button type="button" data-calendar-shift="-1" aria-label="Предыдущий месяц">←</button><h2>${new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(first)}</h2><button type="button" data-calendar-shift="1" aria-label="Следующий месяц" ${nextMonthDisabled ? "disabled" : ""}>→</button></div>
    <div class="calendar-grid calendar-weekdays" aria-hidden="true">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="calendar-grid">${cells}</div>
  </section>`;
}

function renderHistoryColumn(title: string, items: HistoryTask[], type: "completed" | "archived"): string {
  const list = historyLoading
    ? `<li class="history-empty">Загружаем…</li>`
    : items.length
      ? items.map(({ task, occurredAt, createdAt }) => `<li class="history-task-row ${highlightedReminderTaskId === task.id ? "is-reminder-highlighted" : ""}" data-task-id="${task.id}">
          <span class="history-task-copy"><span class="history-task-title">${escapeHtml(task.title)}</span></span>
          <time>${formatTime(type === "completed" ? occurredAt : createdAt)}</time>
          ${type === "archived" && task.status === "archived" ? `<button class="history-restore" type="button" data-restore-task="${task.id}" aria-label="Восстановить задачу: ${escapeHtml(task.title)}">↶</button>` : ""}
        </li>`).join("")
      : `<li class="history-empty">Нет задач</li>`;
  return `<section class="history-column history-column-${type}" aria-labelledby="history-${type}-title">
    <div class="history-column-heading"><h2 id="history-${type}-title">${title}</h2><span>${items.length}</span></div>
    <ul class="history-task-list">${list}</ul>
  </section>`;
}

function renderHistoryLists(): string {
  return `<div class="history-columns">${renderHistoryColumn("Выполнено", historyDay.completed, "completed")}${renderHistoryColumn("Архив", historyDay.archived, "archived")}</div>`;
}

function completedTodayTasks(): Task[] {
  const today = new Date();
  return completedTasks().filter((task) => isSameLocalDay(task.completedAt, today));
}

function renderTask(task: Task, index: number, completed = false): string {
  const isEditing = editingTaskId === task.id;
  const position = String(index + 1).padStart(2, "0");
  const title = isEditing
    ? `<form class="rename-form" data-rename-form="${task.id}">
        <input class="rename-input" name="title" aria-label="Новое название задачи" value="${escapeHtml(task.title)}" required />
      </form>`
    : `<span class="task-title">${escapeHtml(task.title)}</span>`;

  return `
    <li class="task-row ${completed ? "is-completed" : ""} ${highlightedReminderTaskId === task.id ? "is-reminder-highlighted" : ""} ${taskAnimationLocks.has(task.id) ? "is-task-animating" : ""}" data-task-id="${task.id}" data-reorderable="${!completed}" ${completed ? "" : `tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2" aria-label="${escapeHtml(task.title)}. Alt и стрелки вверх или вниз меняют порядок. F2 изменяет название."`}>
      <span class="task-position ${completed ? "completed-position" : ""}" data-position="${position}" aria-label="Задача ${index + 1}"><span class="position-old" aria-hidden="true"></span><span class="position-current">${position}</span></span>
      <button class="task-check ${completed ? "checked" : ""}" type="button"
        data-toggle-task="${task.id}" aria-label="${completed ? "Вернуть в очередь" : "Отметить выполненной"} — ${escapeHtml(task.title)}"
        aria-pressed="${completed}" ${saving || taskAnimationLocks.has(task.id) ? "disabled" : ""}>
        <span aria-hidden="true">${completed ? "✓" : ""}</span>
      </button>
      <div class="task-content">${title}</div>
      ${completed ? "" : `<button class="reminder-button ${task.reminderAt !== null ? "has-reminder" : ""}" type="button" data-edit-reminder="${task.id}" aria-label="${task.reminderAt !== null ? `Изменить напоминание: ${escapeHtml(task.title)}` : `Добавить напоминание: ${escapeHtml(task.title)}`}">${task.reminderAt !== null ? `<time>${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(task.reminderAt)}</time>` : "◷"}</button>`}
    </li>`;
}

function timerCard(timer: Timer, fullscreen = false): string {
  const progress = timer.durationSeconds > 0 ? timer.remainingSeconds / timer.durationSeconds : 0;
  const circumference = 2 * Math.PI * 86;
  const ring = `<svg class="timer-ring" viewBox="0 0 200 200" aria-hidden="true"><circle class="timer-ring-track" cx="100" cy="100" r="86"/><circle class="timer-ring-progress" cx="100" cy="100" r="86" style="stroke-dasharray:${circumference};stroke-dashoffset:${circumference * (1 - progress)}"/></svg>`;
  return `<article class="timer-card ${fullscreen ? "timer-card-focus" : ""}" data-timer-card="${timer.id}" data-timer-status="${timer.status}">
    <div class="timer-card-heading"><h2>${escapeHtml(timer.name)}</h2>${fullscreen ? '<button type="button" class="timer-exit-button" data-exit-fullscreen aria-label="Выйти из полноэкранного режима"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' : `<button type="button" data-timer-fullscreen="${timer.id}" aria-label="Открыть на весь экран">⛶</button>`}</div>
    <div class="timer-dial">${ring}<strong class="timer-clock" data-timer-clock>${formatTimerTime(timer.remainingSeconds)}</strong></div>
    <div class="timer-footer">
      ${timer.status === "finished" ? '<span class="timer-status" role="status">ЗАВЕРШЁН</span>' : ""}
      <div class="timer-controls">
        ${timer.status === "running" ? `<button type="button" data-timer-action="pause" data-timer-id="${timer.id}" aria-label="Пауза">Ⅱ</button>` : `<button type="button" data-timer-action="start" data-timer-id="${timer.id}" aria-label="${timer.status === "finished" ? "Запустить заново" : "Запустить"}">${timer.status === "finished" ? "↻" : "▶"}</button>`}
        <button type="button" data-timer-action="reset" data-timer-id="${timer.id}" aria-label="Сбросить таймер">↶</button>
        ${fullscreen ? "" : `<button type="button" class="timer-delete" data-timer-action="delete" data-timer-id="${timer.id}" aria-label="Удалить таймер">×</button>`}
      </div>
    </div>
  </article>`;
}

function renderTimers(): void {
  const focused = timers.find((timer) => timer.id === fullscreenTimerId);
  root.innerHTML = `<div class="app-shell ${focused ? "is-timer-fullscreen" : ""}">
    ${focused ? "" : `<aside class="sidebar" aria-label="taskMaster"><nav class="navigation" aria-label="Разделы">
      <a class="nav-item" href="#today" data-view="today"><span class="nav-index">01</span>Сегодня</a>
      <a class="nav-item" href="#completed" data-view="completed"><span class="nav-index">02</span>Выполнено</a>
      <a class="nav-item" href="#history" data-view="history"><span class="nav-index">03</span>История</a>
      <a class="nav-item is-current" href="#timers" data-view="timers" aria-current="page"><span class="nav-index">04</span>Таймеры</a>
    </nav><button class="theme-switch" type="button" data-theme-switch aria-label="Тема: ${themeLabels[theme]}. Нажмите, чтобы сменить"><span class="theme-icon" aria-hidden="true">◐</span><span class="theme-copy"><span class="theme-label">${themeLabels[theme]}</span></span></button></aside>`}
    <main class="main-content timer-view ${focused ? "timer-view-fullscreen" : ""}" id="timers">
      ${focused ? `${timerCard(focused, true)}<p class="error-banner" role="alert" ${timerError ? "" : "hidden"}>${escapeHtml(timerError)}</p>` : `<header class="timer-page-heading"><div><p class="eyebrow">ИНСТРУМЕНТЫ</p><h1>Таймеры<span class="heading-period">.</span></h1></div><button class="add-button timer-add-button" type="button" data-add-timer aria-label="Добавить таймер">＋</button></header>
      <p class="error-banner" role="alert" ${timerError ? "" : "hidden"}>${escapeHtml(timerError)}</p>
      <div class="timer-grid">${timers.length ? timers.map((timer) => timerCard(timer)).join("") : '<div class="empty-state"><strong>Таймеров пока нет</strong><button class="retry-button" type="button" data-add-timer>Добавить таймер</button></div>'}</div>
      ${timerDialogOpen ? `<dialog class="reminder-dialog timer-dialog" data-timer-dialog><form data-timer-form><h2>Добавить таймер</h2><label for="timer-hours">Длительность</label><div class="timer-duration-fields"><input id="timer-hours" type="number" name="hours" min="0" max="99" value="00" aria-label="Часы" required/><span>:</span><input type="number" name="minutes" min="0" max="59" value="00" aria-label="Минуты" required/><span>:</span><input type="number" name="seconds" min="0" max="59" value="00" aria-label="Секунды" required/></div><label for="timer-name">Название</label><input id="timer-name" name="name" type="text" maxlength="80" value="Таймер (${timers.length + 1})" required/><p class="reminder-dialog-error" role="alert">${escapeHtml(timerError)}</p><div class="reminder-actions"><button type="button" data-close-timer>Отмена</button><button type="submit">Сохранить</button></div></form></dialog>` : ""}`}
    </main><span class="visually-hidden" role="status" aria-live="polite">${escapeHtml(announcement)}</span></div>`;
  bindEvents();
  animateTimerFrames();
  const dialog = root.querySelector<HTMLDialogElement>("[data-timer-dialog]");
  if (dialog && !dialog.open) dialog.showModal();
}

function render(allowDuringAnimation = false): void {
  if (taskAnimationLocks.size > 0 && !allowDuringAnimation) return;
  if (activeView === "timers") { renderTimers(); return; }
  if (timerAnimationFrame !== null) {
    cancelAnimationFrame(timerAnimationFrame);
    timerAnimationFrame = null;
  }
  const previousPositions = captureTaskPositions();
  const active = activeTasks();
  const completedToday = completedTodayTasks();
  const showingToday = activeView === "today";
  const showingCompleted = activeView === "completed";
  const showingHistory = activeView === "history";
  const visibleTasks = showingToday ? active : completedToday;
  const historyCount = historyDay.completed.length + historyDay.archived.length;
  const headingDate = showingHistory ? parseLocalDate(selectedHistoryDate) : new Date();
  const headingDateLabel = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(headingDate);
  const taskList = showingHistory
    ? renderHistoryLists()
    : loading
    ? `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Загружаем очередь…</span></div>`
    : visibleTasks.length
      ? `<ol class="task-list ${showingToday ? "" : "completed-list"}" aria-label="${showingToday ? "Очередь задач" : "Выполненные сегодня задачи"}">${visibleTasks.map((task, index) => renderTask(task, index, !showingToday)).join("")}</ol>`
      : loadFailed
        ? `<div class="empty-state load-error-state">
             <span class="empty-mark" aria-hidden="true">!</span>
             <strong>${showingToday ? "Очередь недоступна" : "Список недоступен"}</strong>
             <span>Попробуйте загрузить задачи ещё раз.</span>
             <button class="retry-button" type="button" data-retry-load>Повторить</button>
           </div>`
        : `<div class="empty-state">
           <strong>${showingToday ? "Задач пока нет" : "Выполненных задач сегодня нет"}</strong>
         </div>`;

  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" aria-label="taskMaster">
        <nav class="navigation" aria-label="Разделы">
          <a class="nav-item ${showingToday ? "is-current" : ""}" href="#today" data-view="today" ${showingToday ? 'aria-current="page"' : ""}><span class="nav-index">01</span>Сегодня<span class="nav-count">${active.length}</span></a>
          <a class="nav-item ${showingCompleted ? "is-current" : ""}" href="#completed" data-view="completed" ${showingCompleted ? 'aria-current="page"' : ""}><span class="nav-index">02</span>Выполнено<span class="nav-count">${completedToday.length}</span></a>
          <a class="nav-item ${showingHistory ? "is-current" : ""}" href="#history" data-view="history" ${showingHistory ? 'aria-current="page"' : ""}><span class="nav-index">03</span>История</a>
          <a class="nav-item" href="#timers" data-view="timers"><span class="nav-index">04</span>Таймеры</a>
        </nav>
        <button class="theme-switch" type="button" data-theme-switch aria-label="Тема: ${themeLabels[theme]}. Нажмите, чтобы сменить">
          <span class="theme-icon" aria-hidden="true">◐</span><span class="theme-copy"><span class="theme-label">${themeLabels[theme]}</span></span>
        </button>
      </aside>

      <main class="main-content ${showingToday ? "is-today-view" : showingHistory ? "is-history-view" : "is-completed-view"}" id="${activeView}">
        <section class="day-heading" aria-labelledby="page-title">
          <div>
            <p class="eyebrow">${escapeHtml(headingDateLabel)} / ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(headingDate)}</p>
            <h1 id="page-title">${showingToday ? 'План на день<span class="heading-period">.</span>' : showingHistory ? 'История<span class="heading-period">.</span>' : 'Выполнено<span class="heading-period">.</span>'}</h1>
          </div>
          <div class="day-progress" aria-label="${showingHistory ? "Задач за дату" : showingToday ? "Активных" : "Выполненных сегодня"} задач: ${showingHistory ? historyCount : visibleTasks.length}">
            <span class="progress-count">${String(showingHistory ? historyCount : visibleTasks.length).padStart(2, "0")}</span>
          </div>
        </section>

        ${showingToday ? `<form class="quick-add" id="quick-add-form">
          <input id="new-task-title" name="title" type="text" autocomplete="off"
            placeholder="Новая задача" aria-label="Название новой задачи" ${saving ? "disabled" : ""} />
          <kbd>ENTER <span aria-hidden="true">↵</span></kbd>
          <button class="add-button" type="submit" aria-label="Добавить задачу" ${saving ? "disabled" : ""}>＋</button>
        </form>` : ""}

        <p class="error-banner" role="alert" ${errorMessage ? "" : "hidden"}>
          <span aria-hidden="true">!</span> ${escapeHtml(errorMessage)}
        </p>

        <section class="queue-section" aria-labelledby="queue-title">
          <div class="section-heading" ${showingHistory ? "hidden" : ""}>
            <div class="section-title-wrap">
              <h2 id="queue-title">${showingToday ? "Очередь" : showingCompleted ? "Сегодня" : ""}</h2>
            </div>
          </div>
          ${showingHistory ? `<div class="history-list-container">${historyLoading ? '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Загружаем список…</span></div>' : taskList}</div>` : taskList}
        </section>
        ${showingHistory ? renderCalendar() : ""}
        ${reminderEditingTaskId ? (() => {
          const task = tasks.find((item) => item.id === reminderEditingTaskId);
          if (!task) return "";
          return `<dialog class="reminder-dialog" data-reminder-dialog><form data-reminder-form="${task.id}"><h2>Напоминание</h2><label for="reminder-time">Время сегодня</label><input id="reminder-time" name="reminderAt" type="time" step="60" required value="${reminderInputValue(task.reminderAt)}"/><p class="reminder-dialog-error" role="alert">${escapeHtml(reminderDialogError)}</p><div class="reminder-actions">${task.reminderAt !== null ? `<button type="button" data-clear-reminder="${task.id}">Удалить</button>` : ""}<button type="button" data-close-reminder>Отмена</button><button type="submit">Сохранить</button></div></form></dialog>`;
        })() : ""}

      </main>
      <span class="visually-hidden" role="status" aria-live="polite">${escapeHtml(announcement)}</span>
    </div>`;

  bindEvents();
  animatePositionChanges(previousPositions);
  animateEnteringTasks();
  const reminderDialog = root.querySelector<HTMLDialogElement>("[data-reminder-dialog]");
  if (reminderDialog && !reminderDialog.open) reminderDialog.showModal();
  if (editingTaskId) {
    const input = root.querySelector<HTMLInputElement>(".rename-input");
    input?.focus();
    input?.select();
  }
}

async function refreshTasks(): Promise<void> {
  try {
    tasks = await invoke<Task[]>("list_tasks");
    errorMessage = "";
    loadFailed = false;
  } catch (error) {
    errorMessage = backendMessage(error);
    loadFailed = true;
  } finally {
    loading = false;
    render();
  }
}

async function refreshTimers(shouldRender = true): Promise<void> {
  try {
    const previous = timers;
    const nextTimers = await invoke<Timer[]>("list_timers");
    synchronizeTimerSnapshots(nextTimers);
    timers = nextTimers;
    timerError = "";
    const changed = previous.length !== timers.length || timers.some((timer, index) => previous[index]?.id !== timer.id || previous[index]?.status !== timer.status);
    if (shouldRender && activeView === "timers") render(true);
    else if (changed && activeView === "timers") render(true);
  } catch (error) {
    timerError = backendMessage(error);
    if (shouldRender && activeView === "timers") render(true);
  }
}

async function refreshHistory(): Promise<void> {
  historyLoading = true;
  historyDay = { completed: [], archived: [] };
  createdTaskDays = new Set();
  errorMessage = "";
  render(true);
  try {
    const selected = parseLocalDate(selectedHistoryDate);
    const start = selected.getTime();
    const end = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() + 1).getTime();
    const month = monthStart(calendarMonth);
    const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime();
    const [day, creationTimes] = await Promise.all([
      invoke<HistoryDay>("list_history_for_range", { start, end }),
      invoke<number[]>("list_task_creation_times", { start: month.getTime(), end: monthEnd }),
    ]);
    historyDay = day;
    createdTaskDays = new Set(creationTimes.map((timestamp) => toLocalDateString(new Date(timestamp))));
    errorMessage = "";
  } catch (error) {
    errorMessage = backendMessage(error);
  } finally {
    historyLoading = false;
    render(true);
  }
}

async function perform(action: () => Promise<unknown>): Promise<boolean> {
  saving = true;
  errorMessage = "";
  render();
  try {
    await action();
    editingTaskId = null;
    await refreshTasks();
    return !loadFailed;
  } catch (error) {
    errorMessage = backendMessage(error);
    saving = false;
    render();
    return false;
  } finally {
    saving = false;
    render();
  }
}

function bindEvents(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-add-timer]").forEach((button) => button.addEventListener("click", () => { timerError = ""; timerDialogOpen = true; render(true); }));
  root.querySelector<HTMLButtonElement>("[data-close-timer]")?.addEventListener("click", () => { timerDialogOpen = false; timerError = ""; render(true); });
  root.querySelector<HTMLDialogElement>("[data-timer-dialog]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) { timerDialogOpen = false; render(true); } });
  root.querySelector<HTMLDialogElement>("[data-timer-dialog]")?.addEventListener("cancel", () => { timerDialogOpen = false; });
  root.querySelector<HTMLFormElement>("[data-timer-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const name = String(new FormData(form).get("name") ?? "").trim();
    const durationSeconds = timerSecondsFromForm(form);
    if (!name || !durationSeconds || durationSeconds > 359_999) { timerError = "Укажите название и длительность от 1 секунды до 99 часов 59 минут 59 секунд."; render(true); return; }
    try {
      await invoke<Timer>("create_timer", { name, durationSeconds });
      timerDialogOpen = false;
      await refreshTimers();
    } catch (error) { timerError = backendMessage(error); render(true); }
  });
  root.querySelectorAll<HTMLButtonElement>("[data-timer-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.timerId; const action = button.dataset.timerAction;
    if (!id || !action) return;
    try {
      if (action === "delete") await invoke("delete_timer", { id });
      else if (action === "pause") await invoke("pause_timer", { id });
      else if (action === "reset") await invoke("reset_timer", { id });
      else {
        const timer = timers.find((item) => item.id === id);
        if (timer?.status === "finished") await invoke("reset_timer", { id });
        await invoke("start_timer", { id });
      }
      await refreshTimers();
    } catch (error) { timerError = backendMessage(error); render(true); }
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-timer-fullscreen]").forEach((button) => button.addEventListener("click", () => {
    fullscreenTimerId = button.dataset.timerFullscreen ?? null;
    render(true);
  }));
  root.querySelector<HTMLButtonElement>("[data-exit-fullscreen]")?.addEventListener("click", () => { fullscreenTimerId = null; render(true); });
  root.querySelectorAll<HTMLButtonElement>("[data-edit-reminder]").forEach((button) => button.addEventListener("click", () => {
    reminderEditingTaskId = button.dataset.editReminder ?? null;
    reminderDialogError = "";
    render(true);
  }));
  root.querySelector<HTMLButtonElement>("[data-close-reminder]")?.addEventListener("click", () => { reminderEditingTaskId = null; render(true); });
  root.querySelector<HTMLDialogElement>("[data-reminder-dialog]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) { reminderEditingTaskId = null; render(true); }
  });
  root.querySelector<HTMLDialogElement>("[data-reminder-dialog]")?.addEventListener("cancel", () => {
    reminderEditingTaskId = null;
  });
  root.querySelector<HTMLFormElement>("[data-reminder-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const id = form.dataset.reminderForm;
    const value = new FormData(form).get("reminderAt");
    if (!id || typeof value !== "string") return;
    const timestamp = todayTimestampForTime(value);
    try {
      await invoke("set_task_reminder", { id, reminderAt: timestamp });
      reminderEditingTaskId = null;
      reminderDialogError = "";
      await refreshTasks();
    } catch (error) {
      reminderDialogError = backendMessage(error);
      render(true);
    }
  });
  root.querySelector<HTMLButtonElement>("[data-clear-reminder]")?.addEventListener("click", async (event) => {
    const id = (event.currentTarget as HTMLButtonElement).dataset.clearReminder;
    if (!id) return;
    try {
      await invoke("clear_task_reminder", { id });
      reminderEditingTaskId = null;
      await refreshTasks();
    } catch (error) { reminderDialogError = backendMessage(error); render(true); }
  });
  root.querySelectorAll<HTMLAnchorElement>("[data-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const nextView = link.dataset.view as View | undefined;
      if (!nextView || nextView === activeView) return;
      activeView = nextView;
      window.history.pushState(null, "", `#${activeView}`);
      render(true);
      if (activeView === "history") void refreshHistory();
      if (activeView === "timers") void refreshTimers();
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-calendar-date]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.calendarDate;
      if (!value) return;
      selectedHistoryDate = value;
      calendarMonth = monthStart(parseLocalDate(value));
      render(true);
      void refreshHistory();
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-calendar-shift]").forEach((button) => {
    button.addEventListener("click", () => {
      const shift = Number(button.dataset.calendarShift);
      const target = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + shift, 1);
      const today = new Date();
      if (shift > 0 && (target.getFullYear() > today.getFullYear()
        || (target.getFullYear() === today.getFullYear() && target.getMonth() > today.getMonth()))) return;
      calendarMonth = target;
      void refreshHistory();
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-restore-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.restoreTask;
      if (!id || saving) return;
      const restored = await perform(() => invoke("restore_task", { id }));
      if (restored) await refreshHistory();
    });
  });

  root.querySelector<HTMLButtonElement>("[data-theme-switch]")?.addEventListener("click", () => {
    theme = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length]!;
    try { localStorage.setItem(themeStorageKey, theme); } catch { /* Theme remains active for this session. */ }
    applyTheme();
    updateThemeButton();
  });

  root.querySelector<HTMLButtonElement>("[data-retry-load]")?.addEventListener("click", () => {
    loading = true;
    errorMessage = "";
    render();
    void refreshTasks();
  });

  root.querySelector<HTMLFormElement>("#quick-add-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>("#new-task-title");
    const title = input?.value.trim() ?? "";
    if (!title) {
      errorMessage = "Введите название задачи.";
      render();
      root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
      return;
    }
    void createTask(title);
  });

  root.querySelectorAll<HTMLButtonElement>("[data-toggle-task]").forEach((button) => {
    button.addEventListener("click", () => {
      if (saving) return;
      const task = tasks.find((item) => item.id === button.dataset.toggleTask);
      if (!task) return;
      if (task.status === "active") {
        const row = button.closest<HTMLLIElement>(".task-row");
        if (row) void completeTaskWithAnimation(task, row, button);
      } else {
        const row = button.closest<HTMLLIElement>(".task-row");
        if (row) void reopenTaskWithAnimation(task, row, button);
      }
    });
  });

  root.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
    row.querySelector<HTMLElement>(".task-content")?.addEventListener("dblclick", () => {
      if (saving || taskAnimationLocks.has(row.dataset.taskId ?? "") || editingTaskId === row.dataset.taskId) return;
      editingTaskId = row.dataset.taskId ?? null;
      errorMessage = "";
      render();
    });
  });

  root.querySelectorAll<HTMLFormElement>("[data-rename-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const taskId = form.dataset.renameForm;
      const input = form.querySelector<HTMLInputElement>("[name=title]");
      const title = input?.value.trim() ?? "";
      if (!taskId || !title) {
        errorMessage = "Введите название задачи.";
        render();
        return;
      }
      void perform(() => invoke("rename_task", { id: taskId, title }));
    });
    form.querySelector<HTMLInputElement>(".rename-input")?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const taskId = form.dataset.renameForm;
      editingTaskId = null;
      render();
      if (taskId) root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`)?.focus();
    });
  });

  root.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
    row.addEventListener("mousedown", (event) => {
      if (saving || taskAnimationLocks.has(row.dataset.taskId ?? "")) return;
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, input, a"))) return;
      const sourceId = row.dataset.taskId;
      if (!sourceId) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const rowBounds = row.getBoundingClientRect();
      const pointerOffsetX = event.clientX - rowBounds.left;
      const pointerOffsetY = event.clientY - rowBounds.top;
      let dragPreview: HTMLLIElement | null = null;
      mouseDragActive = false;

      const handleMouseMove = (moveEvent: MouseEvent): void => {
        if (!mouseDragActive && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
        mouseDragActive = true;
        moveEvent.preventDefault();
        window.getSelection()?.removeAllRanges();
        document.body.classList.add("is-task-dragging");
        row.classList.add("is-drag-source");
        if (!dragPreview) {
          dragPreview = row.cloneNode(true) as HTMLLIElement;
          dragPreview.classList.remove("is-drag-source", "drop-target", "drop-before", "drop-after");
          dragPreview.classList.add("task-drag-preview");
          dragPreview.dataset.reorderable = "false";
          dragPreview.removeAttribute("data-task-id");
          dragPreview.removeAttribute("tabindex");
          dragPreview.removeAttribute("aria-label");
          dragPreview.setAttribute("aria-hidden", "true");
          dragPreview.querySelector<HTMLButtonElement>(".task-check")?.removeAttribute("disabled");
          const bounds = row.getBoundingClientRect();
          dragPreview.style.width = `${bounds.width}px`;
          document.body.append(dragPreview);
        }
        dragPreview.style.left = `${Math.min(Math.max(8, moveEvent.clientX - pointerOffsetX), Math.max(8, window.innerWidth - dragPreview.offsetWidth - 8))}px`;
        dragPreview.style.top = `${Math.min(Math.max(8, moveEvent.clientY - pointerOffsetY), Math.max(8, window.innerHeight - dragPreview.offsetHeight - 8))}px`;
        const list = row.closest<HTMLOListElement>(".task-list");
        if (list) {
          const bounds = list.getBoundingClientRect();
          const edge = Math.min(48, bounds.height * 0.2);
          if (moveEvent.clientY > bounds.bottom - edge) list.scrollTop += 12;
          else if (moveEvent.clientY < bounds.top + edge) list.scrollTop -= 12;
        }
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLLIElement>(".task-row[data-reorderable=true]") ?? null;
        root.querySelectorAll(".task-row").forEach((item) => item.classList.remove("drop-target", "drop-before", "drop-after"));
        if (target && target.dataset.taskId !== sourceId) {
          target.classList.add("drop-target", moveEvent.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 ? "drop-before" : "drop-after");
        }
      };

      const handleMouseUp = (upEvent: MouseEvent): void => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest<HTMLLIElement>(".task-row[data-reorderable=true]") ?? null;
        const targetId = target?.dataset.taskId;
        const shouldSave = mouseDragActive && targetId && targetId !== sourceId;
        row.classList.remove("is-drag-source");
        dragPreview?.remove();
        root.querySelectorAll(".task-row").forEach((item) => item.classList.remove("drop-target", "drop-before", "drop-after"));
        document.body.classList.remove("is-task-dragging");
        mouseDragActive = false;
        if (!shouldSave || !target) return;

        const originalIds = activeTasks().map((task) => task.id);
        const ids = [...originalIds];
        const sourceIndex = ids.indexOf(sourceId);
        const targetIndex = ids.indexOf(targetId);
        if (sourceIndex < 0 || targetIndex < 0) return;
        const afterTarget = upEvent.clientY >= target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
        ids.splice(sourceIndex, 1);
        let destinationIndex = targetIndex - (sourceIndex < targetIndex ? 1 : 0) + (afterTarget ? 1 : 0);
        destinationIndex = Math.max(0, Math.min(destinationIndex, ids.length));
        ids.splice(destinationIndex, 0, sourceId);
        if (ids.some((id, index) => id !== originalIds[index])) void saveOrder(ids, destinationIndex);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    });
  });

  root.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
    row.addEventListener("keydown", (event) => {
      if (saving || taskAnimationLocks.has(row.dataset.taskId ?? "")) return;
      if (event.key === "F2") {
        event.preventDefault();
        editingTaskId = row.dataset.taskId ?? null;
        render();
        return;
      }
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const ids = activeTasks().map((task) => task.id);
      const index = ids.indexOf(row.dataset.taskId ?? "");
      const nextIndex = index + (event.key === "ArrowUp" ? -1 : 1);
      if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
      [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
      void saveOrder(ids, nextIndex);
    });
  });
}

async function saveOrder(ids: string[], movedIndex: number): Promise<void> {
  const movedId = ids[movedIndex];
  const saved = await perform(() => invoke("reorder_tasks", { ids }));
  if (!saved) return;
  const index = activeTasks().findIndex((task) => task.id === movedId);
  if (index >= 0) {
    announcement = `Задача перемещена на позицию ${index + 1} из ${activeTasks().length}.`;
    root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(movedId)}"]`)?.focus();
  }
  render();
}

applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "system") applyTheme();
});
const syncViewFromHash = (): void => {
  const nextView: View = window.location.hash === "#completed" ? "completed" : window.location.hash === "#history" ? "history" : window.location.hash === "#timers" ? "timers" : "today";
  if (nextView === activeView) return;
  activeView = nextView;
  render(true);
  if (activeView === "history") void refreshHistory();
  if (activeView === "timers") void refreshTimers();
};
window.addEventListener("popstate", syncViewFromHash);
window.addEventListener("hashchange", syncViewFromHash);
void listen<string>("reminder-open-task", async ({ payload }) => {
  await refreshTasks();
  const task = tasks.find((item) => item.id === payload);
  if (!task) return;
  if (task.status === "active") {
    activeView = "today";
  } else if (task.status === "completed" && isSameLocalDay(task.completedAt, new Date())) {
    activeView = "completed";
  } else {
    activeView = "history";
    const eventTime = task.status === "archived" ? task.archivedAt : task.completedAt;
    if (eventTime !== null) {
      selectedHistoryDate = toLocalDateString(new Date(eventTime));
      calendarMonth = monthStart(parseLocalDate(selectedHistoryDate));
      await refreshHistory();
    }
  }
  window.history.pushState(null, "", `#${activeView}`);
  highlightedReminderTaskId = payload;
  render(true);
  const row = root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(payload)}"]`);
  row?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => { highlightedReminderTaskId = null; render(true); }, 4_000);
});
void listen("reminder-delivery-error", () => {
  errorMessage = "Не удалось показать уведомление. Проверьте Параметры Windows → Система → Уведомления.";
  render(true);
});
void listen("reminder-runtime-error", () => {
  errorMessage = "Не удалось обработать напоминание. Перезапустите приложение.";
  render(true);
});
render();
void refreshTasks();
if (activeView === "history") void refreshHistory();
if (activeView === "timers") void refreshTimers();
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && fullscreenTimerId) {
    fullscreenTimerId = null;
    render(true);
  }
});
void listen<Timer>("timer-finished", async ({ payload }) => {
  announcement = `Таймер завершён: ${payload.name}.`;
  await refreshTimers();
});
void listen("timer-notification-error", () => {
  timerError = "Не удалось показать уведомление. Проверьте Параметры Windows → Система → Уведомления.";
  if (activeView === "timers") render(true);
});
void listen("timer-runtime-error", () => {
  timerError = "Не удалось сохранить состояние таймера.";
  if (activeView === "timers") render(true);
});
window.setInterval(async () => {
  try {
    const archived = await invoke<number>("archive_expired_tasks");
    if (archived > 0) {
      await refreshTasks();
      if (activeView === "history") await refreshHistory();
    }
  } catch (error) {
    errorMessage = backendMessage(error);
    render();
  }
}, 60_000);
window.setInterval(() => { if (activeView === "timers") void refreshTimers(false); }, 1_000);
