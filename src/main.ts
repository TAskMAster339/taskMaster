import { defaultShortcuts, shortcutLabels, keyboardCombination, displayShortcut, type ShortcutAction } from "./shortcuts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

interface OverlayShortcutStatus { shortcut: string; available: boolean; }

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
type View = "today" | "completed" | "history" | "timers" | "settings";
let activeView: View = window.location.hash === "#settings" ? "settings" : window.location.hash === "#completed" ? "completed" : window.location.hash === "#history" ? "history" : window.location.hash === "#timers" ? "timers" : "today";
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
interface UndoDeletion { token: string; taskId: string; title: string; expiresAt: number; }
let deletionUndos: UndoDeletion[] = [];
const undoBusy = new Set<string>();
let undoMessage = "";
let undoRenderKey = "";
let undoExpiryTimer: number | null = null;
function renderDeletionUndos(): void {
  deletionUndos = deletionUndos.filter((item) => item.expiresAt > Date.now());
  if (undoExpiryTimer !== null) window.clearTimeout(undoExpiryTimer);
  undoExpiryTimer = deletionUndos.length ? window.setTimeout(renderDeletionUndos, Math.max(1, Math.min(...deletionUndos.map((item) => item.expiresAt)) - Date.now())) : null;
  let region = document.querySelector<HTMLElement>("#deletion-undos");
  if (!region) { region = document.createElement("aside"); region.id = "deletion-undos"; region.className = "undo-notices"; region.setAttribute("aria-label", "Удалённые задачи"); region.setAttribute("aria-live", "polite"); document.body.append(region); }
  region.hidden = deletionUndos.length === 0 && !undoMessage;
  const key = JSON.stringify([deletionUndos, [...undoBusy], undoMessage]); if (key === undoRenderKey) return; undoRenderKey = key;
  region.innerHTML = `${undoMessage ? `<div class="undo-error" role="alert"><span>${escapeHtml(undoMessage)}</span><button type="button" data-dismiss-undo-message aria-label="Закрыть сообщение">×</button></div>` : ""}<ul>${deletionUndos.map((item) => `<li><span><small>Задача удалена</small><strong>${escapeHtml(item.title)}</strong></span><button type="button" data-undo-deletion="${item.token}" aria-label="Отменить удаление: ${escapeHtml(item.title)}" ${undoBusy.has(item.token) ? "disabled" : ""}>Отменить</button></li>`).join("")}</ul>`;
  region.querySelector<HTMLButtonElement>("[data-dismiss-undo-message]")?.addEventListener("click", () => { undoMessage = ""; renderDeletionUndos(); });
  region.querySelectorAll<HTMLButtonElement>("[data-undo-deletion]").forEach((button) => button.addEventListener("click", async () => {
    const token = button.dataset.undoDeletion!; if (undoBusy.has(token)) return;
    undoBusy.add(token); undoMessage = ""; renderDeletionUndos();
    try {
      const restored = await invoke<Task>("undo_task_deletion", { token });
      deletionUndos = deletionUndos.filter((item) => item.token !== token);
      await refreshTasks(); if (activeView === "history") await refreshHistory();
      if (restored.status === "archived") undoMessage = "Удаление отменено. Срок задачи истёк, она находится в архиве.";
      else root.querySelector<HTMLButtonElement>(`[data-toggle-task="${CSS.escape(restored.id)}"]`)?.focus();
    } catch (error) { undoMessage = backendMessage(error); }
    finally { undoBusy.delete(token); await refreshDeletionUndos(); renderDeletionUndos(); }
  }));
}
async function refreshDeletionUndos(): Promise<void> {
  try { deletionUndos = await invoke<UndoDeletion[]>("list_deletion_undos"); }
  catch (error) { undoMessage = backendMessage(error); }
  renderDeletionUndos();
}

let autostartEnabled: boolean | null = null;
let autostartBusy = false;
let autostartMessage = "";
function updateAutostartControls(): void {
  const checkbox = root.querySelector<HTMLInputElement>("[data-autostart]");
  if (checkbox) { checkbox.checked = autostartEnabled === true; checkbox.disabled = autostartBusy || autostartEnabled === null; }
  const status = root.querySelector<HTMLElement>("[data-autostart-status]");
  if (status) status.textContent = autostartMessage;
  const retry = root.querySelector<HTMLButtonElement>("[data-autostart-retry]");
  if (retry) { retry.hidden = autostartEnabled !== null; retry.disabled = autostartBusy; }
}
async function refreshAutostart(): Promise<void> {
  if (autostartBusy) return;
  autostartBusy = true; updateAutostartControls();
  try { autostartEnabled = await invoke<boolean>("get_autostart_enabled"); autostartMessage = ""; }
  catch (error) { autostartEnabled = null; autostartMessage = backendMessage(error); }
  finally { autostartBusy = false; updateAutostartControls(); }
}
function renderAutostartSettings(): string {
  return `<section class="settings-section" aria-labelledby="startup-heading"><h2 id="startup-heading">Запуск</h2>
    <label class="settings-check"><input type="checkbox" data-autostart ${autostartEnabled ? "checked" : ""} ${autostartBusy || autostartEnabled === null ? "disabled" : ""}/><span>Запускать с Windows</span></label>
    <p role="status" data-autostart-status>${escapeHtml(autostartMessage)}</p>
    <button class="retry-button" type="button" data-autostart-retry ${autostartEnabled === null ? "" : "hidden"}>Повторить проверку</button>
  </section>`;
}
function bindAutostartSettings(): void {
  root.querySelector<HTMLButtonElement>("[data-autostart-retry]")?.addEventListener("click", () => { void refreshAutostart(); });
  root.querySelector<HTMLInputElement>("[data-autostart]")?.addEventListener("change", async (event) => {
    const desired = (event.currentTarget as HTMLInputElement).checked;
    if (autostartBusy) { updateAutostartControls(); return; }
    autostartBusy = true; updateAutostartControls();
    try { autostartEnabled = await invoke<boolean>("set_autostart_enabled", { enabled: desired }); autostartMessage = "Сохранено"; }
    catch (error) {
      autostartMessage = backendMessage(error);
      try { autostartEnabled = await invoke<boolean>("get_autostart_enabled"); } catch { autostartEnabled = null; }
    }
    finally { autostartBusy = false; updateAutostartControls(); }
  });
}

interface NotificationStatus { state: string; message: string; canTest: boolean; usesSystemIdentity: boolean; }
let notificationStatus: NotificationStatus | null = null;
let notificationBusy = false;
let notificationReadError = "";
let notificationActionMessage = "";
function updateNotificationControls(): void {
  const status = root.querySelector<HTMLElement>("[data-notification-permission]");
  if (status) { status.textContent = notificationStatus?.message ?? (notificationReadError || "Проверка состояния…"); status.classList.toggle("is-blocked", notificationStatus !== null && !notificationStatus.canTest); }
  const hint = root.querySelector<HTMLElement>("[data-notification-identity]");
  if (hint) hint.hidden = !notificationStatus?.usesSystemIdentity;
  const message = root.querySelector<HTMLElement>("[data-notification-result]");
  if (message) message.textContent = notificationActionMessage;
  root.querySelectorAll<HTMLButtonElement>("[data-notification-test], [data-notification-refresh]").forEach((button) => { button.disabled = notificationBusy || (button.hasAttribute("data-notification-test") && !notificationStatus?.canTest); });
  const warning = root.querySelector<HTMLElement>("[data-reminder-notification-warning]");
  if (warning) { warning.hidden = notificationStatus === null || notificationStatus.canTest; warning.querySelector<HTMLElement>("p")!.textContent = notificationStatus?.message ?? ""; }
}
async function refreshNotificationStatus(): Promise<void> {
  if (notificationBusy) return;
  notificationBusy = true; updateNotificationControls();
  try { notificationStatus = await invoke<NotificationStatus>("get_notification_status"); notificationReadError = ""; }
  catch (error) { notificationStatus = null; notificationReadError = backendMessage(error); }
  finally { notificationBusy = false; updateNotificationControls(); }
}
function renderNotificationSettings(): string {
  return `<section class="settings-section" aria-labelledby="notifications-heading"><h2 id="notifications-heading">Уведомления</h2>
    <p data-notification-permission role="status" class="${notificationStatus !== null && !notificationStatus.canTest ? "is-blocked" : ""}">${escapeHtml(notificationStatus?.message ?? (notificationReadError || "Проверка состояния…"))}</p>
    <p>Напоминания работают, пока taskMaster запущен, в том числе в трее.</p>
    <p data-notification-identity ${notificationStatus?.usesSystemIdentity ? "" : "hidden"}>В этой сборке отправитель — Windows PowerShell.</p>
    <div class="settings-actions"><button class="retry-button" type="button" data-notification-test ${notificationBusy || !notificationStatus?.canTest ? "disabled" : ""}>Проверить уведомление</button>
    <button class="retry-button" type="button" data-notification-refresh ${notificationBusy ? "disabled" : ""}>Обновить состояние</button>
    <button class="retry-button" type="button" data-open-notification-settings>Настройки Windows</button></div>
    <p role="status" data-notification-result>${escapeHtml(notificationActionMessage)}</p>
  </section>`;
}
function bindNotificationControls(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-open-notification-settings]").forEach((button) => button.addEventListener("click", async () => {
    try { await invoke("open_notification_settings"); }
    catch (error) { notificationActionMessage = backendMessage(error); errorMessage = notificationActionMessage; if (activeView === "settings") updateNotificationControls(); else render(true); }
  }));
  root.querySelector<HTMLButtonElement>("[data-notification-refresh]")?.addEventListener("click", () => { void refreshNotificationStatus(); });
  root.querySelector<HTMLButtonElement>("[data-notification-test]")?.addEventListener("click", async () => {
    if (notificationBusy) return;
    notificationBusy = true; notificationActionMessage = "Отправка…"; updateNotificationControls();
    try { await invoke("send_test_notification"); notificationActionMessage = "Тестовое уведомление отправлено."; }
    catch (error) { notificationActionMessage = backendMessage(error); }
    finally { notificationBusy = false; updateNotificationControls(); void refreshNotificationStatus(); }
  });
}

interface BackupStatus { directory: string; warning: string | null; databaseAvailable: boolean; hasDailyCopy: boolean; }
interface RestorePreview { token: string; source: string; tasks: number; events: number; timers: number; }
let backupStatus: BackupStatus | null = null;
let backupMessage = "";
let backupBusy = false;
let restorePreview: RestorePreview | null = null;
async function refreshBackupStatus(): Promise<void> {
  try { backupStatus = await invoke<BackupStatus>("get_backup_status"); }
  catch (error) { backupMessage = backendMessage(error); }
  if (activeView === "settings") render(true);
}

let preferences = { reminderMinutes: 15, archiveHours: 24 };
let preferencesReady = false;
let preferencesError = "";
let shortcuts = { ...defaultShortcuts };
let shortcutsReady = false;
let shortcutsError = "";
let overlayShortcut = "Ctrl+Alt+Space";
let overlayShortcutAvailable = true;
let overlayShortcutDialogOpen = false;
let overlayShortcutError = "";

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
  reminderDate.setMinutes(reminderDate.getMinutes() + preferences.reminderMinutes + Number(needsNextMinute));
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
      progress.setAttribute("stroke-dashoffset", String(circumference * (1 - ratio)));
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
    <li class="task-row ${completed ? "is-completed" : ""} ${highlightedReminderTaskId === task.id ? "is-reminder-highlighted" : ""} ${taskAnimationLocks.has(task.id) ? "is-task-animating" : ""}" data-task-id="${task.id}" data-reorderable="${!completed}" ${completed ? "" : `tabindex="0" aria-keyshortcuts="${shortcuts.move_up} ${shortcuts.move_down} ${shortcuts.rename}" aria-label="${escapeHtml(task.title)}. ${escapeHtml(displayShortcut(shortcuts.move_up))} и ${escapeHtml(displayShortcut(shortcuts.move_down))} меняют порядок. ${escapeHtml(displayShortcut(shortcuts.rename))} изменяет название."`}>
      <span class="task-position ${completed ? "completed-position" : ""}" data-position="${position}" aria-label="Задача ${index + 1}"><span class="position-old" aria-hidden="true"></span><span class="position-current">${position}</span></span>
      <button class="task-check ${completed ? "checked" : ""}" type="button"
        data-toggle-task="${task.id}" aria-label="${completed ? "Вернуть в очередь" : "Отметить выполненной"} — ${escapeHtml(task.title)}"
        aria-pressed="${completed}" ${saving || taskAnimationLocks.has(task.id) ? "disabled" : ""}>
        <span aria-hidden="true">${completed ? "✓" : ""}</span>
      </button>
      <div class="task-content">${title}</div>
      ${completed ? "" : `<button class="reminder-button ${task.reminderAt !== null ? "has-reminder" : ""}" type="button" data-edit-reminder="${task.id}" aria-label="${task.reminderAt !== null ? `Изменить напоминание: ${escapeHtml(task.title)}` : `Добавить напоминание: ${escapeHtml(task.title)}`}">${task.reminderAt !== null ? `<time>${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(task.reminderAt)}</time>` : "◷"}</button>`}
      <button class="task-delete" type="button" data-delete-task="${task.id}" aria-label="Удалить задачу: ${escapeHtml(task.title)}" title="Удалить задачу" ${saving || taskAnimationLocks.has(task.id) ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>
    </li>`;
}

function timerCard(timer: Timer, fullscreen = false, overlay = false): string {
  const progress = timer.durationSeconds > 0 ? timer.remainingSeconds / timer.durationSeconds : 0;
  const circumference = 2 * Math.PI * 86;
  const ring = `<svg class="timer-ring" viewBox="0 0 200 200" aria-hidden="true"><circle class="timer-ring-track" cx="100" cy="100" r="86"/><circle class="timer-ring-progress" cx="100" cy="100" r="86" stroke-dasharray="${circumference} ${circumference}" stroke-dashoffset="${circumference * (1 - progress)}"/></svg>`;
  return `<article class="timer-card ${fullscreen ? "timer-card-focus" : ""} ${overlay ? "timer-card-overlay" : ""}" data-timer-card="${timer.id}" data-timer-status="${timer.status}">
    <div class="timer-card-heading"><h2>${escapeHtml(timer.name)}</h2>${overlay ? `<div class="timer-card-actions"><button type="button" data-hide-overlay-timer="${timer.id}" aria-label="Скрыть таймер из оверлея" title="Скрыть из оверлея">×</button></div>` : `<div class="timer-card-actions">${fullscreen ? '<button type="button" class="timer-exit-button" data-exit-fullscreen aria-label="Выйти из полноэкранного режима"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' : `<button type="button" data-timer-fullscreen="${timer.id}" aria-label="Открыть на весь экран">⛶</button><button type="button" class="timer-delete" data-timer-action="delete" data-timer-id="${timer.id}" aria-label="Удалить таймер">×</button>`}</div>`}</div>
    <div class="timer-dial">${ring}<strong class="timer-clock" data-timer-clock>${formatTimerTime(timer.remainingSeconds)}</strong></div>
    <div class="timer-footer">
      <div class="timer-controls">
        ${timer.status === "running" ? `<button type="button" data-timer-action="pause" data-timer-id="${timer.id}" aria-label="Пауза">Ⅱ</button>` : `<button type="button" data-timer-action="start" data-timer-id="${timer.id}" aria-label="${timer.status === "finished" ? "Запустить заново" : "Запустить"}">${timer.status === "finished" ? "↻" : "▶"}</button>`}
        <button type="button" data-timer-action="reset" data-timer-id="${timer.id}" aria-label="Сбросить таймер">↶</button>
      </div>
    </div>
  </article>`;
}

function renderSidebar(): string {
  const sections: { view: View; label: string; count?: number }[] = [
    { view: "today", label: "Сегодня", count: activeTasks().length },
    { view: "completed", label: "Выполнено", count: completedTodayTasks().length },
    { view: "history", label: "История" },
    { view: "timers", label: "Таймеры" },
  ];
  return `<aside class="sidebar" aria-label="taskMaster"><nav class="navigation" aria-label="Разделы">
    ${sections.map(({ view, label, count }, index) => `<a class="nav-item ${activeView === view ? "is-current" : ""}" href="#${view}" data-view="${view}" ${activeView === view ? 'aria-current="page"' : ""}><span class="nav-index">${String(index + 1).padStart(2, "0")}</span>${label}${count === undefined ? "" : `<span class="nav-count">${count}</span>`}</a>`).join("")}
  </nav><button class="theme-switch" type="button" data-view="settings" ${activeView === "settings" ? 'aria-current="page"' : ""} aria-label="Настройки"><span class="theme-icon" aria-hidden="true">⚙</span><span class="theme-copy">Настройки</span></button></aside>`;
}

function renderBackupSettings(): string {
  return `<section class="settings-section" aria-labelledby="backup-heading"><h2 id="backup-heading">Резервные копии</h2>
    <p>Ежедневные копии создаются при запуске. Хранятся последние семь.</p>
    ${backupStatus?.warning ? `<p class="backup-warning" role="alert">${escapeHtml(backupStatus.warning)}</p>` : ""}
    <div class="backup-actions">
      <button class="retry-button" type="button" data-backup-action="create" ${backupBusy || !backupStatus?.databaseAvailable ? "disabled" : ""}>Создать резервную копию</button>
      <button class="retry-button" type="button" data-backup-action="choose" ${backupBusy || !backupStatus ? "disabled" : ""}>Восстановить из файла</button>
      <button class="retry-button" type="button" data-backup-action="latest" ${backupBusy || !backupStatus?.hasDailyCopy ? "disabled" : ""}>Восстановить последнюю ежедневную</button>
      <button class="retry-button" type="button" data-backup-action="folder" ${backupBusy || !backupStatus ? "disabled" : ""}>Открыть папку данных</button>
    </div><p role="status" aria-live="polite">${escapeHtml(backupMessage)}</p>
    ${restorePreview ? `<dialog class="reminder-dialog backup-confirm" data-restore-dialog aria-labelledby="restore-heading"><form data-restore-confirm><h2 id="restore-heading">Восстановить данные?</h2>
      <p class="backup-source">${escapeHtml(restorePreview.source)}</p>
      <dl class="backup-summary"><dt>Задачи</dt><dd>${restorePreview.tasks}</dd><dt>События истории</dt><dd>${restorePreview.events}</dd><dt>Таймеры</dt><dd>${restorePreview.timers}</dd></dl>
      <p>Текущие задачи, история, таймеры и настройки задач будут заменены. Перед заменой текущие данные будут сохранены отдельно.</p>
      <div class="reminder-actions"><button type="button" data-cancel-restore ${backupBusy ? "disabled" : ""}>Отмена</button><button type="submit" ${backupBusy ? "disabled" : ""}>${backupBusy ? "Восстановление…" : "Восстановить"}</button></div>
    </form></dialog>` : ""}
  </section>`;
}

function bindBackupSettings(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-backup-action]").forEach((button) => button.addEventListener("click", async () => {
    if (backupBusy) return;
    const action = button.dataset.backupAction;
    backupBusy = true; backupMessage = action === "create" ? "Создание копии…" : action === "folder" ? "" : "Проверка копии…"; render(true);
    try {
      if (action === "folder") { await invoke("open_data_directory"); }
      else if (action === "create") { const path = await invoke<string | null>("create_database_backup"); backupMessage = path ? `Копия сохранена: ${path}` : ""; }
      else { restorePreview = await invoke<RestorePreview | null>("prepare_database_restore", { latest: action === "latest" }); backupMessage = ""; }
    } catch (error) { backupMessage = backendMessage(error); }
    finally { backupBusy = false; render(true); }
  }));
  const cancel = (): void => { if (backupBusy) return; restorePreview = null; void invoke("cancel_database_restore").catch((error) => { backupMessage = backendMessage(error); render(true); }); render(true); };
  root.querySelector<HTMLButtonElement>("[data-cancel-restore]")?.addEventListener("click", cancel);
  const dialog = root.querySelector<HTMLDialogElement>("[data-restore-dialog]");
  dialog?.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
  root.querySelector<HTMLFormElement>("[data-restore-confirm]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); if (!restorePreview || backupBusy) return;
    const token = restorePreview.token; backupBusy = true; backupMessage = "Восстановление…"; render(true);
    let restoredPath: string | null = null;
    try {
      const path = await invoke<string>("confirm_database_restore", { token });
      restoredPath = path;
      restorePreview = null; editingTaskId = null; fullscreenTimerId = null; taskAnimationLocks.clear();
      preferences = await invoke<typeof preferences>("get_preferences"); preferencesReady = true;
      await Promise.all([refreshTasks(), refreshTimers(false), loadShortcuts(), refreshDeletionUndos()]);
      const overlayStatus = await invoke<OverlayShortcutStatus>("get_overlay_shortcut_status");
      overlayShortcut = overlayStatus.shortcut; overlayShortcutAvailable = overlayStatus.available;
      backupMessage = `Данные восстановлены. Предыдущие данные сохранены: ${path}`;
      await refreshBackupStatus();
    } catch (error) { restorePreview = null; backupMessage = restoredPath ? `Данные восстановлены, но интерфейс не удалось обновить. Перезапустите приложение. Предыдущие данные: ${restoredPath}` : backendMessage(error); }
    finally { backupBusy = false; render(true); }
  });
  if (dialog && !dialog.open) dialog.showModal();
}

function renderSettings(): void {
  const previousScrollTop = root.querySelector<HTMLElement>(".settings-view")?.scrollTop ?? 0;
  root.innerHTML = `<div class="app-shell">${renderSidebar()}
  <main class="main-content settings-view"><h1>Настройки<span class="heading-period">.</span></h1>
    <section class="settings-section" aria-labelledby="theme-heading"><h2 id="theme-heading">Оформление</h2><label for="settings-theme">Тема</label>
    <select id="settings-theme" data-theme-select>${themeOrder.map((value) => `<option value="${value}" ${theme === value ? "selected" : ""}>${themeLabels[value]}</option>`).join("")}</select>
    <p role="alert" data-settings-error></p></section>
    ${renderAutostartSettings()}
    ${renderNotificationSettings()}
    <section class="settings-section"><h2>Задачи</h2><form data-preferences-form>
      <label for="reminder-minutes">Время до напоминания, минуты</label><input id="reminder-minutes" name="reminderMinutes" type="number" min="1" max="1439" step="1" required value="${preferences.reminderMinutes}" ${preferencesReady ? "" : "disabled"}/>
      <label for="archive-hours">Архивировать через, часы</label><input id="archive-hours" name="archiveHours" type="number" min="1" max="8760" step="1" required value="${preferences.archiveHours}" ${preferencesReady ? "" : "disabled"}/>
      <p>Срок отсчитывается от создания задачи. Архив сохраняет задачи и историю.</p>
      <button class="retry-button" type="submit" ${preferencesReady ? "" : "disabled"}>Сохранить</button><p role="status" data-preferences-status>${escapeHtml(preferencesError)}</p>
    </form></section>
    <section class="settings-section shortcut-section" aria-labelledby="shortcuts-heading"><h2 id="shortcuts-heading">Горячие клавиши</h2>
      <p>Нажмите поле и сочетание клавиш, затем сохраните. Escape отменяет ввод. Команды задач работают при фокусе на строке.</p>
      <p role="alert">${escapeHtml(shortcutsError)}</p>
      <div class="shortcut-table" role="table" aria-label="Горячие клавиши">
      ${([...Object.keys(shortcutLabels), "overlay"] as (ShortcutAction | "overlay")[]).map((action) => {
        const value = action === "overlay" ? overlayShortcut : shortcuts[action];
        return `<form class="shortcut-row" role="row" data-shortcut-form="${action}"><div role="cell"><label for="shortcut-${action}">${action === "overlay" ? "Показать / скрыть оверлей" : shortcutLabels[action]}</label><small>${action === "overlay" ? "Глобально" : "В приложении"}</small></div><div role="cell"><input id="shortcut-${action}" data-shortcut-capture data-combination="${escapeHtml(value)}" value="${escapeHtml(displayShortcut(value))}" readonly aria-label="Сочетание: ${action === "overlay" ? "Оверлей" : shortcutLabels[action]}" ${shortcutsReady ? "" : "disabled"}/></div><div role="cell"><button class="retry-button" type="submit" ${shortcutsReady ? "" : "disabled"}>Сохранить</button></div><p role="status" data-shortcut-status>${action === "overlay" && !overlayShortcutAvailable ? "Не удалось зарегистрировать сочетание. Выберите другое." : ""}</p></form>`;
      }).join("")}</div>
    </section>
    ${renderBackupSettings()}
    <section class="settings-section"><h2>Данные</h2><button class="retry-button" type="button" data-export-json>Выгрузить JSON в Загрузки</button><p role="status" data-export-status></p></section>
  </main></div>`;
  bindEvents();
  bindBackupSettings();
  bindAutostartSettings();
  root.querySelectorAll<HTMLInputElement>("[data-shortcut-capture]").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Tab") return;
      event.preventDefault(); event.stopPropagation();
      const action = input.closest<HTMLFormElement>("form")!.dataset.shortcutForm as ShortcutAction | "overlay";
      if (event.key === "Escape") { const value = action === "overlay" ? overlayShortcut : shortcuts[action]; input.dataset.combination = value; input.value = displayShortcut(value); input.blur(); return; }
      const combination = keyboardCombination(event);
      if (combination) { input.dataset.combination = combination; input.value = displayShortcut(combination); }
    });
  });
  root.querySelectorAll<HTMLFormElement>("[data-shortcut-form]").forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = form.dataset.shortcutForm as ShortcutAction | "overlay";
    const input = form.querySelector<HTMLInputElement>("input")!;
    const button = form.querySelector<HTMLButtonElement>("button")!;
    const status = form.querySelector<HTMLElement>("[data-shortcut-status]")!;
    button.disabled = true; input.disabled = true;
    try {
      if (action === "overlay") { const result = await invoke<OverlayShortcutStatus>("set_overlay_shortcut", { shortcut: input.dataset.combination }); overlayShortcut = result.shortcut; overlayShortcutAvailable = result.available; }
      else shortcuts = await invoke<typeof shortcuts>("update_shortcut", { action, combination: input.dataset.combination });
      status.textContent = "Сохранено";
    } catch (error) { status.textContent = backendMessage(error); }
    finally { button.disabled = false; input.disabled = false; }
  }));
  root.querySelector<HTMLFormElement>("[data-preferences-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form); const next = { reminderMinutes: Number(values.get("reminderMinutes")), archiveHours: Number(values.get("archiveHours")) };
    const button = form.querySelector<HTMLButtonElement>("button")!; button.disabled = true;
    const status = form.querySelector<HTMLElement>("[data-preferences-status]")!;
    try { await invoke("update_preferences", next); preferences = next; status.textContent = "Сохранено"; }
    catch (error) { status.textContent = backendMessage(error); }
    finally { button.disabled = false; }
  });
  root.querySelector<HTMLButtonElement>("[data-export-json]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    const status = root.querySelector<HTMLElement>("[data-export-status]")!;
    try { const path = await invoke<string>("export_user_data", { theme }); status.textContent = `Сохранено: ${path}`; }
    catch (error) { status.textContent = backendMessage(error); }
    finally { button.disabled = false; }
  });
  root.querySelector<HTMLSelectElement>("[data-theme-select]")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value as Theme;
    try { localStorage.setItem(themeStorageKey, value); theme = value; applyTheme(); }
    catch { root.querySelector<HTMLElement>("[data-settings-error]")!.textContent = "Не удалось сохранить тему. Повторите попытку."; }
  });
  const settingsPage = root.querySelector<HTMLElement>(".settings-view");
  if (settingsPage) settingsPage.scrollTop = previousScrollTop;
}

function renderTimers(): void {
  const focused = timers.find((timer) => timer.id === fullscreenTimerId);
  root.innerHTML = `<div class="app-shell ${focused ? "is-timer-fullscreen" : ""}">
    ${focused ? "" : renderSidebar()}
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
  if (mouseDragActive) return;
  if (taskAnimationLocks.size > 0 && !allowDuringAnimation) return;
  if (activeView === "settings") { renderSettings(); return; }
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
             <button class="retry-button" type="button" data-retry-load>Повторить</button><button class="retry-button" type="button" data-view="settings">Восстановление данных</button>
           </div>`
        : `<div class="empty-state">
           <strong>${showingToday ? "Задач пока нет" : "Выполненных задач сегодня нет"}</strong>
         </div>`;

  root.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}

      <main class="main-content ${showingToday ? "is-today-view" : showingHistory ? "is-history-view" : "is-completed-view"}" id="${activeView}">
        <section class="day-heading" aria-labelledby="page-title">
          <div>
            <p class="eyebrow">${escapeHtml(headingDateLabel)} / ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(headingDate)}</p>
            <h1 id="page-title">${showingToday ? 'План на день<span class="heading-period">.</span>' : showingHistory ? 'История<span class="heading-period">.</span>' : 'Выполнено<span class="heading-period">.</span>'}</h1>
          </div>
          <div class="day-actions">
            <div class="day-progress" aria-label="${showingHistory ? "Задач за дату" : showingToday ? "Активных" : "Выполненных сегодня"} задач: ${showingHistory ? historyCount : visibleTasks.length}">
              <span class="progress-count">${String(showingHistory ? historyCount : visibleTasks.length).padStart(2, "0")}</span>
            </div>
            <button class="overlay-toggle" type="button" data-toggle-overlay>Оверлей</button>
            ${overlayShortcutAvailable ? "" : `<button class="overlay-shortcut-warning" type="button" data-open-overlay-shortcut>Настроить клавишу</button>`}
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
          return `<dialog class="reminder-dialog" data-reminder-dialog><form data-reminder-form="${task.id}"><h2>Напоминание</h2><label for="reminder-time">Время сегодня</label><input id="reminder-time" name="reminderAt" type="time" step="60" required value="${reminderInputValue(task.reminderAt)}"/><p class="reminder-dialog-error" role="alert">${escapeHtml(reminderDialogError)}</p><div data-reminder-notification-warning ${notificationStatus !== null && !notificationStatus.canTest ? "" : "hidden"}><p>${escapeHtml(notificationStatus?.message ?? "")}</p><button class="retry-button" type="button" data-open-notification-settings>Настройки Windows</button></div><div class="reminder-actions">${task.reminderAt !== null ? `<button type="button" data-clear-reminder="${task.id}">Удалить</button>` : ""}<button type="button" data-close-reminder>Отмена</button><button type="submit">Сохранить</button></div></form></dialog>`;
        })() : ""}
        ${overlayShortcutDialogOpen ? `<dialog class="reminder-dialog" data-overlay-shortcut-dialog><form data-overlay-shortcut-form><h2>Горячая клавиша</h2><label for="overlay-shortcut-input">Сочетание клавиш</label><input id="overlay-shortcut-input" name="shortcut" type="text" value="${escapeHtml(overlayShortcut)}" placeholder="Ctrl+Shift+O" required aria-describedby="overlay-shortcut-help"/><small id="overlay-shortcut-help">Например: Ctrl+Shift+O</small><p class="reminder-dialog-error" role="alert">${escapeHtml(overlayShortcutError)}</p><div class="reminder-actions"><button type="button" data-close-overlay-shortcut>Отмена</button><button type="submit">Сохранить</button></div></form></dialog>` : ""}

      </main>
      <span class="visually-hidden" role="status" aria-live="polite">${escapeHtml(announcement)}</span>
    </div>`;

  bindEvents();
  animatePositionChanges(previousPositions);
  animateEnteringTasks();
  const reminderDialog = root.querySelector<HTMLDialogElement>("[data-reminder-dialog]");
  if (reminderDialog && !reminderDialog.open) reminderDialog.showModal();
  const shortcutDialog = root.querySelector<HTMLDialogElement>("[data-overlay-shortcut-dialog]");
  if (shortcutDialog && !shortcutDialog.open) shortcutDialog.showModal();
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
  root.querySelectorAll<HTMLButtonElement>("[data-delete-task]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.deleteTask; if (!id || saving || taskAnimationLocks.has(id)) return;
    const deleted = await perform(async () => {
      const undo = await invoke<UndoDeletion>("delete_task", { id });
      deletionUndos = [...deletionUndos.filter((item) => item.taskId !== id), undo]; undoMessage = ""; renderDeletionUndos();
    });
    if (deleted) { await refreshDeletionUndos(); if (activeView === "history") await refreshHistory(); }
  }));
  bindNotificationControls();
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
  root.querySelectorAll<HTMLButtonElement>("[data-edit-reminder]").forEach((button) => button.addEventListener("click", async () => {
    try { preferences = await invoke<typeof preferences>("get_preferences"); preferencesReady = true; }
    catch (error) { errorMessage = backendMessage(error); render(true); return; }
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

  root.querySelector<HTMLButtonElement>("[data-toggle-overlay]")?.addEventListener("click", async () => {
    try { await invoke("toggle_task_overlay"); }
    catch (error) { errorMessage = backendMessage(error); render(true); }
  });
  root.querySelector<HTMLButtonElement>("[data-open-overlay-shortcut]")?.addEventListener("click", () => { overlayShortcutError = ""; overlayShortcutDialogOpen = true; render(true); });
  root.querySelector<HTMLButtonElement>("[data-close-overlay-shortcut]")?.addEventListener("click", () => { overlayShortcutDialogOpen = false; overlayShortcutError = ""; render(true); });
  root.querySelector<HTMLFormElement>("[data-overlay-shortcut-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const shortcut = String(new FormData(event.currentTarget as HTMLFormElement).get("shortcut") ?? "").trim();
    try {
      const status = await invoke<OverlayShortcutStatus>("set_overlay_shortcut", { shortcut });
      overlayShortcut = status.shortcut;
      overlayShortcutAvailable = status.available;
      overlayShortcutError = "";
      overlayShortcutDialogOpen = false;
      render(true);
    } catch (error) {
      overlayShortcutError = backendMessage(error);
      render(true);
    }
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
    row.addEventListener("pointerdown", (event) => {
      if (saving || mouseDragActive || taskAnimationLocks.size || event.button !== 0 || (event.target as HTMLElement).closest("button, input, a")) return;
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
        for (const animation of animations.values()) animation.cancel();
        ordered.forEach((item, index) => {
          item.style.order = String(index);
          const number = item.querySelector<HTMLElement>(".position-current");
          if (number) number.textContent = String(index + 1).padStart(2, "0");
          item.querySelector("[data-position]")?.setAttribute("aria-label", `Задача ${index + 1}`);
        });
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) for (const item of original) {
          if (item === row) continue;
          const previous = before.get(item)!;
          const next = item.getBoundingClientRect();
          animations.set(item, item.animate([{ transform: `translateY(${previous.top - next.top}px)` }, { transform: "translateY(0)" }], { duration: 200, easing: "ease-out" }));
        }
      };
      original.forEach((item, index) => { item.style.order = String(index); });
      const tick = (): void => {
        if (!preview) return;
        preview.style.left = `${Math.max(0, Math.min(window.innerWidth - bounds.width, x - offsetX))}px`;
        preview.style.top = `${Math.max(0, Math.min(window.innerHeight - bounds.height, y - offsetY))}px`;
        const listBounds = list.getBoundingClientRect();
        if (y > listBounds.bottom - 40) list.scrollTop += 10;
        else if (y < listBounds.top + 40) list.scrollTop -= 10;
        let targetIndex = ordered.indexOf(row), distance = Infinity;
        for (const [index, item] of ordered.entries()) {
          const d = Math.abs(y - (listBounds.top + item.offsetTop - list.scrollTop + item.offsetHeight / 2));
          if (d < distance) { distance = d; targetIndex = index; }
        }
        if (targetIndex !== ordered.indexOf(row)) {
          ordered.splice(ordered.indexOf(row), 1);
          ordered.splice(targetIndex, 0, row);
          arrange();
          const number = preview.querySelector<HTMLElement>(".position-current");
          if (number) number.textContent = String(targetIndex + 1).padStart(2, "0");
        }
        frame = requestAnimationFrame(tick);
      };
      const hold = window.setTimeout(() => {
        mouseDragActive = true;
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
        clearTimeout(hold); cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        window.removeEventListener("keydown", escape);
        if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
        preview?.remove(); row.classList.remove("is-drag-source");
        document.body.classList.remove("is-task-dragging");
        const didDrag = mouseDragActive;
        mouseDragActive = false;
        const ids = ordered.map((item) => item.dataset.taskId!);
        if (!cancelled && didDrag && ids.some((id, index) => id !== originalIds[index])) void saveOrder(ids, ids.indexOf(row.dataset.taskId!));
        else { ordered = [...original]; arrange(); }
      };
      const move = (e: PointerEvent): void => { x = e.clientX; y = e.clientY; if (preview) { e.preventDefault(); window.getSelection()?.removeAllRanges(); } };
      const up = (): void => finish();
      const cancel = (): void => finish(true);
      const escape = (e: KeyboardEvent): void => { if (e.key === "Escape") finish(true); };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      window.addEventListener("keydown", escape);
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
  }
  render();
  if (index >= 0) root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(movedId)}"]`)?.focus();
}

function bindOverlayTimerDrag(card: HTMLElement, pinned: boolean, reorder: (ids: string[]) => void, setDragging: (value: boolean) => void): void {
  card.classList.toggle("is-reorder-locked", pinned);
  card.tabIndex = 0;
  card.setAttribute("aria-keyshortcuts", `${shortcuts.move_up} ${shortcuts.move_down}`);
  card.onkeydown = (event) => {
    const combination = keyboardCombination(event);
    if (pinned || (event.target as HTMLElement).closest("button, input") || (combination !== shortcuts.move_up && combination !== shortcuts.move_down)) return;
    event.preventDefault();
    const grid = card.parentElement!;
    const cards = [...grid.querySelectorAll<HTMLElement>("[data-timer-card]")].sort((a, b) => Number(a.style.order) - Number(b.style.order));
    const index = cards.indexOf(card);
    const target = index + (combination === shortcuts.move_up ? -1 : 1);
    if (target < 0 || target >= cards.length) return;
    [cards[index], cards[target]] = [cards[target], cards[index]];
    cards.forEach((item, position) => { item.style.order = String(position); });
    reorder(cards.map((item) => item.dataset.timerCard!));
  };
  card.onpointerdown = (event) => {
    if (pinned || event.button !== 0 || (event.target as HTMLElement).closest("button") || card.classList.contains("is-evaporating")) return;
    const grid = card.parentElement!;
    const area = grid.parentElement!;
    const cards = [...grid.querySelectorAll<HTMLElement>("[data-timer-card]")].sort((a, b) => Number(a.style.order) - Number(b.style.order));
    const original = cards.map((item) => item.dataset.timerCard!);
    const bounds = card.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const offsetY = event.clientY - bounds.top;
    let x = event.clientX, y = event.clientY;
    let preview: HTMLElement | null = null;
    let frame = 0;
    const animations = new Map<HTMLElement, Animation>();
    const positionCards = (ordered: HTMLElement[]): void => {
      const before = new Map(cards.map((item) => [item, item.getBoundingClientRect()]));
      for (const animation of animations.values()) animation.cancel();
      ordered.forEach((item, index) => { item.style.order = String(index); });
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        for (const item of cards) {
          if (item === card) continue;
          const old = before.get(item)!;
          const next = item.getBoundingClientRect();
          animations.set(item, item.animate([{ transform: `translate(${old.left - next.left}px, ${old.top - next.top}px)` }, { transform: "translate(0, 0)" }], { duration: 200, easing: "ease-out" }));
        }
      }
    };
    const tick = (): void => {
      if (!preview) return;
      preview.style.left = `${Math.max(0, Math.min(window.innerWidth - bounds.width, x - offsetX))}px`;
      preview.style.top = `${Math.max(0, Math.min(window.innerHeight - bounds.height, y - offsetY))}px`;
      const areaBounds = area.getBoundingClientRect();
      if (x > areaBounds.right - 40) area.scrollLeft += 12;
      else if (x < areaBounds.left + 40) area.scrollLeft -= 12;
      const ordered = [...cards].sort((a, b) => Number(a.style.order) - Number(b.style.order));
      let nearest = card, distance = Infinity;
      for (const item of cards) {
        const gridBounds = grid.getBoundingClientRect();
        const d = Math.hypot(x - (gridBounds.left + item.offsetLeft + item.offsetWidth / 2), y - (gridBounds.top + item.offsetTop + item.offsetHeight / 2));
        if (d < distance) { nearest = item; distance = d; }
      }
      if (nearest !== card) {
        const index = ordered.indexOf(nearest);
        ordered.splice(ordered.indexOf(card), 1);
        ordered.splice(index, 0, card);
        positionCards(ordered);
      }
      frame = requestAnimationFrame(tick);
    };
    const hold = window.setTimeout(() => {
      window.getSelection()?.removeAllRanges();
      setDragging(true);
      card.setPointerCapture(event.pointerId);
      preview = card.cloneNode(true) as HTMLElement;
      preview.removeAttribute("data-timer-card");
      preview.removeAttribute("tabindex");
      preview.setAttribute("aria-hidden", "true");
      preview.classList.remove("is-entering");
      preview.classList.add("overlay-timer-drag-preview");
      document.body.append(preview);
      card.classList.add("is-timer-drag-source");
      document.body.classList.add("is-overlay-timer-dragging");
      tick();
    }, 180);
    const finish = (cancelled = false): void => {
      window.clearTimeout(hold);
      cancelAnimationFrame(frame);
      if (preview) {
        if (cancelled) positionCards(original.map((id) => cards.find((item) => item.dataset.timerCard === id)!));
        else reorder([...cards].sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((item) => item.dataset.timerCard!));
        preview.remove();
        card.classList.remove("is-timer-drag-source");
        document.body.classList.remove("is-overlay-timer-dragging");
        setDragging(false);
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
      if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
    };
    const move = (moveEvent: PointerEvent): void => { x = moveEvent.clientX; y = moveEvent.clientY; if (preview) moveEvent.preventDefault(); };
    const up = (): void => finish();
    const cancel = (): void => finish(true);
    const escape = (key: KeyboardEvent): void => { if (key.key === "Escape") finish(true); };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
  };
}

async function renderOverlay(): Promise<void> {
  const overlayRoot = root;
  let overlayError = "";
  let lastRenderKey = "";
  let previousRunningIds = new Set<string>();
  const visibleTimerIds = new Set<string>();
  const hiddenTimerIds = new Set<string>();
  let lastTimerCount = -1;
  let loadingOverlay = false;
  let draggingOverlayTimer = false;
  let shownTaskId: string | null = null;
  const enteringTimerIds = new Set<string>();
  const endingTimers = new Map<string, Timer>();
  const load = async (): Promise<void> => {
    if (loadingOverlay || draggingOverlayTimer) return;
    loadingOverlay = true;
    try {
      const active = (await invoke<Task[]>("list_tasks")).filter((task) => task.status === "active").sort((a, b) => a.position - b.position);
      const allTimers = await invoke<Timer[]>("list_timers");
      theme = readTheme(); applyTheme();
      for (const timer of allTimers) if (timer.status === "running" && !hiddenTimerIds.has(timer.id)) visibleTimerIds.add(timer.id);
      const runningTimers = [...visibleTimerIds].map((id) => allTimers.find((timer) => timer.id === id)).filter((timer): timer is Timer => Boolean(timer && timer.status !== "finished"));
      const runningIds = new Set(runningTimers.map((timer) => timer.id));
      for (const timer of runningTimers) {
        if (!previousRunningIds.has(timer.id)) {
          enteringTimerIds.add(timer.id);
          window.setTimeout(() => { enteringTimerIds.delete(timer.id); void load(); }, 520);
        }
      }
      for (const id of previousRunningIds) {
        if (!runningIds.has(id)) {
          const finished = allTimers.find((timer) => timer.id === id && timer.status === "finished");
          if (finished) {
            endingTimers.set(id, finished);
            window.setTimeout(() => { endingTimers.delete(id); visibleTimerIds.delete(id); void load(); }, 900);
          }
        }
      }
      previousRunningIds = runningIds;
      const displayTimers = [...visibleTimerIds].map((id) => endingTimers.get(id) ?? runningTimers.find((timer) => timer.id === id)).filter((timer): timer is Timer => Boolean(timer));
      if (displayTimers.length !== lastTimerCount) {
        lastTimerCount = displayTimers.length;
        void invoke<number>("resize_overlay_for_timers", { timerCount: displayTimers.length }).then((rows) => { document.documentElement.style.setProperty("--overlay-rows", String(rows)); });
      }
      const pinned = await invoke<boolean>("get_overlay_pinned");
      const task = active[0];
      const renderKey = JSON.stringify([task?.id, task?.title, task?.position, pinned, overlayError, displayTimers.map((timer) => [timer.id, timer.status, endingTimers.has(timer.id)])]);
      if (renderKey === lastRenderKey) {
        for (const timer of displayTimers) {
          const card = overlayRoot.querySelector<HTMLElement>(`[data-timer-card="${CSS.escape(timer.id)}"]`);
          const clock = card?.querySelector<HTMLElement>("[data-timer-clock]");
          const progress = card?.querySelector<SVGCircleElement>(".timer-ring-progress");
          if (clock) clock.textContent = formatTimerTime(timer.remainingSeconds);
          if (progress) {
            const circumference = 2 * Math.PI * 86;
            const ratio = timer.durationSeconds > 0 ? timer.remainingSeconds / timer.durationSeconds : 0;
            progress.setAttribute("stroke-dashoffset", String(circumference * (1 - ratio)));
          }
        }
        return;
      }
      const taskChanged = shownTaskId !== null && shownTaskId !== (task?.id ?? null);
      if (taskChanged) {
        const oldText = overlayRoot.querySelector<HTMLElement>(".overlay-task, .overlay-empty");
        if (oldText && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          await oldText.animate([{ opacity: 1, transform: "translateX(0)" }, { opacity: 0, transform: "translateX(-32px)" }], { duration: 220, easing: "ease-in", fill: "forwards" }).finished;
        }
      }
      shownTaskId = task?.id ?? null;
      const retainedCards = new Map([...overlayRoot.querySelectorAll<HTMLElement>("[data-timer-card]")].map((card) => [card.dataset.timerCard!, card]));
      lastRenderKey = renderKey;
      const staged = document.createElement("div");
      staged.innerHTML = `<section class="overlay-card" aria-label="Следующая задача">
        <header class="overlay-header ${pinned ? "is-pinned" : ""}"><span>СЛЕДУЮЩАЯ ЗАДАЧА</span><button type="button" class="overlay-pin ${pinned ? "is-pinned" : ""}" data-overlay-pin aria-label="${pinned ? "Снять закрепление и разрешить перемещение" : "Закрепить положение поверх окон"}" title="${pinned ? "Открепить" : "Закрепить положение и поверх окон"}">${pinned ? "◆" : "◇"}</button></header>
        ${task ? `<div class="overlay-task"><strong>${escapeHtml(task.title)}</strong></div>
          <footer class="overlay-actions"><button type="button" data-overlay-complete="${task.id}">Выполнено</button><button type="button" data-overlay-open>Открыть список</button></footer>`
          : `<div class="overlay-empty"><strong>На сегодня всё</strong><button type="button" data-overlay-open>Добавить задачу</button></div>`}
        ${overlayError ? `<p class="overlay-error" role="alert">${escapeHtml(overlayError)} <button type="button" data-overlay-retry>Повторить</button></p>` : ""}
      </section>`;
      if (displayTimers.length) {
        staged.insertAdjacentHTML("beforeend", `<section class="overlay-timer-area" aria-label="Запущенные таймеры"><div class="overlay-timer-grid">${displayTimers.map((timer) => timerCard(timer, false, true).replace('class="timer-card ', `class="timer-card ${enteringTimerIds.has(timer.id) ? "is-entering" : ""} ${endingTimers.has(timer.id) ? "is-evaporating" : ""} `)).join("")}</div></section>`);
      }
      const nextHeader = staged.querySelector<HTMLElement>(".overlay-card")!;
      const currentHeader = overlayRoot.querySelector<HTMLElement>(".overlay-card");
      if (!currentHeader) overlayRoot.prepend(nextHeader);
      else currentHeader.replaceWith(nextHeader);
      let grid = overlayRoot.querySelector<HTMLElement>(".overlay-timer-grid");
      if (!grid && displayTimers.length) {
        const area = document.createElement("section");
        area.className = "overlay-timer-area";
        area.setAttribute("aria-label", "Запущенные таймеры");
        grid = document.createElement("div");
        grid.className = "overlay-timer-grid";
        area.append(grid);
        overlayRoot.append(area);
      }
      const wanted = new Set(displayTimers.map((timer) => timer.id));
      for (const [id, card] of retainedCards) if (!wanted.has(id)) card.remove();
      for (const next of staged.querySelectorAll<HTMLElement>("[data-timer-card]")) {
        const id = next.dataset.timerCard!;
        const old = retainedCards.get(id);
        if (old) {
          old.classList.toggle("is-evaporating", endingTimers.has(id));
          if (!enteringTimerIds.has(id)) old.classList.remove("is-entering");
          if (old.dataset.timerStatus !== next.dataset.timerStatus) {
            old.dataset.timerStatus = next.dataset.timerStatus;
            old.querySelector(".timer-controls")?.replaceWith(next.querySelector(".timer-controls")!);
          }
        } else grid?.append(next);
      }
      displayTimers.forEach((timer, index) => {
        const card = overlayRoot.querySelector<HTMLElement>(`[data-timer-card="${CSS.escape(timer.id)}"]`);
        if (!card) return;
        card.style.order = String(index);
        bindOverlayTimerDrag(card, pinned, (ids) => {
          const remaining = [...visibleTimerIds].filter((id) => !ids.includes(id));
          visibleTimerIds.clear();
          [...ids, ...remaining].forEach((id) => visibleTimerIds.add(id));
          lastRenderKey = "";
        }, (value) => { draggingOverlayTimer = value; if (!value) void load(); });
      });
      if (!displayTimers.length) overlayRoot.querySelector(".overlay-timer-area")?.remove();
      if (taskChanged) overlayRoot.querySelector<HTMLElement>(".overlay-task, .overlay-empty")?.animate([{ opacity: 0, transform: "translateX(32px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280, easing: "ease-out" });
      overlayRoot.querySelectorAll<HTMLButtonElement>("[data-hide-overlay-timer]").forEach((button) => { button.onclick = () => {
        const id = button.dataset.hideOverlayTimer;
        if (!id) return;
        hiddenTimerIds.add(id);
        const timer = runningTimers.find((item) => item.id === id);
        if (timer) endingTimers.set(id, timer);
        previousRunningIds.delete(id);
        void load();
        window.setTimeout(() => { visibleTimerIds.delete(id); endingTimers.delete(id); void load(); }, 900);
      }; });
      overlayRoot.querySelector<HTMLElement>(".overlay-header")?.addEventListener("pointerdown", (event) => {
        if (pinned || (event.target as HTMLElement).closest("button")) return;
        void getCurrentWindow().startDragging().catch((error: unknown) => { overlayError = backendMessage(error); });
      });
      overlayRoot.querySelectorAll<HTMLButtonElement>("[data-timer-action]").forEach((button) => { button.onclick = async () => {
        const id = button.dataset.timerId;
        const action = button.dataset.timerAction;
        if (!id || !action) return;
        try {
          if (action === "delete") await invoke("delete_timer", { id });
          else if (action === "pause") await invoke("pause_timer", { id });
          else if (action === "reset") await invoke("reset_timer", { id });
          else {
            const timer = displayTimers.find((item) => item.id === id);
            if (timer?.status === "finished") await invoke("reset_timer", { id });
            await invoke("start_timer", { id });
          }
          overlayError = "";
          await load();
        } catch (error) { overlayError = backendMessage(error); await load(); }
      }; });
      overlayRoot.querySelectorAll<HTMLButtonElement>("[data-timer-fullscreen]").forEach((button) => { button.onclick = () => {
        const id = button.dataset.timerFullscreen;
        if (id) void invoke("open_overlay_timer_focus", { id });
      }; });
      overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-pin]")?.addEventListener("click", async () => {
        try { await invoke("set_overlay_pinned", { pinned: !pinned }); overlayError = ""; await load(); }
        catch (error) { overlayError = backendMessage(error); await load(); }
      });
      overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-complete]")?.addEventListener("click", async (event) => {
        const id = (event.currentTarget as HTMLButtonElement).dataset.overlayComplete;
        if (!id) return;
        try { await invoke("complete_overlay_task", { id }); overlayError = ""; await load(); }
        catch (error) { overlayError = backendMessage(error); await load(); }
      });
      overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-open]")?.addEventListener("click", () => { void invoke("open_task_list"); });
      overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-retry]")?.addEventListener("click", () => { overlayError = ""; void load(); });
    } catch (error) {
      overlayError = backendMessage(error);
      overlayRoot.innerHTML = `<section class="overlay-card overlay-failed"><strong>Очередь недоступна</strong><p role="alert">${escapeHtml(overlayError)}</p><button type="button" data-overlay-retry>Повторить</button></section>`;
      overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-retry]")?.addEventListener("click", () => { overlayError = ""; void load(); });
    }
    finally { loadingOverlay = false; }
  };
  await load();
  void listen("tasks-changed", () => { void load(); });
  void listen("overlay-settings-error", () => { overlayError = "Не удалось сохранить положение оверлея."; void load(); });
  window.setInterval(() => { void load(); }, 500);
}

async function loadShortcuts(): Promise<void> {
  try { shortcuts = await invoke<typeof shortcuts>("get_shortcuts"); shortcutsReady = true; shortcutsError = ""; }
  catch (error) { shortcutsReady = false; shortcutsError = backendMessage(error); }
  if (getCurrentWindow().label !== "overlay" && activeView === "settings") render(true);
}
void loadShortcuts();
void listen<typeof shortcuts>("shortcuts-changed", ({ payload }) => { shortcuts = payload; shortcutsReady = true; });

if (getCurrentWindow().label === "overlay") {
  applyTheme();
  document.body.classList.add("overlay-mode");
  void renderOverlay();
  void listen("database-restored", () => window.location.reload());
} else {
applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "system") applyTheme();
});
const syncViewFromHash = (): void => {
  const nextView: View = window.location.hash === "#settings" ? "settings" : window.location.hash === "#completed" ? "completed" : window.location.hash === "#history" ? "history" : window.location.hash === "#timers" ? "timers" : "today";
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
void listen<string | null>("reminder-delivery-error", ({ payload }) => {
  errorMessage = typeof payload === "string" ? payload : "Не удалось отправить уведомление. Проверьте Параметры Windows → Система → Уведомления.";
  notificationActionMessage = errorMessage;
  if (activeView === "settings") updateNotificationControls(); else render(true);
  void refreshNotificationStatus();
});
void listen("reminder-runtime-error", () => {
  errorMessage = "Не удалось обработать напоминание. Перезапустите приложение.";
  render(true);
});
void refreshAutostart();
void refreshNotificationStatus();
window.addEventListener("focus", () => { if (activeView === "settings") void refreshAutostart(); void refreshNotificationStatus(); });
void refreshBackupStatus();
void invoke<typeof preferences>("get_preferences").then((value) => { preferences = value; preferencesReady = true; if (activeView === "settings") render(true); }).catch((error) => { preferencesError = backendMessage(error); if (activeView === "settings") render(true); });
render();
void refreshTasks();
if (activeView === "history") void refreshHistory();
if (activeView === "timers") void refreshTimers();
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.repeat || !shortcutsReady || mouseDragActive || (event.target as HTMLElement).closest("[data-shortcut-capture]")) return;
  const combination = keyboardCombination(event);
  const action = (Object.keys(shortcuts) as ShortcutAction[]).find((key) => shortcuts[key] === combination);
  if (!action) return;
  event.preventDefault();
  if (root.querySelector("dialog[open]")) return;
  const target = event.target as HTMLElement;
  const taskAction = ["rename", "reminder", "move_up", "move_down"].includes(action);
  const row = target.closest<HTMLElement>("[data-task-id][data-reorderable='true']");
  if (taskAction && (!row || target.closest("input, textarea, select, [contenteditable='true']") || saving || taskAnimationLocks.has(row.dataset.taskId ?? ""))) return;
  event.preventDefault();
  if (taskAction && row) {
    const id = row.dataset.taskId!;
    if (action === "rename") { editingTaskId = id; render(true); }
    else if (action === "reminder") row.querySelector<HTMLButtonElement>("[data-edit-reminder]")?.click();
    else { const ids = activeTasks().map((task) => task.id); const index = ids.indexOf(id); const next = index + (action === "move_up" ? -1 : 1); if (index >= 0 && next >= 0 && next < ids.length) { [ids[index], ids[next]] = [ids[next], ids[index]]; void saveOrder(ids, next); } }
    return;
  }
  if (action === "new_task" && activeView === "today" && !fullscreenTimerId) { root.querySelector<HTMLInputElement>("#new-task-title")?.focus(); return; }
  fullscreenTimerId = null;
  const nextView: View = action === "new_task" ? "today" : action === "new_timer" ? "timers" : action as View;
  activeView = nextView; window.history.pushState(null, "", `#${nextView}`);
  if (action === "new_timer") { timerDialogOpen = true; timerError = ""; }
  render(true);
  if (nextView === "history") void refreshHistory();
  if (nextView === "timers") void refreshTimers();
  if (action === "new_task") root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
});
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
void listen<string | null>("timer-notification-error", ({ payload }) => {
  timerError = typeof payload === "string" ? payload : "Не удалось отправить уведомление. Проверьте Параметры Windows → Система → Уведомления.";
  notificationActionMessage = timerError;
  if (activeView === "timers") render(true); else if (activeView === "settings") updateNotificationControls();
  void refreshNotificationStatus();
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
void listen("tasks-changed", () => { void refreshTasks(); void refreshDeletionUndos(); if (activeView === "history") void refreshHistory(); });
void listen("overlay-open-today", () => {
  activeView = "today";
  window.history.pushState(null, "", "#today");
  render(true);
  root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
});
void listen<string>("overlay-open-timer-focus", ({ payload }) => {
  activeView = "timers";
  fullscreenTimerId = payload;
  window.history.pushState(null, "", "#timers");
  void refreshTimers();
});
void listen<string>("overlay-shortcut-error", ({ payload }) => {
  overlayShortcutAvailable = false;
  errorMessage = `${payload} Проверьте, не занято ли сочетание другой программой.`;
  render(true);
});
void invoke<OverlayShortcutStatus>("get_overlay_shortcut_status").then((status) => {
  overlayShortcut = status.shortcut;
  overlayShortcutAvailable = status.available;
  if (!status.available) errorMessage = `Не удалось зарегистрировать ${status.shortcut}. Можно выбрать другое сочетание клавиш.`;
  render(true);
}).catch((error) => {
  errorMessage = backendMessage(error);
  render(true);
});
}
