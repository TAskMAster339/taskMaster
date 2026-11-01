import { invoke } from "@tauri-apps/api/core";

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
}

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
type View = "today" | "completed" | "history";
let activeView: View = window.location.hash === "#completed" ? "completed" : window.location.hash === "#history" ? "history" : "today";
let historyDay: HistoryDay = { completed: [], archived: [] };
let historyLoading = false;
let historyQuery = "";
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
let selectedHistoryDate = toLocalDateString(yesterday);
let calendarMonth = monthStart(parseLocalDate(selectedHistoryDate));
const enteringTaskIds = new Set<string>();

function waitForMotion(milliseconds: number): Promise<void> {
  const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : milliseconds;
  return new Promise((resolve) => window.setTimeout(resolve, duration));
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

function filteredDayTasks(items: HistoryTask[]): HistoryTask[] {
  const query = historyQuery.trim().toLocaleLowerCase("ru-RU");
  return items.filter(({ task }) => !query || task.title.toLocaleLowerCase("ru-RU").includes(query));
}

function renderCalendar(): string {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const first = monthStart(calendarMonth);
  const dayOffset = (first.getDay() + 6) % 7;
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = `${"<span class=\"calendar-empty\" aria-hidden=\"true\"></span>".repeat(dayOffset)}${Array.from({ length: days }, (_, index) => {
    const date = new Date(first.getFullYear(), first.getMonth(), index + 1);
    const value = toLocalDateString(date);
    const disabled = date >= todayStart;
    return `<button class="calendar-day ${value === selectedHistoryDate ? "is-selected" : ""}" type="button" data-calendar-date="${value}" aria-label="${new Intl.DateTimeFormat("ru-RU", { dateStyle: "full" }).format(date)}" ${value === selectedHistoryDate ? 'aria-pressed="true"' : ""} ${disabled ? "disabled" : ""}>${date.getDate()}</button>`;
  }).join("")}`;
  const nextMonthDisabled = first.getFullYear() === today.getFullYear() && first.getMonth() >= today.getMonth();
  return `<section class="history-calendar" aria-label="Календарь истории">
    <div class="calendar-heading"><button type="button" data-calendar-shift="-1" aria-label="Предыдущий месяц">←</button><h2>${new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(first)}</h2><button type="button" data-calendar-shift="1" aria-label="Следующий месяц" ${nextMonthDisabled ? "disabled" : ""}>→</button></div>
    <div class="calendar-grid calendar-weekdays" aria-hidden="true">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="calendar-grid">${cells}</div>
  </section>`;
}

function renderHistoryColumn(title: string, items: HistoryTask[], type: "completed" | "archived"): string {
  const visible = filteredDayTasks(items);
  const list = historyLoading
    ? `<li class="history-empty">Загружаем…</li>`
    : visible.length
      ? visible.map(({ task, occurredAt, createdAt }) => `<li class="history-task-row">
          <span class="history-task-title">${escapeHtml(task.title)}</span>
          <time>${formatTime(type === "completed" ? occurredAt : createdAt)}</time>
          ${type === "archived" && task.status === "archived" ? `<button class="history-restore" type="button" data-restore-task="${task.id}" aria-label="Восстановить задачу: ${escapeHtml(task.title)}">↶</button>` : ""}
        </li>`).join("")
      : `<li class="history-empty">${historyQuery ? "Задачи не найдены" : "Нет задач"}</li>`;
  return `<section class="history-column history-column-${type}" aria-labelledby="history-${type}-title">
    <div class="history-column-heading"><h2 id="history-${type}-title">${title}</h2><span>${visible.length}</span></div>
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
    <li class="task-row ${completed ? "is-completed" : ""} ${taskAnimationLocks.has(task.id) ? "is-task-animating" : ""}" data-task-id="${task.id}" data-reorderable="${!completed}" ${completed ? "" : `tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2" aria-label="${escapeHtml(task.title)}. Alt и стрелки вверх или вниз меняют порядок. F2 изменяет название."`}>
      <span class="task-position ${completed ? "completed-position" : ""}" data-position="${position}" aria-label="Задача ${index + 1}"><span class="position-old" aria-hidden="true"></span><span class="position-current">${position}</span></span>
      <button class="task-check ${completed ? "checked" : ""}" type="button"
        data-toggle-task="${task.id}" aria-label="${completed ? "Вернуть в очередь" : "Отметить выполненной"} — ${escapeHtml(task.title)}"
        aria-pressed="${completed}" ${saving || taskAnimationLocks.has(task.id) ? "disabled" : ""}>
        <span aria-hidden="true">${completed ? "✓" : ""}</span>
      </button>
      <div class="task-content">${title}</div>
    </li>`;
}

function render(allowDuringAnimation = false): void {
  if (taskAnimationLocks.size > 0 && !allowDuringAnimation) return;
  const previousPositions = captureTaskPositions();
  const active = activeTasks();
  const completedToday = completedTodayTasks();
  const showingToday = activeView === "today";
  const showingCompleted = activeView === "completed";
  const showingHistory = activeView === "history";
  const visibleTasks = showingToday ? active : completedToday;
  const historyCount = filteredDayTasks(historyDay.completed).length + filteredDayTasks(historyDay.archived).length;
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

        ${showingHistory ? renderCalendar() : ""}
        ${showingHistory ? `<div class="history-controls"><label><span class="visually-hidden">Поиск задач</span><input type="search" data-history-search placeholder="Поиск задач" value="${escapeHtml(historyQuery)}" /></label></div>` : ""}

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
      </main>
      <span class="visually-hidden" role="status" aria-live="polite">${escapeHtml(announcement)}</span>
    </div>`;

  bindEvents();
  animatePositionChanges(previousPositions);
  animateEnteringTasks();
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

async function refreshHistory(): Promise<void> {
  historyLoading = true;
  historyDay = { completed: [], archived: [] };
  errorMessage = "";
  render(true);
  try {
    const selected = parseLocalDate(selectedHistoryDate);
    const start = selected.getTime();
    const end = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() + 1).getTime();
    historyDay = await invoke<HistoryDay>("list_history_for_range", { start, end });
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
  root.querySelectorAll<HTMLAnchorElement>("[data-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const nextView = link.dataset.view as View | undefined;
      if (!nextView || nextView === activeView) return;
      activeView = nextView;
      window.history.pushState(null, "", `#${activeView}`);
      render(true);
      if (activeView === "history") void refreshHistory();
    });
  });

  const updateHistoryResults = (): void => {
    const list = root.querySelector<HTMLElement>(".history-list-container");
    if (list) list.innerHTML = renderHistoryLists();
    const count = filteredDayTasks(historyDay.completed).length + filteredDayTasks(historyDay.archived).length;
    const progressCount = root.querySelector<HTMLElement>(".progress-count");
    const progress = root.querySelector<HTMLElement>(".day-progress");
    if (progressCount) progressCount.textContent = String(count).padStart(2, "0");
    progress?.setAttribute("aria-label", `Задач в истории: ${count}`);
  };
  root.querySelector<HTMLInputElement>("[data-history-search]")?.addEventListener("input", (event) => {
    historyQuery = (event.currentTarget as HTMLInputElement).value;
    updateHistoryResults();
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
      render(true);
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
  const nextView: View = window.location.hash === "#completed" ? "completed" : window.location.hash === "#history" ? "history" : "today";
  if (nextView === activeView) return;
  activeView = nextView;
  render(true);
  if (activeView === "history") void refreshHistory();
};
window.addEventListener("popstate", syncViewFromHash);
window.addEventListener("hashchange", syncViewFromHash);
render();
void refreshTasks();
if (activeView === "history") void refreshHistory();
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
