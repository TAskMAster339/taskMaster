import { type Timer } from "../../shared/types.ts";
export const timersState: {
    timers: Timer[];
    timerAnimationFrame: number | null;
    timerDialogOpen: boolean;
    timerError: string;
    fullscreenTimerId: string | null;
} = {
    timers: [],
    timerAnimationFrame: null,
    timerDialogOpen: false,
    timerError: "",
    fullscreenTimerId: null,
};
