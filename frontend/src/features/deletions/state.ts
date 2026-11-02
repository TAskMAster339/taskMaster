import { type UndoDeletion } from "../../shared/types.ts";
export const deletionsState: {
    purgeOpening: boolean;
    deletionUndos: UndoDeletion[];
    undoMessage: string;
    undoRenderKey: string;
    undoExpiryTimer: number | null;
    clearingData: boolean;
} = {
    purgeOpening: false,
    deletionUndos: [],
    undoMessage: "",
    undoRenderKey: "",
    undoExpiryTimer: null,
    clearingData: false,
};
