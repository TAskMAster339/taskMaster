import { t } from "./i18n.ts";
export const defaultShortcuts = {
  new_task: "Ctrl+N", new_timer: "Ctrl+Shift+N", settings: "Ctrl+Comma",
  today: "Ctrl+1", completed: "Ctrl+2", history: "Ctrl+3", timers: "Ctrl+4",
  reminder: "Ctrl+R", rename: "F2", move_up: "Alt+ArrowUp", move_down: "Alt+ArrowDown",
};
export type ShortcutAction = keyof typeof defaultShortcuts;
export const shortcutLabels: Record<ShortcutAction, string> = {
  get new_task() { return t("Новая задача"); }, get new_timer() { return t("Новый таймер"); }, get settings() { return t("Настройки"); }, get today() { return t("Сегодня"); },
  get completed() { return t("Выполнено"); }, get history() { return t("История"); }, get timers() { return t("Таймеры"); }, get reminder() { return t("Напоминание задачи"); },
  get rename() { return t("Переименовать задачу"); }, get move_up() { return t("Переместить вверх"); }, get move_down() { return t("Переместить вниз"); },
};
export function keyboardCombination(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): string | null {
  if (event.metaKey) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(event.code) || ["Comma", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Escape"].includes(event.code)) key = event.code;
  else return null;
  if (!event.ctrlKey && !event.altKey && !/^F([1-9]|1[0-2])$/.test(key)) return null;
  return [event.ctrlKey ? "Ctrl" : "", event.shiftKey ? "Shift" : "", event.altKey ? "Alt" : "", key].filter(Boolean).join("+");
}
export function displayShortcut(value: string): string { return value.replace("Comma", ",").replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("Space", t("Пробел")); }
