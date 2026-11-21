import { fromIsoDate, todayIso, addDaysIso } from "@mbm/shared";

export { formatCents as fmt, formatSignedCents as fmtSigned } from "@mbm/shared";

const fDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" });
const fDayYear = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const fDM = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" });
const fShort = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" });
const fTime = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const dateText = (iso: string): string => fDate.format(fromIsoDate(iso));
export const dayMonth = (iso: string): string => fDM.format(fromIsoDate(iso));
export const shortDate = (iso: string): string => fShort.format(fromIsoDate(iso));
const fMonthYear = new Intl.DateTimeFormat("de-DE", { month: "short", year: "numeric" });
export const monthYear = (iso: string): string => fMonthYear.format(fromIsoDate(iso));
const fMonthYearShort = new Intl.DateTimeFormat("de-DE", { month: "short", year: "2-digit" });
/** "Nov. 26" (chart axis). */
export const monthYearShort = (iso: string): string => fMonthYearShort.format(fromIsoDate(iso));
const fMonthYearLong = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" });
/** "November 2026". */
export const monthYearLong = (iso: string): string => fMonthYearLong.format(fromIsoDate(iso));
/** "Q4 2026". */
export const quarterLabel = (iso: string): string => `Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1} ${iso.slice(0, 4)}`;
/** "2026". */
export const yearLabel = (iso: string): string => iso.slice(0, 4);
export const dateTime = (ts: string): string => fTime.format(new Date(ts));

/** "Heute", "Gestern", else "Montag, 10. November" (with the year when it is not this year). */
export function dayLabel(iso: string, today = todayIso()): string {
    if (iso === today) return "Heute";
    if (iso === addDaysIso(today, -1)) return "Gestern";
    const d = fromIsoDate(iso);
    return d.getFullYear() === new Date().getFullYear() ? fDay.format(d) : fDayYear.format(d);
}

/** Cents as "1.234" (whole euros, for chart axes). */
export const shortEuro = (cents: number): string =>
    (cents < 0 ? "−" : "") + new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(Math.abs(Math.round(cents / 100))) + " €";

/** Big amount with smaller decimals: ["4.812", ",37 €"]. */
export function splitAmount(cents: number): [string, string] {
    const s = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(cents) / 100);
    const at = s.lastIndexOf(",");
    return [(cents < 0 ? "−" : "") + s.slice(0, at), `${s.slice(at)} €`];
}

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Who a booking is with, as lists and titles show it: the ultimate party (e.g. the shop of a card
 * payment whose counterparty is the processing bank), else the counterparty.
 */
export const partyName = (tx: { counterpartyName: string; ultimateParty: string }): string => tx.ultimateParty || tx.counterpartyName;
