import { routes, type Transaction } from "@mbm/shared";
import { call } from "./api";
import { fmtSigned, shownParty, shownPurpose } from "./format";
import type { useAction } from "./queries";
import { getUi, ui } from "./ui";

type Action = ReturnType<typeof useAction>;

/** Only a deleted booking from an import can go for good; in a PayPal account the server refuses it. */
export const canPurge = (tx: Transaction): boolean => tx.deletedAt !== null && tx.source === "import";

/** Brings a deleted booking back; its details, if open, close, since they showed it as deleted. */
export async function restoreTx(tx: Transaction, action: Action): Promise<void> {
    const ok = await action.succeeds(() => call(routes.restoreTransaction, { params: { id: tx.id } }), { topics: ["accounts", "transactions", "categories"], ok: "Umsatz wiederhergestellt" });
    if (ok && getUi().drawerTx === tx.id) ui.openTx(null);
}

/** Asks before a deleted booking from an import goes for good; `done` runs once it is gone. */
export function confirmPurge(tx: Transaction, action: Action, done?: () => void): void {
    const name = shownParty(tx) || shownPurpose(tx) || "Umsatz";
    ui.confirm({
        title: `Umsatz „${name}“ endgültig löschen?`,
        text: `Der Umsatz über ${fmtSigned(tx.amount)} wird endgültig gelöscht und lässt sich nicht mehr wiederherstellen. Importierst du eine Datei, die ihn enthält, noch einmal, oder liefert ihn die Bank bei einem Abruf, kommt er als neuer Umsatz wieder.`,
        confirm: "Endgültig löschen",
        danger: true,
        onConfirm: async () => {
            const ok = await action.succeeds(() => call(routes.purgeTransaction, { params: { id: tx.id } }), { topics: ["transactions", "imports"], ok: "Umsatz endgültig gelöscht" });
            if (ok) done?.();
            return ok;
        },
    });
}
