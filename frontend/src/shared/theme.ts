import { t } from "./i18n.ts";
import { type Theme } from "./types.ts";
export const themeStorageKey = "taskmaster.theme";
export const themeOrder: Theme[] = ["system", "dark", "light"];
export const themeLabels: Record<Theme, string> = { get system() { return t("Системная"); }, get dark() { return t("Тёмная"); }, get light() { return t("Светлая"); } };
export function readTheme(): Theme {
    try {
        const value = localStorage.getItem(themeStorageKey);
        return themeOrder.includes(value as Theme) ? value as Theme : "system";
    }
    catch {
        return "system";
    }
}
