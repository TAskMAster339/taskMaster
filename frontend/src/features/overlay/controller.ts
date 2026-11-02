import { getCurrentWindow } from "@tauri-apps/api/window";
import { announce, escapeHtml, root, skipLink } from "../../shared/dom.ts";
import { backendMessage } from "../../shared/errors.ts";
import { language, t } from "../../shared/i18n.ts";
import { keyboardCombination } from "../../shared/shortcuts.ts";
import { invoke, listen } from "../../shared/tauri.ts";
import { readTheme } from "../../shared/theme.ts";
import { type Timer } from "../../shared/types.ts";
import { settingsState } from "../settings/state.ts";
export function bindOverlayTimerDrag(card: HTMLElement, pinned: boolean, reorder: (ids: string[]) => void, setDragging: (value: boolean) => void): void {
    card.classList.toggle("is-reorder-locked", pinned);
    card.tabIndex = 0;
    card.setAttribute("aria-keyshortcuts", `${settingsState.shortcuts.move_up} ${settingsState.shortcuts.move_down}`);
    card.onkeydown = (event) => {
        const combination = keyboardCombination(event);
        if (pinned || (event.target as HTMLElement).closest("button, input") || (combination !== settingsState.shortcuts.move_up && combination !== settingsState.shortcuts.move_down))
            return;
        event.preventDefault();
        const grid = card.parentElement!;
        const cards = [...grid.querySelectorAll<HTMLElement>("[data-timer-card]")].sort((a, b) => Number(a.style.order) - Number(b.style.order));
        const index = cards.indexOf(card);
        const target = index + (combination === settingsState.shortcuts.move_up ? -1 : 1);
        if (target < 0 || target >= cards.length)
            return;
        [cards[index], cards[target]] = [cards[target], cards[index]];
        cards.forEach((item, position) => { item.style.order = String(position); });
        reorder(cards.map((item) => item.dataset.timerCard!));
    };
    card.onpointerdown = (event) => {
        if (pinned || event.button !== 0 || (event.target as HTMLElement).closest("button") || card.classList.contains("is-evaporating"))
            return;
        const grid = card.parentElement!;
        const area = grid.parentElement!;
        const cards = [...grid.querySelectorAll<HTMLElement>("[data-timer-card]")].sort((a, b) => Number(a.style.order) - Number(b.style.order));
        const original = cards.map((item) => item.dataset.timerCard!);
        const bounds = card.getBoundingClientRect();
        const offsetX = event.clientX - bounds.left;
        const offsetY = event.clientY - bounds.top;
        let x = event.clientX, y = event.clientY;
        let preview: HTMLElement | null = null;
        let frame = 0;
        const animations = new Map<HTMLElement, Animation>();
        const positionCards = (ordered: HTMLElement[]): void => {
            const before = new Map(cards.map((item) => [item, item.getBoundingClientRect()]));
            for (const animation of animations.values())
                animation.cancel();
            ordered.forEach((item, index) => { item.style.order = String(index); });
            if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                for (const item of cards) {
                    if (item === card)
                        continue;
                    const old = before.get(item)!;
                    const next = item.getBoundingClientRect();
                    animations.set(item, item.animate([{ transform: `translate(${old.left - next.left}px, ${old.top - next.top}px)` }, { transform: "translate(0, 0)" }], { duration: 200, easing: "ease-out" }));
                }
            }
        };
        const tick = (): void => {
            if (!preview)
                return;
            preview.style.left = `${Math.max(0, Math.min(window.innerWidth - bounds.width, x - offsetX))}px`;
            preview.style.top = `${Math.max(0, Math.min(window.innerHeight - bounds.height, y - offsetY))}px`;
            const areaBounds = area.getBoundingClientRect();
            if (x > areaBounds.right - 40)
                area.scrollLeft += 12;
            else if (x < areaBounds.left + 40)
                area.scrollLeft -= 12;
            const ordered = [...cards].sort((a, b) => Number(a.style.order) - Number(b.style.order));
            let nearest = card, distance = Infinity;
            for (const item of cards) {
                const gridBounds = grid.getBoundingClientRect();
                const d = Math.hypot(x - (gridBounds.left + item.offsetLeft + item.offsetWidth / 2), y - (gridBounds.top + item.offsetTop + item.offsetHeight / 2));
                if (d < distance) {
                    nearest = item;
                    distance = d;
                }
            }
            if (nearest !== card) {
                const index = ordered.indexOf(nearest);
                ordered.splice(ordered.indexOf(card), 1);
                ordered.splice(index, 0, card);
                positionCards(ordered);
            }
            frame = requestAnimationFrame(tick);
        };
        const hold = window.setTimeout(() => {
            window.getSelection()?.removeAllRanges();
            setDragging(true);
            card.setPointerCapture(event.pointerId);
            preview = card.cloneNode(true) as HTMLElement;
            preview.removeAttribute("data-timer-card");
            preview.removeAttribute("tabindex");
            preview.setAttribute("aria-hidden", "true");
            preview.classList.remove("is-entering");
            preview.classList.add("overlay-timer-drag-preview");
            document.body.append(preview);
            card.classList.add("is-timer-drag-source");
            document.body.classList.add("is-overlay-timer-dragging");
            tick();
        }, 180);
        const finish = (cancelled = false): void => {
            window.clearTimeout(hold);
            cancelAnimationFrame(frame);
            if (preview) {
                if (cancelled)
                    positionCards(original.map((id) => cards.find((item) => item.dataset.timerCard === id)!));
                else
                    reorder([...cards].sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((item) => item.dataset.timerCard!));
                preview.remove();
                card.classList.remove("is-timer-drag-source");
                document.body.classList.remove("is-overlay-timer-dragging");
                setDragging(false);
            }
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("blur", cancel);
            window.removeEventListener("keydown", escape);
            if (card.hasPointerCapture(event.pointerId))
                card.releasePointerCapture(event.pointerId);
        };
        const move = (moveEvent: PointerEvent): void => { x = moveEvent.clientX; y = moveEvent.clientY; if (preview)
            moveEvent.preventDefault(); };
        const up = (): void => finish();
        const cancel = (): void => finish(true);
        const escape = (key: KeyboardEvent): void => { if (key.key === "Escape")
            finish(true); };
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", escape);
    };
}
export async function renderOverlay(): Promise<void> {
    const overlayRoot = root;
    overlayRoot.setAttribute("role", "main");
    skipLink.hidden = true;
    let overlayError = "";
    let lastRenderKey = "";
    let lastLanguage = language();
    let previousRunningIds = new Set<string>();
    const visibleTimerIds = new Set<string>();
    const hiddenTimerIds = new Set<string>();
    let lastTimerCount = -1;
    let loadingOverlay = false;
    let draggingOverlayTimer = false;
    let shownTaskId: string | null = null;
    const enteringTimerIds = new Set<string>();
    const endingTimers = new Map<string, Timer>();
    const load = async (): Promise<void> => {
        if (loadingOverlay || draggingOverlayTimer)
            return;
        loadingOverlay = true;
        try {
            const active = (await invoke("list_tasks")).filter((task) => task.status === "active").sort((a, b) => a.position - b.position);
            const allTimers = await invoke("list_timers");
            settingsState.theme = readTheme();
            effects.applyTheme();
            for (const timer of allTimers)
                if (timer.status === "running" && !hiddenTimerIds.has(timer.id))
                    visibleTimerIds.add(timer.id);
            const runningTimers = [...visibleTimerIds].map((id) => allTimers.find((timer) => timer.id === id)).filter((timer): timer is Timer => Boolean(timer && timer.status !== "finished"));
            const runningIds = new Set(runningTimers.map((timer) => timer.id));
            for (const timer of runningTimers) {
                if (!previousRunningIds.has(timer.id)) {
                    enteringTimerIds.add(timer.id);
                    window.setTimeout(() => { enteringTimerIds.delete(timer.id); void load(); }, 520);
                }
            }
            for (const id of previousRunningIds) {
                if (!runningIds.has(id)) {
                    const finished = allTimers.find((timer) => timer.id === id && timer.status === "finished");
                    if (finished) {
                        endingTimers.set(id, finished);
                        window.setTimeout(() => { endingTimers.delete(id); visibleTimerIds.delete(id); void load(); }, 900);
                    }
                }
            }
            previousRunningIds = runningIds;
            const displayTimers = [...visibleTimerIds].map((id) => endingTimers.get(id) ?? runningTimers.find((timer) => timer.id === id)).filter((timer): timer is Timer => Boolean(timer));
            if (displayTimers.length !== lastTimerCount) {
                lastTimerCount = displayTimers.length;
                void invoke("resize_overlay_for_timers", { timerCount: displayTimers.length }).then((rows) => { document.documentElement.style.setProperty("--overlay-rows", String(rows)); });
            }
            const pinned = await invoke("get_overlay_pinned");
            const task = active[0];
            const renderKey = JSON.stringify([language(), settingsState.displaySettings.highContrast, task?.id, task?.title, task?.position, pinned, overlayError, displayTimers.map((timer) => [timer.id, timer.status, endingTimers.has(timer.id)])]);
            if (renderKey === lastRenderKey) {
                for (const timer of displayTimers) {
                    const card = overlayRoot.querySelector<HTMLElement>(`[data-timer-card="${CSS.escape(timer.id)}"]`);
                    const clock = card?.querySelector<HTMLElement>("[data-timer-clock]");
                    const progress = card?.querySelector<SVGCircleElement>(".timer-ring-progress");
                    if (clock)
                        clock.textContent = effects.formatTimerTime(timer.remainingSeconds);
                    if (progress) {
                        const circumference = 2 * Math.PI * 86;
                        const ratio = timer.durationSeconds > 0 ? timer.remainingSeconds / timer.durationSeconds : 0;
                        progress.setAttribute("stroke-dashoffset", String(circumference * (1 - ratio)));
                    }
                }
                return;
            }
            const taskChanged = shownTaskId !== null && shownTaskId !== (task?.id ?? null);
            if (taskChanged) {
                const oldText = overlayRoot.querySelector<HTMLElement>(".overlay-task, .overlay-empty");
                if (oldText && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                    await oldText.animate([{ opacity: 1, transform: "translateX(0)" }, { opacity: 0, transform: "translateX(-32px)" }], { duration: 220, easing: "ease-in", fill: "forwards" }).finished;
                }
            }
            shownTaskId = task?.id ?? null;
            const retainedCards = new Map([...overlayRoot.querySelectorAll<HTMLElement>("[data-timer-card]")].map((card) => [card.dataset.timerCard!, card]));
            lastRenderKey = renderKey;
            const restoreFocus = effects.preserveTimerFocus(overlayRoot);
            const staged = document.createElement("div");
            staged.innerHTML = `<section class="overlay-card" aria-label="${t("Следующая задача")}">
        <header class="overlay-header ${pinned ? "is-pinned" : ""}"><span>${t("СЛЕДУЮЩАЯ ЗАДАЧА")}</span><button type="button" class="overlay-pin ${pinned ? "is-pinned" : ""}" data-overlay-pin aria-label="${pinned ? t("Снять закрепление и разрешить перемещение") : t("Закрепить положение поверх окон")}" title="${pinned ? t("Открепить") : t("Закрепить положение и поверх окон")}">${pinned ? "◆" : "◇"}</button></header>
        ${task ? `<div class="overlay-task"><strong>${escapeHtml(task.title)}</strong></div>
          <footer class="overlay-actions"><button type="button" data-overlay-complete="${task.id}">${t("Выполнено")}</button><button type="button" data-overlay-open>${t("Открыть список")}</button></footer>`
                : `<div class="overlay-empty"><strong>${t("На сегодня всё")}</strong><button type="button" data-overlay-open>${t("Добавить задачу")}</button></div>`}
        ${overlayError ? `<p class="overlay-error" role="alert">${escapeHtml(overlayError)} <button type="button" data-overlay-retry>${t("Повторить")}</button></p>` : ""}
      </section>`;
            if (displayTimers.length) {
                staged.insertAdjacentHTML("beforeend", `<section class="overlay-timer-area" aria-label="${t("Запущенные таймеры")}"><div class="overlay-timer-grid">${displayTimers.map((timer) => effects.timerCard(timer, false, true).replace('class="timer-card ', `class="timer-card ${enteringTimerIds.has(timer.id) ? "is-entering" : ""} ${endingTimers.has(timer.id) ? "is-evaporating" : ""} `)).join("")}</div></section>`);
            }
            const nextHeader = staged.querySelector<HTMLElement>(".overlay-card")!;
            const currentHeader = overlayRoot.querySelector<HTMLElement>(".overlay-card");
            if (!currentHeader)
                overlayRoot.prepend(nextHeader);
            else
                currentHeader.replaceWith(nextHeader);
            let grid = overlayRoot.querySelector<HTMLElement>(".overlay-timer-grid");
            if (!grid && displayTimers.length) {
                const area = document.createElement("section");
                area.className = "overlay-timer-area";
                area.setAttribute("aria-label", t("Запущенные таймеры"));
                grid = document.createElement("div");
                grid.className = "overlay-timer-grid";
                area.append(grid);
                overlayRoot.append(area);
            }
            const wanted = new Set(displayTimers.map((timer) => timer.id));
            for (const [id, card] of retainedCards)
                if (!wanted.has(id))
                    card.remove();
            for (const next of staged.querySelectorAll<HTMLElement>("[data-timer-card]")) {
                const id = next.dataset.timerCard!;
                const old = retainedCards.get(id);
                if (old && lastLanguage !== language()) {
                    old.replaceWith(next);
                }
                else if (old) {
                    old.classList.toggle("is-evaporating", endingTimers.has(id));
                    if (!enteringTimerIds.has(id))
                        old.classList.remove("is-entering");
                    if (old.dataset.timerStatus !== next.dataset.timerStatus) {
                        old.dataset.timerStatus = next.dataset.timerStatus;
                        old.querySelector(".timer-controls")?.replaceWith(next.querySelector(".timer-controls")!);
                    }
                }
                else
                    grid?.append(next);
            }
            displayTimers.forEach((timer, index) => {
                const card = overlayRoot.querySelector<HTMLElement>(`[data-timer-card="${CSS.escape(timer.id)}"]`);
                if (!card)
                    return;
                card.style.order = String(index);
                bindOverlayTimerDrag(card, pinned, (ids) => {
                    const remaining = [...visibleTimerIds].filter((id) => !ids.includes(id));
                    visibleTimerIds.clear();
                    [...ids, ...remaining].forEach((id) => visibleTimerIds.add(id));
                    lastRenderKey = "";
                }, (value) => { draggingOverlayTimer = value; if (!value)
                    void load(); });
            });
            if (!displayTimers.length)
                overlayRoot.querySelector(".overlay-timer-area")?.remove();
            if (taskChanged)
                overlayRoot.querySelector<HTMLElement>(".overlay-task, .overlay-empty")?.animate([{ opacity: 0, transform: "translateX(32px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280, easing: "ease-out" });
            overlayRoot.querySelectorAll<HTMLButtonElement>("[data-hide-overlay-timer]").forEach((button) => {
                button.onclick = () => {
                    const id = button.dataset.hideOverlayTimer;
                    if (!id)
                        return;
                    hiddenTimerIds.add(id);
                    const timer = runningTimers.find((item) => item.id === id);
                    if (timer)
                        endingTimers.set(id, timer);
                    previousRunningIds.delete(id);
                    void load();
                    window.setTimeout(() => { visibleTimerIds.delete(id); endingTimers.delete(id); void load(); }, 900);
                };
            });
            lastLanguage = language();
            restoreFocus();
            overlayRoot.querySelector<HTMLElement>(".overlay-header")?.addEventListener("pointerdown", (event) => {
                if (pinned || (event.target as HTMLElement).closest("button"))
                    return;
                void getCurrentWindow().startDragging().catch((error: unknown) => { overlayError = backendMessage(error); });
            });
            overlayRoot.querySelectorAll<HTMLButtonElement>("[data-timer-action]").forEach((button) => {
                button.onclick = async () => {
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
                            const timer = displayTimers.find((item) => item.id === id);
                            if (timer?.status === "finished")
                                await invoke("reset_timer", { id });
                            await invoke("start_timer", { id });
                            announce(t("Таймер запущен"));
                        }
                        overlayError = "";
                        await load();
                    }
                    catch (error) {
                        overlayError = backendMessage(error);
                        await load();
                    }
                };
            });
            overlayRoot.querySelectorAll<HTMLButtonElement>("[data-timer-fullscreen]").forEach((button) => {
                button.onclick = () => {
                    const id = button.dataset.timerFullscreen;
                    if (id)
                        void invoke("open_overlay_timer_focus", { id });
                };
            });
            overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-pin]")?.addEventListener("click", async () => {
                try {
                    await invoke("set_overlay_pinned", { pinned: !pinned });
                    overlayError = "";
                    await load();
                }
                catch (error) {
                    overlayError = backendMessage(error);
                    await load();
                }
            });
            overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-complete]")?.addEventListener("click", async (event) => {
                const id = (event.currentTarget as HTMLButtonElement).dataset.overlayComplete;
                if (!id)
                    return;
                try {
                    await invoke("complete_overlay_task", { id });
                    overlayError = "";
                    await load();
                }
                catch (error) {
                    overlayError = backendMessage(error);
                    await load();
                }
            });
            overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-open]")?.addEventListener("click", () => { void invoke("open_task_list"); });
            overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-retry]")?.addEventListener("click", () => { overlayError = ""; void load(); });
        }
        catch (error) {
            overlayError = backendMessage(error);
            overlayRoot.innerHTML = `<section class="overlay-card overlay-failed"><strong>${t("Очередь недоступна")}</strong><p role="alert">${escapeHtml(overlayError)}</p><button type="button" data-overlay-retry>${t("Повторить")}</button></section>`;
            overlayRoot.querySelector<HTMLButtonElement>("[data-overlay-retry]")?.addEventListener("click", () => { overlayError = ""; void load(); });
        }
        finally {
            loadingOverlay = false;
        }
    };
    await load();
    void listen("tasks-changed", () => { void load(); });
    void listen("overlay-settings-error", () => { overlayError = t("Не удалось сохранить положение оверлея."); void load(); });
    window.setInterval(() => { void load(); }, 500);
}
type Effects = {
    applyTheme: typeof import("../settings/controller.ts").applyTheme;
    formatTimerTime: typeof import("../timers/controller.ts").formatTimerTime;
    preserveTimerFocus: typeof import("../timers/controller.ts").preserveTimerFocus;
    timerCard: typeof import("../timers/controller.ts").timerCard;
};
let effects: Effects;
export function configureOverlay(callbacks: Effects): void { effects = callbacks; }
