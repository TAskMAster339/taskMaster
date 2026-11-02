import { type View } from "../../shared/types.ts";
export const remindersState: {
    reminderEditingTaskId: string | null;
    reminderDialogError: string;
    reminderDraft: string;
    reminderSaving: boolean;
    reminderOpening: boolean;
    reminderReturn: {
        id: string;
        view: View;
        scrollTop: number;
        restoreFocus: boolean;
        signature: string;
    } | null;
    highlightedReminderTaskId: string | null;
} = {
    reminderEditingTaskId: null,
    reminderDialogError: "",
    reminderDraft: "",
    reminderSaving: false,
    reminderOpening: false,
    reminderReturn: null,
    highlightedReminderTaskId: null,
};
