// Pure: the rows of the transaction list and the order the keyboard walks through.

import type { Transaction } from "@mbm/shared";
import { dayLabel } from "../lib/format";

export type ListRow = { type: "head"; key: string; label: string; sum: number; balance?: number; booked: boolean } | { type: "tx"; key: string; tx: Transaction; idx: number; inPending: boolean };

/** Pure: rows of headers and bookings in display order; `balances` gives a day its balance at the end of the day. */
export function buildRows(items: Transaction[], balances?: ReadonlyMap<string, number>): ListRow[] {
    const pending = items.filter((t) => t.status === "pending");
    const booked = items.filter((t) => t.status !== "pending");
    const rows: ListRow[] = [];
    let idx = 0;
    if (pending.length) {
        rows.push({ type: "head", key: "h-pending", label: "Vorgemerkt", sum: pending.reduce((s, t) => s + t.amount, 0), booked: false });
        for (const tx of pending) rows.push({ type: "tx", key: `t${tx.id}`, tx, idx: idx++, inPending: true });
    }
    const sums = new Map<string, number>();
    for (const t of booked) sums.set(t.bookingDate, (sums.get(t.bookingDate) ?? 0) + t.amount);
    let cur: string | null = null;
    for (const tx of booked) {
        if (tx.bookingDate !== cur) {
            rows.push({ type: "head", key: `h${tx.bookingDate}`, label: dayLabel(tx.bookingDate), sum: sums.get(tx.bookingDate) ?? 0, balance: balances?.get(tx.bookingDate), booked: cur === null && pending.length > 0 });
            cur = tx.bookingDate;
        }
        rows.push({ type: "tx", key: `t${tx.id}`, tx, idx: idx++, inPending: false });
    }
    return rows;
}

/**
 * Pure: index of the head of the newest booked day on or before `to`, where a period ending on `to`
 * starts in the newest-first list. A period older than every booking gets the oldest day, the end
 * of the list; -1 without booked days. Pending bookings never count.
 */
export function dayRowAtOrBefore(rows: readonly ListRow[], to: string): number {
    let oldest = -1;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.type !== "head" || r.key === "h-pending") continue;
        if (r.key.slice(1) <= to) return i;
        oldest = i;
    }
    return oldest;
}

/** Bookings in the order of the list (pending first), for keyboard navigation. */
export const listOrder = (items: Transaction[]): Transaction[] => [...items.filter((t) => t.status === "pending"), ...items.filter((t) => t.status !== "pending")];

