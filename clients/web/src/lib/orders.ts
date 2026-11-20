// Orders (standing orders and scheduled transfers) in the web client.

import { fromIsoDate, recurrenceLabel, type Order } from "@mbm/shared";
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
