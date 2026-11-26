// State of the interface that is no server data: open dialogs, the selected rows, toasts.
// Kept in memory only; nothing goes to browser storage.

import { useSyncExternalStore } from "react";
import type { ConnectorRecurrence, OrderSnapshot, TransferExecution } from "@mbm/shared";
import type { InfoTarget } from "./info";

export type Dialog =
    | { kind: "booking"; accountId?: number; txId?: number }
    | { kind: "reconcile"; accountId: number }
    | { kind: "counterBooking"; txId: number }
    /** `offline`: straight to the offline account form, without the choice of kind. */
    | { kind: "addAccount"; offline?: boolean }
    | { kind: "bankSetup"; connectionId?: number; start?: "accounts" }
    /** PSD2 through Enable Banking: new access, own login at an access, new approval, or new application. */
    | { kind: "psd2Setup"; connectionId?: number; mode?: "consent" | "credentials" }
    | { kind: "detachAccount"; accountId: number }
    | { kind: "sync" }
    | { kind: "openingBalance"; accountId: number }
    | { kind: "help" }
    | { kind: "settings" }
    | { kind: "palette" }
    | { kind: "cardSettings"; cardId: number }
    | { kind: "addCard" }
    | { kind: "info"; target: InfoTarget; id: number }
    /**
     * A step confirmed with the code from the authenticator app or the password: `run` gets the
     * entry. A failure shows at the field and the dialog stays open; `onDone` runs once it worked.
     */
    | {
          kind: "confirmSecret";
          secret: "code" | "password";
          title: string;
          text: string;
          confirm: string;
          danger?: boolean;
          run: (secret: string) => Promise<unknown>;
          onDone?: () => void;
      }
    | {
          kind: "confirm";
          title: string;
          text: string;
          confirm: string;
          danger?: boolean;
          /** False when it failed: the dialog then stays open. */
          onConfirm: () => Promise<boolean | void> | boolean | void;
          /** Called when the dialog is closed without confirming. */
          onCancel?: () => void;
      };

/**
 * What the transfer form starts with (from the history, a booking or a payee). Bank data, so it
 * goes through memory only and never into the URL, where the browser history would keep it.
 */
/** An order to change or delete, as it was when the user picked it. */
export interface OrderRef {
    kind: "standing" | "scheduled";
    orderId: number;
    previous: OrderSnapshot;
    /** Its next run; a deletion within the bank's lead time may come too late for it. */
    nextDate: string | null;
}

export interface TransferDraft {
    accountId?: number;
    payeeName?: string;
    payeeIban?: string;
    payeeBic?: string | null;
    amount?: number;
    remittance?: string;
    instant?: boolean;
    /** Open at the check step (e.g. after taking over the name the payee's bank holds). */
    review?: boolean;
    /** Now (default), on a date, or as a standing order. */
    execution?: TransferExecution;
    executionDate?: string | null;
    recurrence?: ConnectorRecurrence | null;
    /** Change an order: the form starts with it, and sends the complete changed order. */
    change?: OrderRef;
    /** Delete an order: the dialog shows it and asks to confirm. */
    remove?: OrderRef;
    /** Show this transfer (e.g. one just started elsewhere) instead of a form. */
    runId?: number;
    /** Set by `prefillTransfer`: a new draft starts the form afresh. */
    seq?: number;
}

export interface Toast {
    id: number;
    text: string;
    tone: "ok" | "error" | "info";
}

interface UiState {
    privacy: boolean;
    dialog: Dialog | null;
    drawerTx: number | null;
    /** Order whose details are open on the orders page, as "standing:<id>" or "scheduled:<id>". */
    drawerOrder: string | null;
    /** Transfer whose details are open on the transfer page. */
    drawerTransfer: number | null;
    /** Taken by the transfer form when it opens. */
    transferDraft: TransferDraft | null;
    /** The transfer dialog on the transfer page is open. */
    transferForm: boolean;
    picked: ReadonlySet<number>;
    toasts: Toast[];
    editing: { acc: boolean; cat: boolean };
    cardsEditing: boolean;
    /** Tree node being renamed inline, e.g. "group:3" or "category:12". */
    renaming: string | null;
    /**
     * Search text of the transaction view. It often holds bank data (counterparty, amount, IBAN),
     * so it lives here and never in the URL, where the browser history would keep it on disk.
     */
    search: string;
}

let state: UiState = {
    privacy: false,
    dialog: null,
    drawerTx: null,
    drawerOrder: null,
    drawerTransfer: null,
    transferDraft: null,
    transferForm: false,
    picked: new Set(),
    toasts: [],
    editing: { acc: false, cat: false },
    cardsEditing: false,
    renaming: null,
    search: "",
};

/** Longest search text kept. */
export const MAX_SEARCH = 200;

const subs = new Set<() => void>();

const TOAST_MS = 3200;
const MAX_TOASTS = 4;
const MAX_ERRORS = 3;

/** Remaining time per message; paused ones have no handle. */
const timers = new Map<number, { left: number; started: number; handle?: ReturnType<typeof setTimeout> }>();

function startTimer(id: number, ms: number): void {
    timers.set(id, { left: ms, started: Date.now(), handle: setTimeout(() => ui.dismissToast(id), ms) });
}

function stopTimer(id: number): void {
    const t = timers.get(id);
    if (t?.handle) clearTimeout(t.handle);
    timers.delete(id);
}

function set(patch: Partial<UiState>): void {
    state = { ...state, ...patch };
    subs.forEach((s) => s());
}

/** The open dialog, for code outside React. */
export const currentDialog = (): Dialog | null => state.dialog;

export function useUi<T>(select: (s: UiState) => T): T {
    return useSyncExternalStore(
        (cb) => {
            subs.add(cb);
            return () => subs.delete(cb);
        },
        () => select(state),
    );
}

export const getUi = (): UiState => state;

export const ui = {
    setPrivacy(on: boolean) {
        document.documentElement.classList.toggle("private", on);
        set({ privacy: on });
    },
    togglePrivacy() {
        ui.setPrivacy(!state.privacy);
    },
    open(dialog: Dialog) {
        set({ dialog });
    },
    close() {
        set({ dialog: null });
    },
    openTx(id: number | null) {
        set({ drawerTx: id });
    },
    openOrder(key: string | null) {
        set({ drawerOrder: key });
    },
    openTransfer(id: number | null) {
        set({ drawerTransfer: id });
    },
    prefillTransfer(draft: TransferDraft | null) {
        set({ transferDraft: draft ? { ...draft, seq: Date.now() + Math.random() } : null });
    },
    /** Opens the transfer dialog with a fresh form, prefilled from `draft`; the caller goes to the transfer page. */
    newTransfer(draft: TransferDraft = {}) {
        set({ transferDraft: { ...draft, seq: Date.now() + Math.random() }, drawerTransfer: null, transferForm: true });
    },
    showTransferForm(open: boolean) {
        set({ transferForm: open });
    },
    pick(ids: Iterable<number>) {
        set({ picked: new Set(ids) });
    },
    togglePick(id: number) {
        const next = new Set(state.picked);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        set({ picked: next });
    },
    clearPick() {
        if (state.picked.size) set({ picked: new Set() });
    },
    setEditing(kind: "acc" | "cat", on: boolean) {
        set({ editing: { ...state.editing, [kind]: on } });
    },
    setRenaming(key: string | null) {
        set({ renaming: key });
    },
    setCardsEditing(on: boolean) {
        set({ cardsEditing: on });
    },
    setSearch(text: string) {
        const search = text.slice(0, MAX_SEARCH);
        if (search !== state.search) set({ search });
    },
    /** Shows a message; errors stay until closed, others go after a few seconds. */
    toast(text: string, tone: Toast["tone"] = "ok") {
        const id = Date.now() + Math.random();
        const all = [...state.toasts, { id, text, tone }];
        // At most three errors and four messages; the oldest go first
        const errors = all.filter((t) => t.tone === "error");
        const oldErrors = new Set(errors.slice(0, Math.max(0, errors.length - MAX_ERRORS)).map((t) => t.id));
        const kept = all.filter((t) => !oldErrors.has(t.id)).slice(-MAX_TOASTS);
        for (const t of all) if (!kept.includes(t)) stopTimer(t.id);
        set({ toasts: kept });
        if (tone !== "error") startTimer(id, TOAST_MS);
    },
    dismissToast(id: number) {
        stopTimer(id);
        set({ toasts: state.toasts.filter((t) => t.id !== id) });
    },
    pauseToast(id: number) {
        const t = timers.get(id);
        if (!t?.handle) return;
        clearTimeout(t.handle);
        timers.set(id, { left: t.left - (Date.now() - t.started), started: 0 });
    },
    resumeToast(id: number) {
        const t = timers.get(id);
        if (!t || t.handle) return;
        startTimer(id, Math.max(1200, t.left));
    },
    confirm(opts: Omit<Extract<Dialog, { kind: "confirm" }>, "kind">) {
        set({ dialog: { kind: "confirm", ...opts } });
    },
    confirmSecret(opts: Omit<Extract<Dialog, { kind: "confirmSecret" }>, "kind">) {
        set({ dialog: { kind: "confirmSecret", ...opts } });
    },
};
