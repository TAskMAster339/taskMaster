// Development-only fixture. Browser: mocked data. Native: explicitly seeded disposable DB.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { defaultShortcuts } from '../src/shortcuts.ts';

const count = Math.min(5000, Math.max(1, Number(new URLSearchParams(location.search).get('count')) || 5000));
const now = Date.now();
const app = document.getElementById('app');
const tasks = Array.from({ length: count }, (_, position) => ({
  id: `fixture-${position}`, title: position === 0 ? 'Длинное название '.repeat(18).slice(0, 300) : `Задача ${position + 1}`,
  status: 'active', position, createdAt: now, updatedAt: now,
  completedAt: null, archivedAt: null, reminderAt: null, reminderState: null,
}));
const nativeRuntime = Boolean(window.__TAURI_INTERNALS__);
if (!nativeRuntime) {
  mockWindows('main');
  mockIPC((command) => {
    switch (command) {
      case 'list_tasks': return tasks;
      case 'get_shortcuts': return defaultShortcuts;
      case 'get_preferences': return { reminderMinutes: 15, archiveHours: 24 };
      case 'get_overlay_shortcut_status': return { shortcut: 'Ctrl+Alt+Space', available: true };
      case 'get_autostart_enabled': return false;
      case 'get_app_version': return 'fixture';
      case 'get_diagnostics_warning': return null;
      case 'get_backup_status': return { directory: 'fixture', warning: null, databaseAvailable: true, hasDailyCopy: false };
      case 'get_notification_status': return { canTest: true, message: 'Проверочный режим', development: true };
      case 'list_deletion_undos': return [];
      case 'list_timers': return [];
      default: throw new Error(`Unmocked command: ${command}`);
    }
  }, { shouldMockEvents: true });
}

const longTasks = [];
const errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const observer = new PerformanceObserver((entries) => {
  longTasks.push(...entries.getEntries().map((entry) => ({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) })));
});
const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
if (longTaskSupported) observer.observe({ type: 'longtask', buffered: true });
const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const rowCount = () => app.querySelector('.task-list')?.childElementCount ?? 0;
const result = { fixtureRevision: 'batched-32-position-snapshot', count, nativeRuntime, userAgent: navigator.userAgent, errors };
const start = performance.now();
await import('../src/main.ts');
const deadline = performance.now() + 10000;
while (!app.querySelector('.task-row') && performance.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await paint();
result.firstTasksPaintMs = Math.round(performance.now() - start);
while (rowCount() !== count && performance.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
await paint();
result.completeListPaintMs = Math.round(performance.now() - start);
result.renderedRows = rowCount();
if (result.renderedRows !== count) errors.push(`Expected ${count} rows, found ${result.renderedRows}`);
const settingsStart = performance.now();
app.querySelector('[data-view="settings"]').click();
while (!app.querySelector('.settings-view')) await new Promise((resolve) => setTimeout(resolve, 25));
await paint();
result.settingsToPaintMs = Math.round(performance.now() - settingsStart);
const todayStart = performance.now();
app.querySelector('[data-view="today"]').click();
await paint();
result.todayToPaintMs = Math.round(performance.now() - todayStart);
while (rowCount() !== count && performance.now() < todayStart + 10000) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
result.todayCompleteListMs = Math.round(performance.now() - todayStart);

// Mutations are opt-in and limited to explicitly named fixture tasks.
if (nativeRuntime && new URLSearchParams(location.search).has('exercise')) {
  const { invoke } = await import('@tauri-apps/api/core');
  const waitFor = async (predicate) => {
    const until = performance.now() + 10000;
    while (!(await predicate())) {
      if (performance.now() >= until) throw new Error('Interaction timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    const before = (await invoke('list_tasks')).filter((task) => task.status === 'active');
    if (before.length !== count || !before.every((task) => /^fixture-\d+$/.test(task.id))) throw new Error('Refusing mutations: seed disposable fixture tasks first');
    const first = before[0];
    result.lastInteraction = 'keyboard reorder';
    const row = app.querySelector(`[data-task-id="${first.id}"]`);
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', altKey: true, bubbles: true }));
    await waitFor(async () => (await invoke('list_tasks'))[1]?.id === first.id);
    await waitFor(() => app.querySelector(`.task-row[data-task-id="${first.id}"]`));
    const waitEnabled = () => waitFor(() => app.getAttribute('aria-busy') !== 'true' && app.querySelector(`[data-delete-task="${first.id}"]`)?.disabled === false);
    const rename = async (title) => {
      await waitEnabled();
      result.lastInteraction = 'rename';
      app.querySelector(`[data-task-id="${first.id}"] .task-content`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await waitFor(() => app.querySelector('.rename-input'));
      const input = app.querySelector('.rename-input');
      input.value = title; input.form.requestSubmit();
      await waitFor(async () => (await invoke('list_tasks')).find((task) => task.id === first.id)?.title === title);
      await waitFor(() => !app.querySelector('.rename-input'));
    };
    await rename('Проверка редактирования');
    await rename(first.title);
    await waitEnabled();
    result.lastInteraction = 'delete/undo';
    app.querySelector(`[data-delete-task="${first.id}"]`).click();
    await waitFor(() => document.querySelector('[data-undo-deletion]'));
    document.querySelector('[data-undo-deletion]').click();
    await waitFor(async () => (await invoke('list_tasks')).filter((task) => task.status === 'active').length === count);
    const after = (await invoke('list_tasks')).filter((task) => task.status === 'active');
    if (new Set(after.map((task) => task.id)).size !== count || after[1].id !== first.id || after[1].title !== first.title) throw new Error('Order/title changed during interactions');
    await waitFor(() => rowCount() === count);
    const domIds = [...app.querySelectorAll('.task-row')].map((item) => item.dataset.taskId);
    if (new Set(domIds).size !== count || domIds.some((id, index) => id !== after[index].id)) throw new Error('Rendered order differs from the database');
    result.interactions = 'PASS: keyboard reorder, rename/restore title, delete/undo; all IDs retained';
  } catch (error) { errors.push(String(error)); }
}
await new Promise((resolve) => setTimeout(resolve, 100));
result.longTasks = longTasks;
result.maxBlockingMs = longTaskSupported ? Math.max(0, ...longTasks.map((entry) => entry.duration)) : null;
observer.disconnect();
const output = document.createElement('pre');
output.style.cssText = 'padding:24px;overflow:auto;height:100vh;margin:0;white-space:pre-wrap';
output.textContent = JSON.stringify(result, null, 2);
document.body.replaceChildren(output);
if (!new URLSearchParams(location.search).has('exercise')) {
  output.style.height = '85vh';
  const button = document.createElement('button');
  button.textContent = 'Проверить действия на тестовых задачах';
  button.onclick = () => { location.search = `?count=${count}&exercise=1`; };
  document.body.append(button);
}
