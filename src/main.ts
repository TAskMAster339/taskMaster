import { t, backendText, setLanguage, language, locale, languages, languageNames, type Language } from "./i18n.ts";
import { defaultShortcuts, shortcutLabels, keyboardCombination, displayShortcut, type ShortcutAction } from "./shortcuts";
import { appendInBatches } from "./batches";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface DisplaySettings { language: Language; highContrast: boolean; }
let displaySettings: DisplaySettings = { language: "ja", highContrast: false };
let displaySettingsReady = false;
let displaySettingsError = "";
try {
  displaySettings = await invoke<DisplaySettings>("get_display_settings");
  setLanguage(displaySettings.language); displaySettingsReady = true;
} catch (error) { displaySettingsError = backendMessage(error); }
document.documentElement.lang = language();
const displayWarning = document.createElement("p"); displayWarning.className = "display-warning";
displayWarning.setAttribute("role", "alert"); displayWarning.hidden = !displaySettingsError;
displayWarning.textContent = displaySettingsError; document.body.append(displayWarning);

type TaskStatus = "active" | "completed" | "archived";
type Theme = "system" | "dark" | "light";

const themeStorageKey = "taskmaster.theme";
const themeOrder: Theme[] = ["system", "dark", "light"];
const themeLabels: Record<Theme, string> = { get system() { return t("Системная"); }, get dark() { return t("Тёмная"); }, get light() { return t("Светлая"); } };

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
let taskPointerHeld = false;
const taskAnimationLocks = new Set<string>();
const taskAnimationErrors: string[] = [];
const liveStatus = document.createElement("div");
liveStatus.id = "app-status"; liveStatus.className = "visually-hidden";
liveStatus.setAttribute("role", "status"); liveStatus.setAttribute("aria-live", "polite"); liveStatus.setAttribute("aria-atomic", "true");
document.body.append(liveStatus);
function announce(message: string): void { liveStatus.textContent = message; }
function preserveTimerFocus(scope: ParentNode): () => void {
  const control = document.activeElement as HTMLElement | null;
  const card = control?.closest<HTMLElement>("[data-timer-card]");
  if (!control || !card || !scope.contains(control)) return () => {};
  const id = card.dataset.timerCard!;
  const action = control.dataset.timerAction;
  const fullscreen = control.hasAttribute("data-timer-fullscreen");
  const exiting = control.hasAttribute("data-exit-fullscreen");
  return () => {
    const nextCard = scope.querySelector<HTMLElement>(`[data-timer-card="${CSS.escape(id)}"]`);
    const selector = action === "start" || action === "pause" ? '[data-timer-action="start"], [data-timer-action="pause"]' : action ? `[data-timer-action="${action}"]` : fullscreen ? "[data-exit-fullscreen], [data-timer-fullscreen]" : exiting ? "[data-timer-fullscreen]" : "button";
    const target = nextCard?.querySelector<HTMLElement>(selector) ?? scope.querySelector<HTMLElement>("[data-add-timer]");
    target?.focus({ preventScroll: true });
  };
}
const skipLink = document.createElement("a"); skipLink.className = "skip-link"; skipLink.href = "#today";
skipLink.textContent = t("Перейти к содержимому");
skipLink.addEventListener("click", (event) => { event.preventDefault(); const main = root.querySelector<HTMLElement>("main"); main?.setAttribute("tabindex", "-1"); main?.focus({ preventScroll: true }); });
document.body.prepend(skipLink);
let theme: Theme = readTheme();
let appVersion = "";
let appVersionError = "";
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
let cancelListAppend: () => void = () => {};
let pendingTaskFocusId: string | null = null;

function focusTaskWhenRendered(id: string): void {
  const row = root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
  if (row) { row.focus(); pendingTaskFocusId = null; }
  else pendingTaskFocusId = id;
}
let reminderEditingTaskId: string | null = null;
let reminderDialogError = "";
let reminderDraft = "";
let reminderSaving = false;
let reminderOpening = false;
let reminderReturn: { id: string; view: View; scrollTop: number; restoreFocus: boolean; signature: string } | null = null;
function reminderListSignature(): string {
  return JSON.stringify(activeTasks().map(({ id, title, status, position }) => [id, title, status, position]));
}
function updateRetainedReminder(list: HTMLOListElement): void {
  if (!reminderReturn) return;
  const { id } = reminderReturn;
  const task = tasks.find((item) => item.id === id);
  const old = list.querySelector<HTMLButtonElement>(`[data-edit-reminder="${CSS.escape(id)}"]`);
  if (!task || !old) return;
  const template = document.createElement("template");
  template.innerHTML = renderTask(task, task.position);
  const next = template.content.querySelector<HTMLButtonElement>("[data-edit-reminder]");
  if (!next || old.outerHTML === next.outerHTML) return;
  const fragment = document.createDocumentFragment(); fragment.append(next);
  bindEvents(fragment); old.replaceWith(fragment);
}
function renderReminderDialog(): void {
  let dialog = document.querySelector<HTMLDialogElement>("[data-reminder-dialog]");
  if (!reminderEditingTaskId) { dialog?.close(); dialog?.remove(); return; }
  const task = tasks.find((item) => item.id === reminderEditingTaskId);
  if (!task) return;
  if (!dialog) {
    const template = document.createElement("template");
    template.innerHTML = `<dialog class="reminder-dialog" data-reminder-dialog aria-labelledby="reminder-heading" aria-describedby="reminder-error"><form data-reminder-form="${task.id}"><h2 id="reminder-heading">${t("Напоминание")}</h2><label for="reminder-time">${t("Время сегодня")}</label><input aria-describedby="reminder-error" id="reminder-time" name="reminderAt" type="time" step="60" required aria-invalid="${Boolean(reminderDialogError)}" value="${escapeHtml(reminderDraft)}"/><p id="reminder-error" class="reminder-dialog-error" role="alert">${escapeHtml(reminderDialogError)}</p><div data-reminder-notification-warning ${notificationStatus !== null && !notificationStatus.canTest ? "" : "hidden"}><p>${escapeHtml(backendText(notificationStatus?.message ?? ""))}</p><button class="retry-button" type="button" data-open-notification-settings>${t("Настройки Windows")}</button></div><div class="reminder-actions">${task.reminderAt !== null ? `<button type="button" data-clear-reminder="${task.id}">${t("Удалить")}</button>` : ""}<button type="button" data-close-reminder>${t("Отмена")}</button><button type="submit">${t("Сохранить")}</button></div></form></dialog>`;
    dialog = template.content.querySelector<HTMLDialogElement>("dialog")!;
    bindReminderDialog(dialog);
    bindNotificationControls(dialog);
    document.body.append(dialog);
  }
  const input = dialog.querySelector<HTMLInputElement>("#reminder-time")!;
  if (input.value !== reminderDraft) input.value = reminderDraft;
  input.setAttribute("aria-invalid", String(Boolean(reminderDialogError)));
  dialog.querySelector<HTMLElement>("#reminder-error")!.textContent = reminderDialogError;
  dialog.setAttribute("aria-busy", String(reminderSaving));
  dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((control) => { control.disabled = reminderSaving; });
  if (!dialog.open) dialog.showModal();
}
function bindReminderDialog(dialog: HTMLDialogElement): void {
  const scope = dialog;
  scope.querySelector<HTMLInputElement>("#reminder-time")?.addEventListener("input", (event) => { reminderDraft = (event.target as HTMLInputElement).value; });
  scope.querySelector<HTMLButtonElement>("[data-close-reminder]")?.addEventListener("click", closeReminder);
  dialog.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeReminder();
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeReminder(); });
  const saveReminder = async (id: string, clear: boolean): Promise<void> => {
    if (reminderSaving) return;
    reminderSaving = true;
    const dialog = document.querySelector<HTMLDialogElement>("[data-reminder-dialog]");
    dialog?.setAttribute("aria-busy", "true");
    dialog?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((control) => { control.disabled = true; });
    try {
      if (clear) await invoke("clear_task_reminder", { id });
      else await invoke("set_task_reminder", { id, reminderAt: todayTimestampForTime(reminderDraft) });
      const next = await invoke<Task[]>("list_tasks");
      tasks = next; errorMessage = ""; loadFailed = false;
      reminderEditingTaskId = null; reminderDialogError = "";
      if (reminderReturn) reminderReturn.restoreFocus = true;
      announce(clear ? t("Напоминание удалено") : t("Напоминание сохранено"));
      reminderSaving = false;
      const list = root.querySelector<HTMLOListElement>(".task-list");
      renderReminderDialog();
      if (list && reminderReturn?.signature === reminderListSignature()) {
        updateRetainedReminder(list);
        restoreReminderPosition(list, true);
      } else render(true);
    } catch (error) { reminderDialogError = backendMessage(error); }
    finally { reminderSaving = false; renderReminderDialog(); }
  };
  scope.querySelector<HTMLFormElement>("[data-reminder-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const id = form.dataset.reminderForm;
    const value = new FormData(form).get("reminderAt");
    if (!id || typeof value !== "string") return;
    reminderDraft = value;
    void saveReminder(id, false);
  });
  scope.querySelector<HTMLButtonElement>("[data-clear-reminder]")?.addEventListener("click", (event) => {
    const id = (event.currentTarget as HTMLButtonElement).dataset.clearReminder;
    if (id) void saveReminder(id, true);
  });
}
function closeReminder(): void {
  if (reminderSaving) return;
  reminderEditingTaskId = null; reminderDialogError = ""; reminderDraft = "";
  if (reminderReturn) reminderReturn.restoreFocus = true;
  renderReminderDialog();
  restoreReminderPosition(root.querySelector<HTMLOListElement>(".task-list"), true);
}
function restoreReminderPosition(list: HTMLOListElement | null, complete: boolean): void {
  const bookmark = reminderReturn;
  if (!bookmark) return;
  if (bookmark.view !== activeView) { reminderReturn = null; return; }
  const target = list?.querySelector<HTMLButtonElement>(`[data-edit-reminder="${CSS.escape(bookmark.id)}"]`);
  if (list) list.scrollTop = bookmark.scrollTop;
  if (!bookmark.restoreFocus) return;
  const enoughRows = list && list.scrollHeight - list.clientHeight >= bookmark.scrollTop - 1;
  if ((target && enoughRows) || complete) {
    const focusTarget = target ?? list ?? root.querySelector<HTMLElement>(".queue-section");
    if (focusTarget) { if (!target) focusTarget.tabIndex = -1; focusTarget.focus({ preventScroll: true }); }
    reminderReturn = null;
  }
}
for (const name of ["wheel", "pointerdown", "keydown"] as const) window.addEventListener(name, () => {
  if (reminderReturn?.restoreFocus && !reminderEditingTaskId) reminderReturn = null;
}, { capture: true, passive: true });
let highlightedReminderTaskId: string | null = null;
let timers: Timer[] = [];
const timerSnapshots = new Map<string, { remainingSeconds: number; sampledAt: number; status: Timer["status"] }>();
let timerAnimationFrame: number | null = null;
let timerDialogOpen = false;
let timerError = "";
let fullscreenTimerId: string | null = null;
interface UndoDeletion { token: string; taskId: string; title: string; expiresAt: number; }
interface PermanentDeletionPreview { token: string; task: Task; eventCount: number; sessionCount: number; }
let purgeOpening = false;

async function openPermanentDeletion(id: string): Promise<void> {
  if (purgeOpening || document.querySelector("[data-purge-dialog]")) return;
  purgeOpening = true;
  try {
    const preview = await invoke<PermanentDeletionPreview>("prepare_permanent_deletion", { id });
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
      if (busy) return;
      close();
      void invoke("cancel_permanent_deletion", { token: preview.token }).catch((error) => { errorMessage = backendMessage(error); render(); });
    };
    dialog.querySelector("[data-purge-cancel]")?.addEventListener("click", cancel);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
    dialog.querySelector("form")?.addEventListener("submit", async (event) => {
      event.preventDefault(); if (busy) return; busy = true;
      dialog.querySelectorAll("button").forEach((button) => { button.disabled = true; });
      try {
        await invoke("confirm_permanent_deletion", { token: preview.token });
        close(); await refreshTasks(); await refreshHistory(); await refreshDeletionUndos();
      } catch (error) { close(); errorMessage = backendMessage(error); render(); }
    });
    dialog.showModal();
  } catch (error) { errorMessage = backendMessage(error); render(); }
  finally { purgeOpening = false; }
}
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
  if (!region) { region = document.createElement("aside"); region.id = "deletion-undos"; region.className = "undo-notices"; region.setAttribute("aria-label", t("Удалённые задачи")); region.setAttribute("aria-live", "polite"); document.body.append(region); }
  region.setAttribute("aria-label", t("Удалённые задачи"));
  region.hidden = deletionUndos.length === 0 && !undoMessage;
  const key = JSON.stringify([language(), deletionUndos, [...undoBusy], undoMessage]); if (key === undoRenderKey) return; undoRenderKey = key;
  region.innerHTML = `${undoMessage ? `<div class="undo-error" role="alert"><span>${escapeHtml(undoMessage)}</span><button type="button" data-dismiss-undo-message aria-label="${t("Закрыть сообщение")}">×</button></div>` : ""}<ul>${deletionUndos.map((item) => `<li><span><small>${t("Задача удалена")}</small><strong>${escapeHtml(item.title)}</strong></span><button type="button" data-undo-deletion="${item.token}" aria-label="${t("Отменить удаление:")} ${escapeHtml(item.title)}" ${undoBusy.has(item.token) ? "disabled" : ""}>${t("Отменить")}</button></li>`).join("")}</ul>`;
  region.querySelector<HTMLButtonElement>("[data-dismiss-undo-message]")?.addEventListener("click", () => { undoMessage = ""; renderDeletionUndos(); });
  region.querySelectorAll<HTMLButtonElement>("[data-undo-deletion]").forEach((button) => button.addEventListener("click", async () => {
    const token = button.dataset.undoDeletion!; if (undoBusy.has(token)) return;
    undoBusy.add(token); undoMessage = ""; renderDeletionUndos();
    try {
      const restored = await invoke<Task>("undo_task_deletion", { token });
      deletionUndos = deletionUndos.filter((item) => item.token !== token);
      await refreshTasks(); if (activeView === "history") await refreshHistory();
      if (restored.status === "archived") undoMessage = t("Удаление отменено. Срок задачи истёк, она находится в архиве.");
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
  return `<section class="settings-section" aria-labelledby="startup-heading"><h2 id="startup-heading">${t("Запуск")}</h2>
    <label class="settings-check"><input type="checkbox" data-autostart ${autostartEnabled ? "checked" : ""} ${autostartBusy || autostartEnabled === null ? "disabled" : ""}/><span>${t("Запускать с Windows")}</span></label>
    <p role="status" data-autostart-status>${escapeHtml(autostartMessage)}</p>
    <button class="retry-button" type="button" data-autostart-retry ${autostartEnabled === null ? "" : "hidden"}>${t("Повторить проверку")}</button>
  </section>`;
}
function bindAutostartSettings(): void {
  root.querySelector<HTMLButtonElement>("[data-autostart-retry]")?.addEventListener("click", () => { void refreshAutostart(); });
  root.querySelector<HTMLInputElement>("[data-autostart]")?.addEventListener("change", async (event) => {
    const desired = (event.currentTarget as HTMLInputElement).checked;
    if (autostartBusy) { updateAutostartControls(); return; }
    autostartBusy = true; updateAutostartControls();
    try { autostartEnabled = await invoke<boolean>("set_autostart_enabled", { enabled: desired }); autostartMessage = t("Сохранено"); }
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
  if (status) { status.textContent = backendText(notificationStatus?.message ?? (notificationReadError || t("Проверка состояния…"))); status.classList.toggle("is-blocked", notificationStatus !== null && !notificationStatus.canTest); }
  const hint = root.querySelector<HTMLElement>("[data-notification-identity]");
  if (hint) hint.hidden = !notificationStatus?.usesSystemIdentity;
  const message = root.querySelector<HTMLElement>("[data-notification-result]");
  if (message) message.textContent = notificationActionMessage;
  root.querySelectorAll<HTMLButtonElement>("[data-notification-test], [data-notification-refresh]").forEach((button) => { button.disabled = notificationBusy || (button.hasAttribute("data-notification-test") && !notificationStatus?.canTest); });
  const warning = document.querySelector<HTMLElement>("[data-reminder-notification-warning]");
  if (warning) { warning.hidden = notificationStatus === null || notificationStatus.canTest; warning.querySelector<HTMLElement>("p")!.textContent = backendText(notificationStatus?.message ?? ""); }
}
async function refreshNotificationStatus(): Promise<void> {
  if (notificationBusy) return;
  notificationBusy = true; updateNotificationControls();
  try { notificationStatus = await invoke<NotificationStatus>("get_notification_status"); notificationReadError = ""; }
  catch (error) { notificationStatus = null; notificationReadError = backendMessage(error); }
  finally { notificationBusy = false; updateNotificationControls(); }
}
function renderNotificationSettings(): string {
  return `<section class="settings-section" aria-labelledby="notifications-heading"><h2 id="notifications-heading">${t("Уведомления")}</h2>
    <p data-notification-permission role="status" class="${notificationStatus !== null && !notificationStatus.canTest ? "is-blocked" : ""}">${escapeHtml(backendText(notificationStatus?.message ?? (notificationReadError || t("Проверка состояния…"))))}</p>
    <p>${t("Напоминания работают, пока taskMaster запущен, в том числе в трее.")}</p>
    <p data-notification-identity ${notificationStatus?.usesSystemIdentity ? "" : "hidden"}>${t("В этой сборке отправитель — Windows PowerShell.")}</p>
    <div class="settings-actions"><button class="retry-button" type="button" data-notification-test ${notificationBusy || !notificationStatus?.canTest ? "disabled" : ""}>${t("Проверить уведомление")}</button>
    <button class="retry-button" type="button" data-notification-refresh ${notificationBusy ? "disabled" : ""}>${t("Обновить состояние")}</button>
    <button class="retry-button" type="button" data-open-notification-settings>${t("Настройки Windows")}</button></div>
    <p role="status" data-notification-result>${escapeHtml(notificationActionMessage)}</p>
  </section>`;
}
function bindNotificationControls(scope: ParentNode = root): void {
  scope.querySelectorAll<HTMLButtonElement>("[data-open-notification-settings]").forEach((button) => button.addEventListener("click", async () => {
    try { await invoke("open_notification_settings"); }
    catch (error) { notificationActionMessage = backendMessage(error); errorMessage = notificationActionMessage; if (activeView === "settings") updateNotificationControls(); else render(true); }
  }));
  scope.querySelector<HTMLButtonElement>("[data-notification-refresh]")?.addEventListener("click", () => { void refreshNotificationStatus(); });
  scope.querySelector<HTMLButtonElement>("[data-notification-test]")?.addEventListener("click", async () => {
    if (notificationBusy) return;
    notificationBusy = true; notificationActionMessage = t("Отправка…"); updateNotificationControls();
    try { await invoke("send_test_notification"); notificationActionMessage = t("Тестовое уведомление отправлено."); }
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
    const label = row.firstElementChild as HTMLElement | null;
    const oldPosition = label?.classList.contains("is-changing") ? label.firstElementChild?.textContent : "";
    const position = oldPosition || label?.dataset.position;
    if (id && position) positions.set(id, position);
  });
  return positions;
}

function animatePositionChanges(previous: Map<string, string>, scope: ParentNode = root): void {
  if (!previous.size) return;
  scope.querySelectorAll<HTMLLIElement>('.task-row[data-reorderable="true"]').forEach((row) => {
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
    if (!row || row.classList.contains("is-entering")) return;
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
  button.setAttribute("aria-label", `${t("Выполнена —")} ${task.title}`);
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
  button.setAttribute("aria-label", `${t("Вернуть в очередь —")} ${task.title}`);
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
    announce(t("Задача добавлена"));
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
  document.documentElement.dataset.contrast = displaySettings.highContrast ? "high" : "normal";
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
    if (typeof message === "string") return backendText(message);
  }
  return t("Не удалось сохранить изменения. Попробуйте ещё раз.");
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
  return new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
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
    return `<button class="calendar-day ${value === selectedHistoryDate ? "is-selected" : ""} ${hasTasks ? "has-tasks" : ""}" type="button" data-calendar-date="${value}" aria-label="${new Intl.DateTimeFormat(locale(), { dateStyle: "full" }).format(date)}${isToday ? `, ${t("сегодня")}` : ""}${hasTasks ? `, ${t("есть задачи")}` : ""}" ${isToday ? 'aria-current="date"' : ""} ${value === selectedHistoryDate ? 'aria-pressed="true"' : ""} ${disabled ? "disabled" : ""}><span>${date.getDate()}</span></button>`;
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

function renderHistoryColumn(title: string, items: HistoryTask[], type: "completed" | "archived"): string {
  const list = historyLoading
    ? `<li class="history-empty">${t("Загружаем…")}</li>`
    : items.length
      ? items.map(({ task, occurredAt, createdAt }) => `<li class="history-task-row ${highlightedReminderTaskId === task.id ? "is-reminder-highlighted" : ""}" data-task-id="${task.id}">
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

function renderHistoryLists(): string {
  return `<div class="history-columns">${renderHistoryColumn(t("Выполнено"), historyDay.completed, "completed")}${renderHistoryColumn(t("Архив"), historyDay.archived, "archived")}</div>`;
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
        <input class="rename-input" name="title" aria-label="${t("Новое название задачи")}" value="${escapeHtml(task.title)}" required />
      </form>`
    : `<span class="task-title">${escapeHtml(task.title)}</span>`;

  return `
    <li class="task-row ${completed ? "is-completed" : ""} ${highlightedReminderTaskId === task.id ? "is-reminder-highlighted" : ""} ${taskAnimationLocks.has(task.id) ? "is-task-animating" : ""}" data-task-id="${task.id}" data-reorderable="${!completed}" ${completed ? "" : `tabindex="0" aria-keyshortcuts="${shortcuts.move_up} ${shortcuts.move_down} ${shortcuts.rename}" aria-label="${escapeHtml(task.title)}. ${escapeHtml(displayShortcut(shortcuts.move_up))} ${t("и")} ${escapeHtml(displayShortcut(shortcuts.move_down))} ${t("меняют порядок.")} ${escapeHtml(displayShortcut(shortcuts.rename))} ${t("изменяет название.")}"`}>
      <span class="task-position ${completed ? "completed-position" : ""}" data-position="${position}" aria-label="${t("Задача")} ${index + 1}"><span class="position-old" aria-hidden="true"></span><span class="position-current">${position}</span></span>
      <button class="task-check ${completed ? "checked" : ""}" type="button"
        data-toggle-task="${task.id}" aria-label="${completed ? t("Вернуть в очередь") : t("Отметить выполненной")} — ${escapeHtml(task.title)}"
        aria-pressed="${completed}" ${saving || taskAnimationLocks.has(task.id) ? "disabled" : ""}>
        <span aria-hidden="true">${completed ? "✓" : ""}</span>
      </button>
      <div class="task-content">${title}</div>
      ${completed ? "" : `<button class="reminder-button ${task.reminderAt !== null ? "has-reminder" : ""}" type="button" data-edit-reminder="${task.id}" aria-label="${task.reminderAt !== null ? `${t("Изменить напоминание:")} ${escapeHtml(task.title)}` : `${t("Добавить напоминание:")} ${escapeHtml(task.title)}`}">${task.reminderAt !== null ? `<time>${new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(task.reminderAt)}</time>` : "◷"}</button>`}
      <button class="task-delete" type="button" data-delete-task="${task.id}" aria-label="${t("Удалить задачу:")} ${escapeHtml(task.title)}" title="${t("Удалить задачу")}" ${saving || taskAnimationLocks.has(task.id) ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>
    </li>`;
}

function timerCard(timer: Timer, fullscreen = false, overlay = false): string {
  const progress = timer.durationSeconds > 0 ? timer.remainingSeconds / timer.durationSeconds : 0;
  const circumference = 2 * Math.PI * 86;
  const ring = `<svg class="timer-ring" viewBox="0 0 200 200" aria-hidden="true"><circle class="timer-ring-track" cx="100" cy="100" r="86"/><circle class="timer-ring-progress" cx="100" cy="100" r="86" stroke-dasharray="${circumference} ${circumference}" stroke-dashoffset="${circumference * (1 - progress)}"/></svg>`;
  return `<article class="timer-card ${fullscreen ? "timer-card-focus" : ""} ${overlay ? "timer-card-overlay" : ""}" aria-labelledby="timer-label-${timer.id}" data-timer-card="${timer.id}" data-timer-status="${timer.status}">
    <div class="timer-card-heading"><h2 id="timer-label-${timer.id}">${escapeHtml(timer.name)}</h2>${overlay ? `<div class="timer-card-actions"><button type="button" data-hide-overlay-timer="${timer.id}" aria-label="${t("Скрыть таймер из оверлея")}" title="${t("Скрыть из оверлея")}">×</button></div>` : `<div class="timer-card-actions">${fullscreen ? `<button type="button" class="timer-exit-button" data-exit-fullscreen aria-label="${t("Выйти из полноэкранного режима")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>` : `<button type="button" data-timer-fullscreen="${timer.id}" aria-label="${t("Открыть на весь экран")}">⛶</button><button type="button" class="timer-delete" data-timer-action="delete" data-timer-id="${timer.id}" aria-label="${t("Удалить таймер")}">×</button>`}</div>`}</div>
    <div class="timer-dial">${ring}<strong class="timer-clock" role="timer" aria-live="off" data-timer-clock>${formatTimerTime(timer.remainingSeconds)}</strong></div>
    <div class="timer-footer">
      <div class="timer-controls">
        ${timer.status === "running" ? `<button type="button" data-timer-action="pause" data-timer-id="${timer.id}" aria-label="${t("Пауза")}">Ⅱ</button>` : `<button type="button" data-timer-action="start" data-timer-id="${timer.id}" aria-label="${timer.status === "finished" ? t("Запустить заново") : t("Запустить")}">${timer.status === "finished" ? "↻" : "▶"}</button>`}
        <button type="button" data-timer-action="reset" data-timer-id="${timer.id}" aria-label="${t("Сбросить таймер")}">↶</button>
      </div>
    </div>
  </article>`;
}

function renderSidebar(): string {
  const sections: { view: View; label: string; count?: number }[] = [
    { view: "today", label: t("Сегодня"), count: activeTasks().length },
    { view: "completed", label: t("Выполнено"), count: completedTodayTasks().length },
    { view: "history", label: t("История") },
    { view: "timers", label: t("Таймеры") },
  ];
  return `<aside class="sidebar" aria-label="taskMaster"><nav class="navigation" aria-label="${t("Разделы")}">
    ${sections.map(({ view, label, count }, index) => `<a class="nav-item ${activeView === view ? "is-current" : ""}" href="#${view}" data-view="${view}" ${activeView === view ? 'aria-current="page"' : ""}><span class="nav-index">${String(index + 1).padStart(2, "0")}</span>${label}${count === undefined ? "" : `<span class="nav-count">${count}</span>`}</a>`).join("")}
  </nav><button class="theme-switch" type="button" data-view="settings" ${activeView === "settings" ? 'aria-current="page"' : ""} aria-label="${t("Настройки")}"><span class="theme-icon" aria-hidden="true">⚙</span><span class="theme-copy">${t("Настройки")}</span></button></aside>`;
}

function renderBackupSettings(): string {
  return `<section class="settings-section" aria-labelledby="backup-heading"><h2 id="backup-heading">${t("Резервные копии")}</h2>
    <p>${t("Ежедневные копии создаются при запуске. Хранятся последние семь.")}</p>
    ${backupStatus?.warning ? `<p class="backup-warning" role="alert">${escapeHtml(backendText(backupStatus.warning))}</p>` : ""}
    <div class="backup-actions">
      <button class="retry-button" type="button" data-backup-action="create" ${backupBusy || !backupStatus?.databaseAvailable ? "disabled" : ""}>${t("Создать резервную копию")}</button>
      <button class="retry-button" type="button" data-backup-action="choose" ${backupBusy || !backupStatus ? "disabled" : ""}>${t("Восстановить из файла")}</button>
      <button class="retry-button" type="button" data-backup-action="latest" ${backupBusy || !backupStatus?.hasDailyCopy ? "disabled" : ""}>${t("Восстановить последнюю ежедневную")}</button>
      <button class="retry-button" type="button" data-backup-action="folder" ${backupBusy || !backupStatus ? "disabled" : ""}>${t("Открыть папку данных")}</button>
    </div><p role="status" aria-live="polite">${escapeHtml(backupMessage)}</p>
    ${restorePreview ? `<dialog class="reminder-dialog backup-confirm" data-restore-dialog aria-labelledby="restore-heading"><form data-restore-confirm><h2 id="restore-heading">${t("Восстановить данные?")}</h2>
      <p class="backup-source">${escapeHtml(restorePreview.source)}</p>
      <dl class="backup-summary"><dt>${t("Задачи")}</dt><dd>${restorePreview.tasks}</dd><dt>${t("События истории")}</dt><dd>${restorePreview.events}</dd><dt>${t("Таймеры")}</dt><dd>${restorePreview.timers}</dd></dl>
      <p>${t("Текущие задачи, история, таймеры и настройки задач будут заменены. Перед заменой текущие данные будут сохранены отдельно.")}</p>
      <div class="reminder-actions"><button type="button" data-cancel-restore ${backupBusy ? "disabled" : ""}>${t("Отмена")}</button><button type="submit" ${backupBusy ? "disabled" : ""}>${backupBusy ? t("Восстановление…") : t("Восстановить")}</button></div>
    </form></dialog>` : ""}
  </section>`;
}

function bindBackupSettings(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-backup-action]").forEach((button) => button.addEventListener("click", async () => {
    if (backupBusy) return;
    const action = button.dataset.backupAction;
    backupBusy = true; backupMessage = action === "create" ? t("Создание копии…") : action === "folder" ? "" : t("Проверка копии…"); render(true);
    try {
      if (action === "folder") { await invoke("open_data_directory"); }
      else if (action === "create") { const path = await invoke<string | null>("create_database_backup"); backupMessage = path ? `${t("Копия сохранена:")} ${path}` : ""; }
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
    const token = restorePreview.token; backupBusy = true; backupMessage = t("Восстановление…"); render(true);
    let restoredPath: string | null = null;
    try {
      const path = await invoke<string>("confirm_database_restore", { token });
      restoredPath = path;
      restorePreview = null; editingTaskId = null; fullscreenTimerId = null; taskAnimationLocks.clear();
      preferences = await invoke<typeof preferences>("get_preferences"); preferencesReady = true;
      await Promise.all([refreshTasks(), refreshTimers(false), loadShortcuts(), refreshDeletionUndos()]);
      const overlayStatus = await invoke<OverlayShortcutStatus>("get_overlay_shortcut_status");
      overlayShortcut = overlayStatus.shortcut; overlayShortcutAvailable = overlayStatus.available;
      backupMessage = `${t("Данные восстановлены. Предыдущие данные сохранены:")} ${path}`;
      await refreshBackupStatus();
    } catch (error) { restorePreview = null; backupMessage = restoredPath ? `${t("Данные восстановлены, но интерфейс не удалось обновить. Перезапустите приложение. Предыдущие данные:")} ${restoredPath}` : backendMessage(error); }
    finally { backupBusy = false; render(true); }
  });
  if (dialog && !dialog.open) dialog.showModal();
}

type ClearMode = "tasks" | "allData";
let clearingData = false;
function openClearData(mode: ClearMode): void {
  if (clearingData || document.querySelector("[data-clear-dialog]")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "reminder-dialog";
  dialog.dataset.clearDialog = "";
  dialog.setAttribute("aria-labelledby", "clear-heading");
  dialog.setAttribute("aria-describedby", "clear-description");
  const description = mode === "tasks"
    ? `${t("Все задачи, архив, история и напоминания будут удалены.")} ${t("Таймеры, настройки и существующие резервные копии сохранятся. Новая копия не создаётся. Отменить действие нельзя.")}`
    : t("Будут удалены все задачи, история, таймеры, настройки, журналы и резервные копии приложения. Автозапуск будет отключён. Отменить действие нельзя. Приложение перезапустится с настройками по умолчанию.");
  dialog.innerHTML = `<form><h2 id="clear-heading">${mode === "tasks" ? t("Очистить задачи?") : t("Сбросить данные?")}</h2><p id="clear-description">${description}</p><p role="alert" data-clear-error></p><p role="status" data-clear-status></p><div class="reminder-actions"><button type="button" data-clear-cancel autofocus>${t("Отмена")}</button><button type="submit" class="danger-action">${mode === "tasks" ? t("Очистить задачи") : t("Сбросить данные")}</button></div></form>`;
  const close = (): void => { if (clearingData) return; dialog.close(); dialog.remove(); root.querySelector<HTMLButtonElement>(`[data-clear-data="${mode}"]`)?.focus({ preventScroll: true }); };
  dialog.querySelector("[data-clear-cancel]")!.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.querySelector("form")!.addEventListener("submit", async (event) => {
    event.preventDefault(); if (clearingData) return;
    clearingData = true;
    dialog.querySelector<HTMLElement>("[data-clear-error]")!.textContent = "";
    dialog.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      await invoke("clear_user_data", { mode });
      if (mode === "allData") { dialog.querySelector<HTMLElement>("[data-clear-status]")!.textContent = t("Перезапуск…"); return; }
      clearingData = false; close();
    } catch (error) {
      clearingData = false;
      dialog.querySelector<HTMLElement>("[data-clear-error]")!.textContent = backendMessage(error);
      dialog.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  });
  document.body.append(dialog); dialog.showModal();
}

function renderSettings(): void {
  const previousScrollTop = root.querySelector<HTMLElement>(".settings-view")?.scrollTop ?? 0;
  root.innerHTML = `<div class="app-shell">${renderSidebar()}
  <main id="settings" class="main-content settings-view"><h1>${t("Настройки")}<span class="heading-period">.</span></h1>
    <section class="settings-section" aria-labelledby="theme-heading"><h2 id="theme-heading">${t("Оформление")}</h2><label for="settings-theme">${t("Тема")}</label>
    <select id="settings-theme" data-theme-select>${themeOrder.map((value) => `<option value="${value}" ${theme === value ? "selected" : ""}>${themeLabels[value]}</option>`).join("")}</select>
    <label for="settings-language">${t("Язык")}</label><select id="settings-language" data-language-select ${displaySettingsReady ? "" : "disabled"}>${languages.map((value) => `<option value="${value}" ${language() === value ? "selected" : ""}>${languageNames[value]}</option>`).join("")}</select>
    <label class="settings-check"><input id="settings-contrast" type="checkbox" data-high-contrast ${displaySettings.highContrast ? "checked" : ""} ${displaySettingsReady ? "" : "disabled"}/><span>${t("Высокий контраст")}</span></label>
    <p role="alert" data-settings-error>${escapeHtml(displaySettingsError)}</p></section>
    ${renderAutostartSettings()}
    ${renderNotificationSettings()}
    <section class="settings-section"><h2>${t("Задачи")}</h2><form data-preferences-form>
      <label for="reminder-minutes">${t("Время до напоминания, минуты")}</label><input id="reminder-minutes" name="reminderMinutes" type="number" min="1" max="1439" step="1" required value="${preferences.reminderMinutes}" ${preferencesReady ? "" : "disabled"}/>
      <label for="archive-hours">${t("Архивировать через, часы")}</label><input id="archive-hours" name="archiveHours" type="number" min="1" max="8760" step="1" required value="${preferences.archiveHours}" ${preferencesReady ? "" : "disabled"}/>
      <p>${t("Срок отсчитывается от создания задачи. Архив сохраняет задачи и историю.")}</p>
      <button class="retry-button" type="submit" ${preferencesReady ? "" : "disabled"}>${t("Сохранить")}</button><p role="status" data-preferences-status>${escapeHtml(preferencesError)}</p>
    </form></section>
    <section class="settings-section shortcut-section" aria-labelledby="shortcuts-heading"><h2 id="shortcuts-heading">${t("Горячие клавиши")}</h2>
      <p>${t("Нажмите поле и сочетание клавиш, затем сохраните. Escape отменяет ввод. Команды задач работают при фокусе на строке.")}</p>
      <p role="alert">${escapeHtml(shortcutsError)}</p>
      <div class="shortcut-table" role="group" aria-label="${t("Горячие клавиши")}">
      ${([...Object.keys(shortcutLabels), "overlay"] as (ShortcutAction | "overlay")[]).map((action) => {
        const value = action === "overlay" ? overlayShortcut : shortcuts[action];
        return `<form class="shortcut-row" aria-label="${action === "overlay" ? t("Оверлей") : shortcutLabels[action]}" data-shortcut-form="${action}"><div><label for="shortcut-${action}">${action === "overlay" ? t("Показать / скрыть оверлей") : shortcutLabels[action]}</label><small>${action === "overlay" ? t("Глобально") : t("В приложении")}</small></div><div><input id="shortcut-${action}" data-shortcut-capture data-combination="${escapeHtml(value)}" value="${escapeHtml(displayShortcut(value))}" readonly aria-label="${t("Сочетание:")} ${action === "overlay" ? t("Оверлей") : shortcutLabels[action]}" ${shortcutsReady ? "" : "disabled"}/></div><div><button class="retry-button" type="submit" ${shortcutsReady ? "" : "disabled"}>${t("Сохранить")}</button></div><p role="status" data-shortcut-status>${action === "overlay" && !overlayShortcutAvailable ? t("Не удалось зарегистрировать сочетание. Выберите другое.") : ""}</p></form>`;
      }).join("")}</div>
    </section>
    ${renderBackupSettings()}
    <section class="settings-section"><h2>${t("Данные")}</h2><button class="retry-button" type="button" data-export-json>${t("Выгрузить JSON в Загрузки")}</button><p role="status" data-export-status></p><div class="settings-actions"><button type="button" class="danger-action" data-clear-data="tasks" ${loadFailed ? "disabled" : ""}>${t("Очистить задачи")}</button><button type="button" class="danger-action" data-clear-data="allData">${t("Сбросить данные")}</button></div></section>
    <section class="settings-section"><h2>${t("Диагностика")}</h2><p>${t("Журналы находятся в папке данных → logs. Хранятся четыре файла до 256 КБ каждый, без названий задач и таймеров.")}</p><p role="alert" data-diagnostics-warning></p></section>
    <section class="settings-section"><h2>${t("О приложении")}</h2><p class="about-links"><a href="https://taskmaster339.github.io/" data-about-link>${t("Персональный сайт")}</a><a href="https://github.com/TAskMAster339/taskMaster" data-about-link>GitHub</a></p><p>taskMaster${appVersion ? ` · ${escapeHtml(appVersion)}` : ""}</p>${appVersionError ? `<p role="alert">${escapeHtml(appVersionError)}</p>` : ""}</section>
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
      status.textContent = t("Сохранено");
    } catch (error) { status.textContent = backendMessage(error); }
    finally { button.disabled = false; input.disabled = false; }
  }));
  root.querySelector<HTMLFormElement>("[data-preferences-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form); const next = { reminderMinutes: Number(values.get("reminderMinutes")), archiveHours: Number(values.get("archiveHours")) };
    const button = form.querySelector<HTMLButtonElement>("button")!; button.disabled = true;
    const status = form.querySelector<HTMLElement>("[data-preferences-status]")!;
    try { await invoke("update_preferences", next); preferences = next; status.textContent = t("Сохранено"); }
    catch (error) { status.textContent = backendMessage(error); }
    finally { button.disabled = false; }
  });
  root.querySelector<HTMLButtonElement>("[data-export-json]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    const status = root.querySelector<HTMLElement>("[data-export-status]")!;
    try { const path = await invoke<string>("export_user_data", { theme }); status.textContent = `${t("Сохранено:")} ${path}`; }
    catch (error) { status.textContent = backendMessage(error); }
    finally { button.disabled = false; }
  });
  root.querySelector<HTMLSelectElement>("[data-theme-select]")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value as Theme;
    try { localStorage.setItem(themeStorageKey, value); theme = value; applyTheme(); }
    catch { root.querySelector<HTMLElement>("[data-settings-error]")!.textContent = t("Не удалось сохранить тему. Повторите попытку."); }
  });
  root.querySelectorAll<HTMLButtonElement>("[data-clear-data]").forEach((button) => button.addEventListener("click", () => openClearData(button.dataset.clearData as ClearMode)));
  root.querySelectorAll<HTMLAnchorElement>("[data-about-link]").forEach((link) => link.addEventListener("click", async (event) => {
    event.preventDefault();
    try { await invoke("open_about_link", { url: link.href }); }
    catch (error) { root.querySelector<HTMLElement>("[data-settings-error]")!.textContent = backendMessage(error); }
  }));
  root.querySelector<HTMLSelectElement>("[data-language-select]")?.addEventListener("change", (event) => { void saveDisplaySettings({ ...displaySettings, language: (event.target as HTMLSelectElement).value as Language }); });
  root.querySelector<HTMLInputElement>("[data-high-contrast]")?.addEventListener("change", (event) => { void saveDisplaySettings({ ...displaySettings, highContrast: (event.target as HTMLInputElement).checked }); });
  const settingsPage = root.querySelector<HTMLElement>(".settings-view");
  if (settingsPage) settingsPage.scrollTop = previousScrollTop;
  void refreshDiagnosticsWarning();
}

function applyDisplaySettings(next: DisplaySettings): void {
  const changed = next.language !== displaySettings.language || next.highContrast !== displaySettings.highContrast;
  displaySettings = next; setLanguage(next.language); document.documentElement.lang = next.language;
  skipLink.textContent = t("Перейти к содержимому"); applyTheme();
  if (changed && getCurrentWindow().label !== "overlay") {
    const focusedId = (document.activeElement as HTMLElement | null)?.id;
    render(true); renderDeletionUndos();
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
    void refreshNotificationStatus();
  }
}
async function saveDisplaySettings(next: DisplaySettings): Promise<void> {
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-language-select], [data-high-contrast]").forEach((control) => { control.disabled = true; });
  try {
    const previous = displaySettings;
    const saved = await invoke<DisplaySettings>("update_display_settings", { settings: next });
    displaySettingsError = ""; applyDisplaySettings(saved);
    announce(previous.language !== next.language ? t("Язык изменён") : t("Контраст изменён"));
  } catch (error) { displaySettingsError = backendMessage(error); }
  finally {
    const focusedId = (document.activeElement as HTMLElement | null)?.id;
    render(true); if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
}
void listen<DisplaySettings>("display-settings-changed", ({ payload }) => applyDisplaySettings(payload));
window.addEventListener("storage", (event) => { if (event.key === themeStorageKey) { theme = readTheme(); applyTheme(); } });

async function refreshDiagnosticsWarning(): Promise<void> {
  let warning: string | null;
  try { warning = await invoke<string | null>("get_diagnostics_warning"); }
  catch (error) { warning = backendMessage(error); }
  const status = root.querySelector<HTMLElement>("[data-diagnostics-warning]");
  if (status) status.textContent = backendText(warning ?? "");
}

function renderTimers(): void {
  const restoreFocus = preserveTimerFocus(root);
  const focused = timers.find((timer) => timer.id === fullscreenTimerId);
  root.innerHTML = `<div class="app-shell ${focused ? "is-timer-fullscreen" : ""}">
    ${focused ? "" : renderSidebar()}
    <main class="main-content timer-view ${focused ? "timer-view-fullscreen" : ""}" id="timers">
      ${focused ? `${timerCard(focused, true)}<p class="error-banner" role="alert" ${timerError ? "" : "hidden"}>${escapeHtml(timerError)}</p>` : `<header class="timer-page-heading"><div><p class="eyebrow">${t("ИНСТРУМЕНТЫ")}</p><h1>${t("Таймеры")}<span class="heading-period">.</span></h1></div><button class="add-button timer-add-button" type="button" data-add-timer aria-label="${t("Добавить таймер")}">＋</button></header>
      <p class="error-banner" role="alert" ${timerError ? "" : "hidden"}>${escapeHtml(timerError)}</p>
      <div class="timer-grid">${timers.length ? timers.map((timer) => timerCard(timer)).join("") : `<div class="empty-state"><strong>${t("Таймеров пока нет")}</strong><button class="retry-button" type="button" data-add-timer>${t("Добавить таймер")}</button></div>`}</div>
      ${timerDialogOpen ? `<dialog class="reminder-dialog timer-dialog" data-timer-dialog aria-labelledby="timer-heading"><form data-timer-form><h2 id="timer-heading">${t("Добавить таймер")}</h2><label for="timer-hours">${t("Длительность")}</label><div class="timer-duration-fields"><input id="timer-hours" type="number" name="hours" min="0" max="99" value="00" aria-label="${t("Часы")}" required/><span>:</span><input type="number" name="minutes" min="0" max="59" value="00" aria-label="${t("Минуты")}" required/><span>:</span><input type="number" name="seconds" min="0" max="59" value="00" aria-label="${t("Секунды")}" required/></div><label for="timer-name">${t("Название")}</label><input id="timer-name" name="name" type="text" maxlength="80" value="${t("Таймер (")}${timers.length + 1})" required/><p class="reminder-dialog-error" role="alert">${escapeHtml(timerError)}</p><div class="reminder-actions"><button type="button" data-close-timer>${t("Отмена")}</button><button type="submit">${t("Сохранить")}</button></div></form></dialog>` : ""}`}
    </main></div>`;
  bindEvents();
  animateTimerFrames();
  restoreFocus();
  const dialog = root.querySelector<HTMLDialogElement>("[data-timer-dialog]");
  if (dialog && !dialog.open) dialog.showModal();
}

function render(allowDuringAnimation = false): void {
  skipLink.href = `#${activeView}`;
  if (mouseDragActive) return;
  if (taskAnimationLocks.size > 0 && !allowDuringAnimation) return;
  cancelListAppend();
  cancelListAppend = () => {};
  if (activeView !== "today" && activeView !== "completed") pendingTaskFocusId = null;
  if (activeView === "settings") { renderSettings(); return; }
  if (activeView === "timers") { renderTimers(); return; }
  if (timerAnimationFrame !== null) {
    cancelAnimationFrame(timerAnimationFrame);
    timerAnimationFrame = null;
  }
  if (reminderEditingTaskId && !tasks.some((task) => task.id === reminderEditingTaskId && task.status === "active")) {
    reminderEditingTaskId = null;
    if (reminderReturn) reminderReturn.restoreFocus = true;
  }
  const previousPositions = root.querySelector("main")?.id === activeView ? captureTaskPositions() : new Map<string, string>();
  const active = activeTasks();
  const completedToday = completedTodayTasks();
  const showingToday = activeView === "today";
  const showingCompleted = activeView === "completed";
  const showingHistory = activeView === "history";
  const visibleTasks = showingToday ? active : completedToday;
  const historyCount = historyDay.completed.length + historyDay.archived.length;
  const headingDate = showingHistory ? parseLocalDate(selectedHistoryDate) : new Date();
  const headingDateLabel = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(headingDate);
  const taskList = showingHistory
    ? renderHistoryLists()
    : loading
    ? `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>${t("Загружаем очередь…")}</span></div>`
    : visibleTasks.length
      ? `<ol class="task-list ${showingToday ? "" : "completed-list"}" aria-label="${showingToday ? t("Очередь задач") : t("Выполненные сегодня задачи")}">${visibleTasks.slice(0, 32).map((task, index) => renderTask(task, index, !showingToday)).join("")}</ol>`
      : loadFailed
        ? `<div class="empty-state load-error-state">
             <span class="empty-mark" aria-hidden="true">!</span>
             <strong>${showingToday ? t("Очередь недоступна") : t("Список недоступен")}</strong>
             <span>${t("Попробуйте загрузить задачи ещё раз.")}</span>
             <button class="retry-button" type="button" data-retry-load>${t("Повторить")}</button><button class="retry-button" type="button" data-view="settings">${t("Восстановление данных")}</button>
           </div>`
        : `<div class="empty-state">
           <strong>${showingToday ? t("Задач пока нет") : t("Выполненных задач сегодня нет")}</strong>
         </div>`;

  const retainedList = reminderReturn?.view === activeView && reminderReturn.signature === reminderListSignature()
    ? root.querySelector<HTMLOListElement>(".task-list") : null;
  root.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}

      <main class="main-content ${showingToday ? "is-today-view" : showingHistory ? "is-history-view" : "is-completed-view"}" id="${activeView}">
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
            ${overlayShortcutAvailable ? "" : `<button class="overlay-shortcut-warning" type="button" data-open-overlay-shortcut>${t("Настроить клавишу")}</button>`}
          </div>
        </section>

        ${showingToday ? `<form class="quick-add" id="quick-add-form">
          <input id="new-task-title" name="title" type="text" autocomplete="off"
            placeholder="${t("Новая задача")}" aria-label="${t("Название новой задачи")}" ${saving ? "disabled" : ""} />
          <kbd>ENTER <span aria-hidden="true">↵</span></kbd>
          <button class="add-button" type="submit" aria-label="${t("Добавить задачу")}" ${saving ? "disabled" : ""}>＋</button>
        </form>` : ""}

        <p class="error-banner" role="alert" ${errorMessage ? "" : "hidden"}>
          <span aria-hidden="true">!</span> ${escapeHtml(errorMessage)}
        </p>

        <section class="queue-section" aria-labelledby="queue-title">
          <div class="section-heading" ${showingHistory ? "hidden" : ""}>
            <div class="section-title-wrap">
              <h2 id="queue-title">${showingToday ? t("Очередь") : showingCompleted ? t("Сегодня") : ""}</h2>
            </div>
          </div>
          ${showingHistory ? `<div class="history-list-container">${historyLoading ? `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>${t("Загружаем список…")}</span></div>` : taskList}</div>` : taskList}
        </section>
        ${showingHistory ? renderCalendar() : ""}
        ${overlayShortcutDialogOpen ? `<dialog class="reminder-dialog" data-overlay-shortcut-dialog aria-labelledby="overlay-shortcut-heading"><form data-overlay-shortcut-form><h2 id="overlay-shortcut-heading">${t("Горячая клавиша")}</h2><label for="overlay-shortcut-input">${t("Сочетание клавиш")}</label><input id="overlay-shortcut-input" name="shortcut" type="text" value="${escapeHtml(overlayShortcut)}" placeholder="Ctrl+Shift+O" required aria-describedby="overlay-shortcut-help"/><small id="overlay-shortcut-help">${t("Например: Ctrl+Shift+O")}</small><p class="reminder-dialog-error" role="alert">${escapeHtml(overlayShortcutError)}</p><div class="reminder-actions"><button type="button" data-close-overlay-shortcut>${t("Отмена")}</button><button type="submit">${t("Сохранить")}</button></div></form></dialog>` : ""}

      </main>

    </div>`;

  bindEvents();
  if (retainedList) {
    updateRetainedReminder(retainedList);
    root.querySelector(".task-list")?.replaceWith(retainedList);
  }
  animatePositionChanges(previousPositions);
  const list = root.querySelector<HTMLOListElement>(".task-list");
  const firstPending = list?.children.length ?? 0;
  if (list && visibleTasks.length > firstPending && !showingHistory) {
    const schedule = (callback: () => void): void => {
      requestAnimationFrame(() => { if (mouseDragActive || taskPointerHeld) schedule(callback); else callback(); });
    };
    cancelListAppend = appendInBatches(visibleTasks.slice(firstPending), (batch, start) => {
      const template = document.createElement("template");
      template.innerHTML = batch.map((task, index) => renderTask(task, start + firstPending + index, !showingToday)).join("");
      bindEvents(template.content);
      animatePositionChanges(previousPositions, template.content);
      const rename = template.content.querySelector<HTMLInputElement>(".rename-input");
      const entering = batch.find((task) => enteringTaskIds.has(task.id));
      list.append(template.content);
      restoreReminderPosition(list, list.children.length === visibleTasks.length);
      if (rename) { rename.focus(); rename.select(); }
      if (pendingTaskFocusId && batch.some((task) => task.id === pendingTaskFocusId)) focusTaskWhenRendered(pendingTaskFocusId);
      if (entering) list.querySelector<HTMLElement>(`[data-task-id="${entering.id}"]`)?.scrollIntoView({ block: "nearest" });
      animateEnteringTasks();
    }, schedule);
  }
  animateEnteringTasks();
  if (pendingTaskFocusId && root.querySelector(`[data-task-id="${CSS.escape(pendingTaskFocusId)}"]`)) focusTaskWhenRendered(pendingTaskFocusId);
  renderReminderDialog();
  restoreReminderPosition(list, !list || list.children.length === visibleTasks.length);
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

function bindEvents(scope: ParentNode = root): void {
  scope.querySelectorAll<HTMLButtonElement>("[data-purge-task]").forEach((button) => button.addEventListener("click", () => { if (button.dataset.purgeTask) void openPermanentDeletion(button.dataset.purgeTask); }));
  scope.querySelectorAll<HTMLButtonElement>("[data-delete-task]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.deleteTask; if (!id || saving || taskAnimationLocks.has(id)) return;
    const deleted = await perform(async () => {
      const undo = await invoke<UndoDeletion>("delete_task", { id });
      deletionUndos = [...deletionUndos.filter((item) => item.taskId !== id), undo]; undoMessage = ""; renderDeletionUndos();
    });
    if (deleted) { await refreshDeletionUndos(); if (activeView === "history") await refreshHistory(); }
  }));
  if (scope === root) bindNotificationControls();
  scope.querySelectorAll<HTMLButtonElement>("[data-add-timer]").forEach((button) => button.addEventListener("click", () => { timerError = ""; timerDialogOpen = true; render(true); }));
  scope.querySelector<HTMLButtonElement>("[data-close-timer]")?.addEventListener("click", () => { timerDialogOpen = false; timerError = ""; render(true); root.querySelector<HTMLButtonElement>("[data-add-timer]")?.focus({ preventScroll: true }); });
  scope.querySelector<HTMLDialogElement>("[data-timer-dialog]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) { timerDialogOpen = false; render(true); } });
  scope.querySelector<HTMLDialogElement>("[data-timer-dialog]")?.addEventListener("cancel", (event) => { event.preventDefault(); timerDialogOpen = false; render(true); root.querySelector<HTMLButtonElement>("[data-add-timer]")?.focus({ preventScroll: true }); });
  scope.querySelector<HTMLFormElement>("[data-timer-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const name = String(new FormData(form).get("name") ?? "").trim();
    const durationSeconds = timerSecondsFromForm(form);
    if (!name || !durationSeconds || durationSeconds > 359_999) { timerError = t("Укажите название и длительность от 1 секунды до 99 часов 59 минут 59 секунд."); render(true); return; }
    try {
      await invoke<Timer>("create_timer", { name, durationSeconds });
      timerDialogOpen = false;
      await refreshTimers();
    } catch (error) { timerError = backendMessage(error); render(true); }
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-timer-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.timerId; const action = button.dataset.timerAction;
    if (!id || !action) return;
    try {
      if (action === "delete") await invoke("delete_timer", { id });
      else if (action === "pause") { await invoke("pause_timer", { id }); announce(t("Таймер приостановлен")); }
      else if (action === "reset") { await invoke("reset_timer", { id }); announce(t("Таймер сброшен")); }
      else {
        const timer = timers.find((item) => item.id === id);
        if (timer?.status === "finished") await invoke("reset_timer", { id });
        await invoke("start_timer", { id }); announce(t("Таймер запущен"));
      }
      await refreshTimers();
    } catch (error) { timerError = backendMessage(error); render(true); }
  }));
  scope.querySelectorAll<HTMLButtonElement>("[data-timer-fullscreen]").forEach((button) => button.addEventListener("click", () => {
    fullscreenTimerId = button.dataset.timerFullscreen ?? null;
    render(true);
  }));
  scope.querySelector<HTMLButtonElement>("[data-exit-fullscreen]")?.addEventListener("click", () => { fullscreenTimerId = null; render(true); });
  scope.querySelectorAll<HTMLButtonElement>("[data-edit-reminder]").forEach((button) => button.addEventListener("click", async () => {
    if (reminderOpening || reminderEditingTaskId) return;
    reminderOpening = true;
    try {
      preferences = await invoke<typeof preferences>("get_preferences"); preferencesReady = true;
      const task = tasks.find((item) => item.id === button.dataset.editReminder && item.status === "active");
      if (!task || activeView !== "today") return;
      reminderReturn = { id: task.id, view: activeView, scrollTop: root.querySelector<HTMLElement>(".task-list")?.scrollTop ?? 0, restoreFocus: false, signature: reminderListSignature() };
      reminderEditingTaskId = task.id; reminderDraft = reminderInputValue(task.reminderAt); reminderDialogError = "";
      renderReminderDialog();
    } catch (error) { errorMessage = backendMessage(error); render(true); }
    finally { reminderOpening = false; }
  }));
  scope.querySelectorAll<HTMLAnchorElement>("[data-view]").forEach((link) => {
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

  scope.querySelectorAll<HTMLButtonElement>("[data-calendar-date]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.calendarDate;
      if (!value) return;
      selectedHistoryDate = value;
      calendarMonth = monthStart(parseLocalDate(value));
      render(true);
      void refreshHistory();
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-calendar-shift]").forEach((button) => {
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
  scope.querySelectorAll<HTMLButtonElement>("[data-restore-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.restoreTask;
      if (!id || saving) return;
      const restored = await perform(() => invoke("restore_task", { id }));
      if (restored) await refreshHistory();
    });
  });

  scope.querySelector<HTMLButtonElement>("[data-toggle-overlay]")?.addEventListener("click", async () => {
    try { await invoke("toggle_task_overlay"); }
    catch (error) { errorMessage = backendMessage(error); render(true); }
  });
  scope.querySelector<HTMLButtonElement>("[data-open-overlay-shortcut]")?.addEventListener("click", () => { overlayShortcutError = ""; overlayShortcutDialogOpen = true; render(true); });
  scope.querySelector<HTMLButtonElement>("[data-close-overlay-shortcut]")?.addEventListener("click", () => { overlayShortcutDialogOpen = false; overlayShortcutError = ""; render(true); });
  scope.querySelector<HTMLFormElement>("[data-overlay-shortcut-form]")?.addEventListener("submit", async (event) => {
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

  scope.querySelector<HTMLButtonElement>("[data-retry-load]")?.addEventListener("click", () => {
    loading = true;
    errorMessage = "";
    render();
    void refreshTasks();
  });

  scope.querySelector<HTMLFormElement>("#quick-add-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>("#new-task-title");
    const title = input?.value.trim() ?? "";
    if (!title) {
      errorMessage = t("Введите название задачи.");
      render();
      root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
      return;
    }
    void createTask(title);
  });

  scope.querySelectorAll<HTMLButtonElement>("[data-toggle-task]").forEach((button) => {
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

  scope.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
    row.querySelector<HTMLElement>(".task-content")?.addEventListener("dblclick", () => {
      if (saving || taskAnimationLocks.has(row.dataset.taskId ?? "") || editingTaskId === row.dataset.taskId) return;
      editingTaskId = row.dataset.taskId ?? null;
      errorMessage = "";
      render();
    });
  });

  scope.querySelectorAll<HTMLFormElement>("[data-rename-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const taskId = form.dataset.renameForm;
      const input = form.querySelector<HTMLInputElement>("[name=title]");
      const title = input?.value.trim() ?? "";
      if (!taskId || !title) {
        errorMessage = t("Введите название задачи.");
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

  scope.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
    row.addEventListener("pointerdown", (event) => {
      if (saving || mouseDragActive || taskAnimationLocks.size || event.button !== 0 || (event.target as HTMLElement).closest("button, input, a")) return;
      taskPointerHeld = true;
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
          item.querySelector("[data-position]")?.setAttribute("aria-label", `${t("Задача")} ${index + 1}`);
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
        taskPointerHeld = false;
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
        const ids = [...ordered.map((item) => item.dataset.taskId!), ...activeTasks().slice(originalIds.length).map((task) => task.id)];
        if (!cancelled && didDrag && ids.slice(0, originalIds.length).some((id, index) => id !== originalIds[index])) void saveOrder(ids, ids.indexOf(row.dataset.taskId!));
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
    announce(`${t("Задача перемещена на позицию")} ${index + 1} ${t("из")} ${activeTasks().length}.`);
  }
  render();
  if (index >= 0) focusTaskWhenRendered(movedId);
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
  overlayRoot.setAttribute("role", "main"); skipLink.hidden = true;
  let overlayError = "";
  let lastRenderKey = "";
  let lastLanguage = language();
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
      const renderKey = JSON.stringify([language(), displaySettings.highContrast, task?.id, task?.title, task?.position, pinned, overlayError, displayTimers.map((timer) => [timer.id, timer.status, endingTimers.has(timer.id)])]);
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
      const restoreFocus = preserveTimerFocus(overlayRoot);
      const staged = document.createElement("div");
      staged.innerHTML = `<section class="overlay-card" aria-label="${t("Следующая задача")}">
        <header class="overlay-header ${pinned ? "is-pinned" : ""}"><span>${t("СЛЕДУЮЩАЯ ЗАДАЧА")}</span><button type="button" class="overlay-pin ${pinned ? "is-pinned" : ""}" data-overlay-pin aria-label="${pinned ? t("Снять закрепление и разрешить перемещение") : t("Закрепить положение поверх окон")}" title="${pinned ? t("Открепить") : t("Закрепить положение и поверх окон")}">${pinned ? "◆" : "◇"}</button></header>
        ${task ? `<div class="overlay-task"><strong>${escapeHtml(task.title)}</strong></div>
          <footer class="overlay-actions"><button type="button" data-overlay-complete="${task.id}">${t("Выполнено")}</button><button type="button" data-overlay-open>${t("Открыть список")}</button></footer>`
          : `<div class="overlay-empty"><strong>${t("На сегодня всё")}</strong><button type="button" data-overlay-open>${t("Добавить задачу")}</button></div>`}
        ${overlayError ? `<p class="overlay-error" role="alert">${escapeHtml(overlayError)} <button type="button" data-overlay-retry>${t("Повторить")}</button></p>` : ""}
      </section>`;
      if (displayTimers.length) {
        staged.insertAdjacentHTML("beforeend", `<section class="overlay-timer-area" aria-label="${t("Запущенные таймеры")}"><div class="overlay-timer-grid">${displayTimers.map((timer) => timerCard(timer, false, true).replace('class="timer-card ', `class="timer-card ${enteringTimerIds.has(timer.id) ? "is-entering" : ""} ${endingTimers.has(timer.id) ? "is-evaporating" : ""} `)).join("")}</div></section>`);
      }
      const nextHeader = staged.querySelector<HTMLElement>(".overlay-card")!;
      const currentHeader = overlayRoot.querySelector<HTMLElement>(".overlay-card");
      if (!currentHeader) overlayRoot.prepend(nextHeader);
      else currentHeader.replaceWith(nextHeader);
      let grid = overlayRoot.querySelector<HTMLElement>(".overlay-timer-grid");
      if (!grid && displayTimers.length) {
        const area = document.createElement("section");
        area.className = "overlay-timer-area";
        area.setAttribute("aria-label", t("Запущенные таймеры"));
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
        if (old && lastLanguage !== language()) {
          old.replaceWith(next);
        } else if (old) {
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
      lastLanguage = language();
      restoreFocus();
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
          else if (action === "pause") { await invoke("pause_timer", { id }); announce(t("Таймер приостановлен")); }
          else if (action === "reset") { await invoke("reset_timer", { id }); announce(t("Таймер сброшен")); }
          else {
            const timer = displayTimers.find((item) => item.id === id);
            if (timer?.status === "finished") await invoke("reset_timer", { id });
            await invoke("start_timer", { id }); announce(t("Таймер запущен"));
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
      overlayRoot.innerHTML = `<section class="overlay-card overlay-failed"><strong>${t("Очередь недоступна")}</strong><p role="alert">${escapeHtml(overlayError)}</p><button type="button" data-overlay-retry>${t("Повторить")}</button></section>`;
      overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-retry]")?.addEventListener("click", () => { overlayError = ""; void load(); });
    }
    finally { loadingOverlay = false; }
  };
  await load();
  void listen("tasks-changed", () => { void load(); });
  void listen("overlay-settings-error", () => { overlayError = t("Не удалось сохранить положение оверлея."); void load(); });
  window.setInterval(() => { void load(); }, 500);
}

async function loadShortcuts(): Promise<void> {
  try { shortcuts = await invoke<typeof shortcuts>("get_shortcuts"); shortcutsReady = true; shortcutsError = ""; }
  catch (error) { shortcutsReady = false; shortcutsError = backendMessage(error); }
  if (getCurrentWindow().label !== "overlay" && activeView === "settings") render(true);
}
void listen<ClearMode>("data-cleared", ({ payload }) => {
  announce(t("Данные очищены"));
  tasks = []; deletionUndos = []; editingTaskId = null; reminderEditingTaskId = null; reminderReturn = null;
  highlightedReminderTaskId = null; pendingTaskFocusId = null;
  enteringTaskIds.clear(); taskAnimationLocks.clear();
  if (payload === "allData") { timers = []; timerSnapshots.clear(); fullscreenTimerId = null; timerDialogOpen = false; }
  if (getCurrentWindow().label !== "overlay") { render(true); void refreshTasks(); void refreshHistory(); if (payload === "allData") void refreshTimers(); }
});
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
  errorMessage = typeof payload === "string" ? backendText(payload) : t("Не удалось отправить уведомление. Проверьте Параметры Windows → Система → Уведомления.");
  notificationActionMessage = errorMessage;
  if (activeView === "settings") updateNotificationControls(); else render(true);
  void refreshNotificationStatus();
});
void listen("reminder-runtime-error", () => {
  errorMessage = t("Не удалось обработать напоминание. Перезапустите приложение.");
  render(true);
});
void refreshAutostart();
void invoke<string>("get_app_version").then((value) => { appVersion = value; if (activeView === "settings") render(true); }).catch((error) => { appVersionError = backendMessage(error); if (activeView === "settings") render(true); });
void listen("open-settings", () => {
  activeView = "settings";
  window.history.pushState(null, "", "#settings");
  render(true);
  void refreshAutostart();
  void refreshNotificationStatus();
});
void refreshNotificationStatus();
window.addEventListener("focus", () => { if (activeView === "settings") { void refreshAutostart(); void refreshDiagnosticsWarning(); } void refreshNotificationStatus(); });
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
  if (document.querySelector("dialog[open]")) return;
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
  announce(`${t("Таймер завершён:")} ${payload.name}.`);
  await refreshTimers();
});
void listen<string | null>("timer-notification-error", ({ payload }) => {
  timerError = typeof payload === "string" ? backendText(payload) : t("Не удалось отправить уведомление. Проверьте Параметры Windows → Система → Уведомления.");
  notificationActionMessage = timerError;
  if (activeView === "timers") render(true); else if (activeView === "settings") updateNotificationControls();
  void refreshNotificationStatus();
});
void listen("timer-runtime-error", () => {
  timerError = t("Не удалось сохранить состояние таймера.");
  if (activeView === "timers") render(true);
});
void listen("archive-runtime-error", () => {
  errorMessage = t("Не удалось проверить срок задач. Перезапустите приложение.");
  render();
});
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
  errorMessage = `${backendText(payload)} ${t("Проверьте, не занято ли сочетание другой программой.")}`;
  render(true);
});
void invoke<OverlayShortcutStatus>("get_overlay_shortcut_status").then((status) => {
  overlayShortcut = status.shortcut;
  overlayShortcutAvailable = status.available;
  if (!status.available) errorMessage = `${t("Не удалось зарегистрировать")} ${status.shortcut}. ${t("Можно выбрать другое сочетание клавиш.")}`;
  render(true);
}).catch((error) => {
  errorMessage = backendMessage(error);
  render(true);
});
}
