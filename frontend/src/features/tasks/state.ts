import { type Task } from "../../shared/types.ts";
export const tasksState: {
    tasks: Task[];
    loading: boolean;
    saving: boolean;
    errorMessage: string;
    loadFailed: boolean;
    editingTaskId: string | null;
    mouseDragActive: boolean;
    taskPointerHeld: boolean;
    cancelListAppend: () => void;
    pendingTaskFocusId: string | null;
} = {
    tasks: [],
    loading: true,
    saving: false,
    errorMessage: "",
    loadFailed: false,
    editingTaskId: null,
    mouseDragActive: false,
    taskPointerHeld: false,
    cancelListAppend: () => { },
    pendingTaskFocusId: null,
};
