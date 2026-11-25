// Orders (standing orders and scheduled transfers) in the web client.

import { fromIsoDate, recurrenceLabel, type Order, type OrderAccount, type OrderSnapshot } from "@mbm/shared";
import { dateText } from "./format";

/** Standing orders and scheduled transfers have separate ids; this names one of either. */
export const orderKey = (o: { kind: "standing" | "scheduled"; id: number }): string => `${o.kind}:${o.id}`;
export const upcomingKey = (i: { kind: "standing" | "scheduled"; orderId: number }): string => `${i.kind}:${i.orderId}`;

/** "monatlich am 1." for a standing order, "einmalig am 05.12.2026" for a scheduled transfer. */
export const orderRhythm = (o: Order): string => (o.kind === "standing" ? recurrenceLabel(o) : `einmalig am ${dateText(o.executionDate)}`);

const fMonth = new Intl.DateTimeFormat("de-DE", { month: "short" });

/** Day and short month of a date, for the date chip: ["01", "Dez"]. */
export function chipDate(iso: string): [string, string] {
    const d = fromIsoDate(iso);
    return [String(d.getDate()).padStart(2, "0"), fMonth.format(d).replace(".", "")];
}

/** An order as the transfer dialog takes it to change or delete it. */
export const snapshotOfOrder = (o: Order): OrderSnapshot => ({
    bankOrderId: o.bankOrderId ?? "",
    payeeName: o.payeeName,
    payeeIban: o.payeeIban,
    payeeBic: o.payeeBic,
    amount: o.amount,
    remittance: o.remittance,
    executionDate: o.kind === "scheduled" ? o.executionDate : null,
    recurrence: o.kind === "standing" ? { firstDate: o.firstDate, unit: o.unit, every: o.every, executionDay: o.executionDay, lastDate: o.lastDate } : null,
});

/**
 * Whether the user may change or delete the order through MBM: an own login whose bank offers it
 * for the account, an order identification, the bank does not forbid it, and the order still runs.
 */
export function orderWrites(o: Order, a: OrderAccount | undefined): { change: boolean; remove: boolean } {
    if (!a || !o.bankOrderId || o.nextDate === null) return { change: false, remove: false };
    const standing = o.kind === "standing";
    return {
        change: o.canChange !== false && (standing ? a.changeStanding : a.changeScheduled),
        remove: o.canDelete !== false && (standing ? a.deleteStanding : a.deleteScheduled),
    };
}
