import { appState } from "../../app/state.ts";
import { announce, escapeHtml, root } from "../../shared/dom.ts";
import { backendMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import { invoke } from "../../shared/tauri.ts";
import { type Timer } from "../../shared/types.ts";
import { timersState } from "./state.ts";
export function preserveTimerFocus(scope: ParentNode): () => void {
    const control = document.activeElement as HTMLElement | null;
    const card = control?.closest<HTMLElement>("[data-timer-card]");
    if (!control || !card || !scope.contains(control))
        return () => { };
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
export const timerSnapshots = new Map<string, {
    remainingSeconds: number;
    sampledAt: number;
    status: Timer["status"];
}>();
export function formatTimerTime(seconds: number): string {
    const remaining = Math.max(0, seconds);
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const secondsPart = remaining % 60;
    return [hours, minutes, secondsPart].map((part) => String(part).padStart(2, "0")).join(":");
}
export function timerSecondsFromForm(form: HTMLFormElement): number {
    const values = new FormData(form);
    const hours = Number(values.get("hours"));
    const minutes = Number(values.get("minutes"));
    const seconds = Number(values.get("seconds"));
    return hours * 3600 + minutes * 60 + seconds;
}
export function synchronizeTimerSnapshots(nextTimers: Timer[]): void {
    const now = performance.now();
    const activeIds = new Set(nextTimers.map((timer) => timer.id));
    for (const id of timerSnapshots.keys())
        if (!activeIds.has(id))
            timerSnapshots.delete(id);
    for (const timer of nextTimers) {
        const previous = timerSnapshots.get(timer.id);
        if (!previous || previous.status !== timer.status || timer.status !== "running") {
            timerSnapshots.set(timer.id, { remainingSeconds: timer.remainingSeconds, sampledAt: now, status: timer.status });
            continue;
        }
        const estimated = Math.max(0, previous.remainingSeconds - (now - previous.sampledAt) / 1000);
        if (Math.abs(estimated - timer.remainingSeconds) > 1.5) {
            timerSnapshots.set(timer.id, { remainingSeconds: timer.remainingSeconds, sampledAt: now, status: timer.status });
        }
    }
}
export function updateTimerVisuals(now: number): void {
    if (appState.activeView !== "timers")
        return;
    const circumference = 2 * Math.PI * 86;
    for (const timer of timersState.timers) {
        const snapshot = timerSnapshots.get(timer.id);
        if (!snapshot)
            continue;
        const remaining = snapshot.status === "running"
            ? Math.max(0, snapshot.remainingSeconds - (now - snapshot.sampledAt) / 1000)
            : snapshot.remainingSeconds;
        const card = root.querySelector<HTMLElement>(`[data-timer-card="${CSS.escape(timer.id)}"]`);
        const clock = card?.querySelector<HTMLElement>("[data-timer-clock]");
        if (clock)
            clock.textContent = formatTimerTime(Math.ceil(remaining));
        const progress = card?.querySelector<SVGCircleElement>(".timer-ring-progress");
        if (progress) {
            const ratio = timer.durationSeconds > 0 ? Math.min(1, remaining / timer.durationSeconds) : 0;
            progress.setAttribute("stroke-dashoffset", String(circumference * (1 - ratio)));
        }
    }
}
export function animateTimerFrames(): void {
    if (timersState.timerAnimationFrame !== null || !timersState.timers.some((timer) => timer.status === "running"))
        return;
    const tick = (now: number): void => {
        timersState.timerAnimationFrame = null;
        if (appState.activeView !== "timers" || !timersState.timers.some((timer) => timer.status === "running"))
            return;
        updateTimerVisuals(now);
        timersState.timerAnimationFrame = requestAnimationFrame(tick);
    };
    timersState.timerAnimationFrame = requestAnimationFrame(tick);
}
export function timerCard(timer: Timer, fullscreen = false, overlay = false): string {
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
export function renderTimers(): void {
    const restoreFocus = preserveTimerFocus(root);
    const focused = timersState.timers.find((timer) => timer.id === timersState.fullscreenTimerId);
    root.innerHTML = `<div class="app-shell ${focused ? "is-timer-fullscreen" : ""}">
    ${focused ? "" : effects.renderSidebar()}
    <main class="main-content timer-view ${focused ? "timer-view-fullscreen" : ""}" id="timers">
      ${focused ? `${timerCard(focused, true)}<p class="error-banner" role="alert" ${timersState.timerError ? "" : "hidden"}>${escapeHtml(timersState.timerError)}</p>` : `<header class="timer-page-heading"><div><p class="eyebrow">${t("ИНСТРУМЕНТЫ")}</p><h1>${t("Таймеры")}<span class="heading-period">.</span></h1></div><button class="add-button timer-add-button" type="button" data-add-timer aria-label="${t("Добавить таймер")}">＋</button></header>
      <p class="error-banner" role="alert" ${timersState.timerError ? "" : "hidden"}>${escapeHtml(timersState.timerError)}</p>
      <div class="timer-grid">${timersState.timers.length ? timersState.timers.map((timer) => timerCard(timer)).join("") : `<div class="empty-state"><strong>${t("Таймеров пока нет")}</strong><button class="retry-button" type="button" data-add-timer>${t("Добавить таймер")}</button></div>`}</div>
      ${timersState.timerDialogOpen ? `<dialog class="reminder-dialog timer-dialog" data-timer-dialog aria-labelledby="timer-heading"><form data-timer-form><h2 id="timer-heading">${t("Добавить таймер")}</h2><label for="timer-hours">${t("Длительность")}</label><div class="timer-duration-fields"><input id="timer-hours" type="number" name="hours" min="0" max="99" value="00" aria-label="${t("Часы")}" required/><span>:</span><input type="number" name="minutes" min="0" max="59" value="00" aria-label="${t("Минуты")}" required/><span>:</span><input type="number" name="seconds" min="0" max="59" value="00" aria-label="${t("Секунды")}" required/></div><label for="timer-name">${t("Название")}</label><input id="timer-name" name="name" type="text" maxlength="80" value="${t("Таймер (")}${timersState.timers.length + 1})" required/><p class="reminder-dialog-error" role="alert">${escapeHtml(timersState.timerError)}</p><div class="reminder-actions"><button type="button" data-close-timer>${t("Отмена")}</button><button type="submit">${t("Сохранить")}</button></div></form></dialog>` : ""}`}
    </main></div>`;
    effects.bindEvents();
    animateTimerFrames();
    restoreFocus();
    const dialog = root.querySelector<HTMLDialogElement>("[data-timer-dialog]");
    if (dialog && !dialog.open)
        dialog.showModal();
}
export async function refreshTimers(shouldRender = true): Promise<void> {
    try {
        const previous = timersState.timers;
        const nextTimers = await invoke("list_timers");
        synchronizeTimerSnapshots(nextTimers);
        timersState.timers = nextTimers;
        timersState.timerError = "";
        const changed = previous.length !== timersState.timers.length || timersState.timers.some((timer, index) => previous[index]?.id !== timer.id || previous[index]?.status !== timer.status);
        if (shouldRender && appState.activeView === "timers")
            effects.render(true);
        else if (changed && appState.activeView === "timers")
            effects.render(true);
    }
    catch (error) {
        timersState.timerError = backendMessage(error);
        if (shouldRender && appState.activeView === "timers")
            effects.render(true);
    }
}
export function bindTimersEvents(scope: ParentNode): void {
    scope.querySelectorAll<HTMLButtonElement>("[data-add-timer]").forEach((button) => button.addEventListener("click", () => { timersState.timerError = ""; timersState.timerDialogOpen = true; effects.render(true); }));
    scope.querySelector<HTMLButtonElement>("[data-close-timer]")?.addEventListener("click", () => { timersState.timerDialogOpen = false; timersState.timerError = ""; effects.render(true); root.querySelector<HTMLButtonElement>("[data-add-timer]")?.focus({ preventScroll: true }); });
    scope.querySelector<HTMLDialogElement>("[data-timer-dialog]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) {
        timersState.timerDialogOpen = false;
        effects.render(true);
    } });
    scope.querySelector<HTMLDialogElement>("[data-timer-dialog]")?.addEventListener("cancel", (event) => { event.preventDefault(); timersState.timerDialogOpen = false; effects.render(true); root.querySelector<HTMLButtonElement>("[data-add-timer]")?.focus({ preventScroll: true }); });
    scope.querySelector<HTMLFormElement>("[data-timer-form]")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const name = String(new FormData(form).get("name") ?? "").trim();
        const durationSeconds = timerSecondsFromForm(form);
        if (!name || !durationSeconds || durationSeconds > 359999) {
            timersState.timerError = t("Укажите название и длительность от 1 секунды до 99 часов 59 минут 59 секунд.");
            effects.render(true);
            return;
        }
        try {
            await invoke("create_timer", { name, durationSeconds });
            timersState.timerDialogOpen = false;
            await refreshTimers();
        }
        catch (error) {
            timersState.timerError = backendMessage(error);
            effects.render(true);
        }
    });
    scope.querySelectorAll<HTMLButtonElement>("[data-timer-action]").forEach((button) => button.addEventListener("click", async () => {
        const id = button.dataset.timerId;
        const action = button.dataset.timerAction;
        if (!id || !action)
            return;
        try {
            if (action === "delete")
                await invoke("delete_timer", { id });
            else if (action === "pause") {
                await invoke("pause_timer", { id });
                announce(t("Таймер приостановлен"));
            }
            else if (action === "reset") {
                await invoke("reset_timer", { id });
                announce(t("Таймер сброшен"));
            }
            else {
                const timer = timersState.timers.find((item) => item.id === id);
                if (timer?.status === "finished")
                    await invoke("reset_timer", { id });
                await invoke("start_timer", { id });
                announce(t("Таймер запущен"));
            }
            await refreshTimers();
        }
        catch (error) {
            timersState.timerError = backendMessage(error);
            effects.render(true);
        }
    }));
    scope.querySelectorAll<HTMLButtonElement>("[data-timer-fullscreen]").forEach((button) => button.addEventListener("click", () => {
        timersState.fullscreenTimerId = button.dataset.timerFullscreen ?? null;
        effects.render(true);
    }));
    scope.querySelector<HTMLButtonElement>("[data-exit-fullscreen]")?.addEventListener("click", () => { timersState.fullscreenTimerId = null; effects.render(true); });
}
type Effects = {
    renderSidebar: typeof import("../../app/view.ts").renderSidebar;
    bindEvents: typeof import("../../app/view.ts").bindEvents;
    render: typeof import("../../app/view.ts").render;
};
let effects: Effects;
export function configureTimers(callbacks: Effects): void { effects = callbacks; }
