import { backendText, t } from "./i18n.ts";
import { type BackendError } from "./types.ts";
export function backendMessage(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error) {
        const message = (error as BackendError).message;
        if (typeof message === "string")
            return backendText(message);
    }
    return t("Не удалось сохранить изменения. Попробуйте ещё раз.");
}
