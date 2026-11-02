import { type Language } from "./i18n.ts";
export interface DisplaySettings {
    language: Language;
    highContrast: boolean;
}
export type TaskStatus = "active" | "completed" | "archived";
export type Theme = "system" | "dark" | "light";
export interface Task {
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
export interface Timer {
    id: string;
    name: string;
    durationSeconds: number;
    remainingSeconds: number;
    status: "ready" | "running" | "paused" | "finished";
}
export interface HistoryTask {
    task: Task;
    occurredAt: number;
    createdAt: number;
}
export interface HistoryDay {
    completed: HistoryTask[];
    archived: HistoryTask[];
}
export interface BackendError {
    code?: string;
    message?: string;
}
export interface OverlayShortcutStatus {
    shortcut: string;
    available: boolean;
}
export type View = "today" | "completed" | "history" | "timers" | "settings";
export interface UndoDeletion {
    token: string;
    taskId: string;
    title: string;
    expiresAt: number;
}
export interface PermanentDeletionPreview {
    token: string;
    task: Task;
    eventCount: number;
    sessionCount: number;
}
export interface NotificationStatus {
    state: string;
    message: string;
    canTest: boolean;
    usesSystemIdentity: boolean;
}
export interface BackupStatus {
    directory: string;
    warning: string | null;
    databaseAvailable: boolean;
    hasDailyCopy: boolean;
}
export interface RestorePreview {
    token: string;
    source: string;
    tasks: number;
    events: number;
    timers: number;
}
export type ClearMode = "tasks" | "allData";
