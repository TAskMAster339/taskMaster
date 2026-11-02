import { locale } from "./i18n.ts";
export const yesterday = (() => { const date = new Date(); date.setDate(date.getDate() - 1); return date; })();
export function isSameLocalDay(timestamp: number | null, date: Date): boolean {
    if (timestamp === null)
        return false;
    const taskDate = new Date(timestamp);
    return taskDate.getFullYear() === date.getFullYear()
        && taskDate.getMonth() === date.getMonth()
        && taskDate.getDate() === date.getDate();
}
export function toLocalDateString(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function parseLocalDate(value: string): Date {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year!, month! - 1, day!);
}
export function monthStart(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}
export function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}
