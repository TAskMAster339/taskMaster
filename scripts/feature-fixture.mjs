// Development-only browser fixture. Never reads or modifies the native database.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { defaultShortcuts } from '../src/shortcuts.ts';
if (window.__TAURI_INTERNALS__) throw Error('Browser fixture must not run in Tauri');
const query = new URLSearchParams(location.search);
const count = Number(query.get('count') || 100);
const now = Date.now();
let tasks = Array.from({ length: count }, (_, position) => ({ id: `fixture-${position}`, title: position === 0 ? 'Настройки' : `Task ${position + 1}`, status: 'active', position, createdAt: now, updatedAt: now, completedAt: null, archivedAt: null, reminderAt: null, reminderState: null }));
let timers = [{ id: 'fixture-timer', name: 'User timer', durationSeconds: 90, remainingSeconds: 90, status: query.has('running') ? 'running' : 'ready' }];
let display = JSON.parse(localStorage.getItem('fixture.display') || '{"language":"ja","highContrast":false}');
let reminderError = false;
let displayError = false;
let databaseError = false;
let resetError = false;
const calls = [];
mockWindows(query.get('window') === 'overlay' ? 'overlay' : 'main');
mockIPC(async (command, args) => {
  calls.push({ command, args });
  switch (command) {
    case 'get_display_settings': return display;
    case 'update_display_settings':
      if (displayError) throw { code: 'presentation_error', message: 'Не удалось сохранить настройки отображения. Повторите попытку.' };
      display = args.settings; localStorage.setItem('fixture.display', JSON.stringify(display));
      await emit('display-settings-changed', display); return display;
    case 'get_shortcuts': return defaultShortcuts;
    case 'get_preferences': return { reminderMinutes: 15, archiveHours: 24 };
    case 'get_overlay_shortcut_status': return { shortcut: 'Ctrl+Alt+Space', available: true };
    case 'get_autostart_enabled': return false;
    case 'get_app_version': return 'fixture';
    case 'get_diagnostics_warning': return null;
    case 'get_backup_status': return { directory: 'fixture', warning: null, databaseAvailable: !databaseError, hasDailyCopy: false };
    case 'get_notification_status': return { canTest: true, message: 'Уведомления разрешены в Windows.', usesSystemIdentity: false };
    case 'list_deletion_undos': return [];
    case 'list_task_creation_times': return [now];
    case 'list_history_for_range': return { completed: [], archived: [] };
    case 'list_tasks':
      if (databaseError) throw { code: 'storage_error', message: 'Не удалось открыть локальную базу данных.' };
      return tasks;
    case 'get_next_task': return tasks[0] || null;
    case 'list_timers': return timers;
    case 'get_overlay_pinned': return false;
    case 'set_task_reminder':
    case 'clear_task_reminder': {
      if (reminderError) throw { code: 'invalid_reminder_time', message: 'Выберите время позже текущего.' };
      const task = tasks.find(task => task.id === args.id);
      task.reminderAt = command === 'set_task_reminder' ? args.reminderAt : null;
      task.reminderState = task.reminderAt ? 'pending' : null; return;
    }
    case 'start_timer': timers[0].status = 'running'; return;
    case 'pause_timer': timers[0].status = 'paused'; return;
    case 'reset_timer': timers[0].status = 'ready'; return;
    case 'open_about_link': return;
    case 'clear_user_data':
      if (args.mode === 'allData') {
        if (resetError) throw { code: 'reset_error', message: 'Не удалось подготовить полный сброс. Данные не удалены. Повторите попытку.' };
        window.featureFixture.resetRequested = true; return;
      }
      tasks = [];
      await emit('data-cleared', args.mode); await emit('tasks-changed'); return;
    default: throw Error(`Unmocked command: ${command}`);
  }
}, { shouldMockEvents: true });
window.addEventListener('storage', event => {
  if (event.key === 'fixture.display') { display = JSON.parse(event.newValue); void emit('display-settings-changed', display); }
});
window.featureFixture = { calls, resetRequested: false, setResetError(value) { resetError = value; }, async setDatabaseError(value) { databaseError = value; await emit('tasks-changed'); }, setReminderError(value) { reminderError = value; }, setDisplayError(value) { displayError = value; }, async removeTask(id) { tasks = tasks.filter(task => task.id !== id); await emit('tasks-changed'); } };
await import('../src/main.ts');
window.featureFixture.ready = true;
