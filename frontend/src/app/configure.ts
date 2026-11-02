import { configureDeletions, openClearData, refreshDeletionUndos, renderDeletionUndos } from "../features/deletions/controller.ts";
import { configureHistory, refreshHistory, renderCalendar, renderHistoryLists } from "../features/history/controller.ts";
import { configureOverlay } from "../features/overlay/controller.ts";
import { configureReminders, reminderListSignature, renderReminderDialog, restoreReminderPosition, updateRetainedReminder } from "../features/reminders/controller.ts";
import { applyTheme, bindNotificationControls, configureSettings, renderSettings } from "../features/settings/controller.ts";
import { activeTasks, animateEnteringTasks, animatePositionChanges, captureTaskPositions, completedTodayTasks, configureTasks, focusTaskWhenRendered, refreshTasks, renderTask } from "../features/tasks/controller.ts";
import { configureTimers, formatTimerTime, preserveTimerFocus, refreshTimers, renderTimers, timerCard } from "../features/timers/controller.ts";
import { configureNavigation } from "./navigation.ts";
import { bindEvents, configureView, perform, render, renderSidebar } from "./view.ts";
export function configureFeatures(): void {
    configureReminders({ activeTasks, renderTask, bindEvents, bindNotificationControls, render });
    configureDeletions({ render, refreshTasks, refreshHistory, perform });
    configureSettings({ render, refreshTasks, refreshTimers, refreshDeletionUndos, renderSidebar, bindEvents, openClearData, renderDeletionUndos });
    configureTasks({ render, perform });
    configureView({ activeTasks, completedTodayTasks, renderSettings, renderTimers, captureTaskPositions, renderHistoryLists, renderTask, reminderListSignature, renderCalendar, updateRetainedReminder, animatePositionChanges, restoreReminderPosition, focusTaskWhenRendered, animateEnteringTasks, renderReminderDialog, refreshTasks });
    configureTimers({ renderSidebar, bindEvents, render });
    configureHistory({ render, perform });
    configureNavigation({ render, refreshHistory, refreshTimers });
    configureOverlay({ applyTheme, formatTimerTime, preserveTimerFocus, timerCard });
}
