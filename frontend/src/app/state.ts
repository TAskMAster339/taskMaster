import { type View } from "../shared/types.ts";
export const appState: {
    activeView: View;
} = {
    activeView: window.location.hash === "#settings" ? "settings" : window.location.hash === "#completed" ? "completed" : window.location.hash === "#history" ? "history" : window.location.hash === "#timers" ? "timers" : "today",
};
