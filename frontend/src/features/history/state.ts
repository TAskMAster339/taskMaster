import { monthStart, parseLocalDate, toLocalDateString, yesterday } from "../../shared/dates.ts";
import { type HistoryDay } from "../../shared/types.ts";
export const historyState: {
    historyDay: HistoryDay;
    createdTaskDays: Set<string>;
    historyLoading: boolean;
    selectedHistoryDate: string;
    calendarMonth: Date;
} = {
    historyDay: { completed: [], archived: [] },
    createdTaskDays: new Set<string>(),
    historyLoading: false,
    selectedHistoryDate: toLocalDateString(yesterday),
    calendarMonth: monthStart(parseLocalDate(toLocalDateString(yesterday))),
};
