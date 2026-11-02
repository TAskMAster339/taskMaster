export const displayWarning = document.createElement("p");
export const root: HTMLDivElement = document.querySelector<HTMLDivElement>("#app") ?? (() => {
    throw new Error("Application root was not found");
})();
export const liveStatus = document.createElement("div");
export function announce(message: string): void { liveStatus.textContent = message; }
export const skipLink = document.createElement("a");
export function waitForMotion(milliseconds: number): Promise<void> {
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : milliseconds;
    return new Promise((resolve) => window.setTimeout(resolve, duration));
}
export function escapeHtml(value: string): string {
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
