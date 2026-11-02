import { type View } from "../shared/types.ts";
import { appState } from "./state.ts";
export function bindNavigationEvents(scope: ParentNode): void {
    scope.querySelectorAll<HTMLAnchorElement>("[data-view]").forEach((link) => {
        link.addEventListener("click", (event) => {
            event.preventDefault();
            const nextView = link.dataset.view as View | undefined;
            if (!nextView || nextView === appState.activeView)
                return;
            appState.activeView = nextView;
            window.history.pushState(null, "", `#${appState.activeView}`);
            effects.render(true);
            if (appState.activeView === "history")
                void effects.refreshHistory();
            if (appState.activeView === "timers")
                void effects.refreshTimers();
        });
    });
}
type Effects = {
    render: typeof import("./view.ts").render;
    refreshHistory: typeof import("../features/history/controller.ts").refreshHistory;
    refreshTimers: typeof import("../features/timers/controller.ts").refreshTimers;
};
let effects: Effects;
export function configureNavigation(callbacks: Effects): void { effects = callbacks; }
