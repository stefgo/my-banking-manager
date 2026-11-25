// When standing orders run. The bank holds the rule (every n months or weeks, on a day); the
// dates are worked out here, the same way for server and clients. They are a forecast: a bank
// may treat single dates differently.

import { ISO_DATE } from "./dates.js";

export interface Recurrence {
    unit: "month" | "week";
    /** Every n months or weeks. */
    every: number;
    /** Month: 1–30, or 97, 98, 99 for two days before, one day before and the last day. Week: 1 (Monday) – 7. */
    executionDay: number;
    firstDate: string;
    lastDate: string | null;
}

const DAY = 86_400_000;
const toMs = (iso: string): number => {
    const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
};
const toIso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Easter Sunday (Gregorian calendar, anonymous algorithm). */
function easter(year: number): number {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(year, month - 1, day);
}

/** A day on which payments are executed: Monday to Friday, except the TARGET holidays. */
export function isBankingDay(iso: string): boolean {
    const ms = toMs(iso);
    const weekday = new Date(ms).getUTCDay();
    if (weekday === 0 || weekday === 6) return false;
    const md = iso.slice(5);
    if (md === "01-01" || md === "05-01" || md === "12-25" || md === "12-26") return false;
    const e = easter(Number(iso.slice(0, 4)));
    // Good Friday and Easter Monday
    return ms !== e - 2 * DAY && ms !== e + DAY;
}

/** The day itself if it is a banking day, else the next one (or, going back, the one before). */
export function toBankingDay(iso: string, direction: 1 | -1 = 1): string {
    let ms = toMs(iso);
    while (!isBankingDay(toIso(ms))) ms += direction * DAY;
    return toIso(ms);
}

const isUltimo = (r: Recurrence): boolean => r.unit === "month" && r.executionDay >= 97;

/** The day of a month an order with `executionDay` falls on. */
function dayInMonth(year: number, month0: number, executionDay: number): number {
    const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
    if (executionDay >= 97) return Math.max(1, last - (99 - executionDay));
    return Math.min(executionDay, last);
}

/** Upper bound of dates worked out for one order, against rules that never end. */
const MAX_DATES = 1000;

/**
 * The dates between `from` and `to` (both included) on which a standing order runs. A date that
 * is no banking day moves to the next one; orders at the end of a month move back instead, so
 * that they stay in their month.
 */
export function standingOrderDates(r: Recurrence, from: string, to: string): string[] {
    if (![r.firstDate, from, to].every((d) => ISO_DATE.test(d)) || r.every < 1 || from > to) return [];
    const out: string[] = [];
    const shift = (planned: string) => toBankingDay(planned, isUltimo(r) ? -1 : 1);
    const take = (planned: string): boolean => {
        if (r.lastDate && planned > r.lastDate) return false;
        const actual = shift(planned);
        if (actual > to) return false;
        if (actual >= from) out.push(actual);
        return out.length < MAX_DATES;
    };

    if (r.unit === "week") {
        const first = toMs(r.firstDate);
        // 1 = Monday … 7 = Sunday; getUTCDay: 0 = Sunday
        const offset = (((r.executionDay % 7) - new Date(first).getUTCDay()) % 7 + 7) % 7;
        const step = 7 * r.every * DAY;
        let ms = first + offset * DAY;
        // Skip ahead to just before `from` (a moved date is at most a few days late)
        const start = toMs(from) - 7 * DAY;
        if (ms < start) ms += Math.floor((start - ms) / step) * step;
        while (take(toIso(ms))) ms += step;
        return out;
    }

    let [year, month0] = [Number(r.firstDate.slice(0, 4)), Number(r.firstDate.slice(5, 7)) - 1];
    const planned = () => toIso(Date.UTC(year, month0, dayInMonth(year, month0, r.executionDay)));
    // The first run is the first matching day on or after the first date
    if (planned() < r.firstDate) month0 += 1;
    // Skip ahead to the month before `from`, keeping the rhythm
    const behind = (Number(from.slice(0, 4)) - year) * 12 + (Number(from.slice(5, 7)) - 1 - month0) - 1;
    if (behind > 0) month0 += Math.floor(behind / r.every) * r.every;
    for (;;) {
        year += Math.floor(month0 / 12);
        month0 %= 12;
        if (!take(planned())) return out;
        month0 += r.every;
    }
}

/** The next date on or after `today` on which the order runs; null if it has ended. */
export function nextStandingOrderDate(r: Recurrence, today: string): string | null {
    // Two intervals ahead cover the longest gap (a year, or 52 weeks)
    const horizon = toIso(toMs(today) + (r.unit === "month" ? r.every * 62 + 10 : r.every * 14 + 10) * DAY);
    return standingOrderDates(r, today, horizon)[0] ?? null;
}

const WEEKDAYS = ["montags", "dienstags", "mittwochs", "donnerstags", "freitags", "samstags", "sonntags"];

/** The rhythm as text: "monatlich am 1.", "vierteljährlich am Monatsende", "alle 2 Wochen freitags". */
export function recurrenceLabel(r: Pick<Recurrence, "unit" | "every" | "executionDay">): string {
    if (r.unit === "week") {
        const day = WEEKDAYS[(r.executionDay + 6) % 7] ?? "";
        return `${r.every === 1 ? "wöchentlich" : `alle ${r.every} Wochen`} ${day}`.trim();
    }
    const every = r.every === 1 ? "monatlich" : r.every === 3 ? "vierteljährlich" : r.every === 6 ? "halbjährlich" : r.every === 12 ? "jährlich" : `alle ${r.every} Monate`;
    const day =
        r.executionDay === 99 ? "am Monatsende" : r.executionDay === 98 ? "am vorletzten Tag des Monats" : r.executionDay === 97 ? "am drittletzten Tag des Monats" : `am ${r.executionDay}.`;
    return `${every} ${day}`;
}

// ---------- Rules for writing orders ----------

/** The bank's lead times and rhythms, as the connector reports them (see schemas/connector.ts). */
export interface LeadTime {
    minDays: number;
    maxDays: number;
}
export interface RhythmRules extends LeadTime {
    months: number[];
    monthDays: number[];
    weeks: number[];
    weekDays: number[];
}
export interface ChangeableParts {
    payeeAccount: boolean;
    payeeName: boolean;
    amount: boolean;
    remittance: boolean;
    firstDate: boolean;
    unit: boolean;
    every: boolean;
    executionDay: boolean;
    lastDate: boolean;
}

const addDays = (iso: string, days: number): string => toIso(toMs(iso) + days * DAY);
const de = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * The earliest and latest date an order may be given for. Lead times count calendar days (Data
 * Dictionary „Minimale Vorlaufzeit“); MBM never asks for today, even where the bank's minimum is 0.
 */
export function orderDateRange(rules: LeadTime, today: string): { earliest: string; latest: string } {
    return { earliest: addDays(today, Math.max(rules.minDays, 1)), latest: addDays(today, rules.maxDays) };
}

function rangeProblem(rules: LeadTime, date: string, today: string, what: string): string | null {
    if (!ISO_DATE.test(date)) return `${what}: kein gültiges Datum.`;
    const { earliest, latest } = orderDateRange(rules, today);
    if (date < earliest) return `${what}: frühestens am ${de(earliest)}.`;
    if (date > latest) return `${what}: höchstens bis ${de(latest)}.`;
    return null;
}

/** Why the bank would refuse this date for a scheduled transfer; null if it fits. */
export function scheduledDateProblem(rules: LeadTime, date: string, today: string): string | null {
    return rangeProblem(rules, date, today, "Ausführung");
}

/** Whether a standing order with this rhythm would run on `date` (before moving to a banking day). */
export function isPlannedRun(r: Pick<Recurrence, "unit" | "executionDay">, date: string): boolean {
    if (!ISO_DATE.test(date)) return false;
    if (r.unit === "week") return ((new Date(toMs(date)).getUTCDay() + 6) % 7) + 1 === r.executionDay;
    return Number(date.slice(8, 10)) === dayInMonth(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, r.executionDay);
}

/** The first day on or after `from` on which an order with this rhythm would run. */
export function firstRunFrom(r: Pick<Recurrence, "unit" | "executionDay">, from: string): string {
    let d = from;
    for (let i = 0; i < 62 && !isPlannedRun(r, d); i++) d = addDays(d, 1);
    return d;
}

/** Why the bank would refuse this rhythm or these dates for a standing order; null if they fit. */
export function standingOrderProblem(rules: RhythmRules, r: Recurrence, today: string, opts: { firstDateFixed?: boolean } = {}): string | null {
    const everyOk = r.unit === "month" ? rules.months.includes(r.every) : rules.weeks.includes(r.every);
    if (!everyOk) return r.unit === "week" && rules.weeks.length === 0 ? "Wöchentliche Daueraufträge bietet die Bank nicht an." : "Diesen Turnus bietet die Bank nicht an.";
    const dayOk = r.unit === "month" ? rules.monthDays.includes(r.executionDay) : rules.weekDays.includes(r.executionDay);
    if (!dayOk) return "An diesem Ausführungstag führt die Bank keine Daueraufträge aus.";
    if (!opts.firstDateFixed) {
        const range = rangeProblem(rules, r.firstDate, today, "Erste Ausführung");
        if (range) return range;
        if (!isPlannedRun(r, r.firstDate)) return "Erste Ausführung: Das Datum passt nicht zum Ausführungstag.";
    }
    if (r.lastDate !== null) {
        if (!ISO_DATE.test(r.lastDate)) return "Letzte Ausführung: kein gültiges Datum.";
        if (r.lastDate < r.firstDate) return "Die letzte Ausführung liegt vor der ersten.";
        if (r.lastDate < addDays(today, 1)) return "Die letzte Ausführung muss in der Zukunft liegen.";
    }
    return null;
}

/** The parts of a standing order that a change touches, with their German names. */
export function changedParts(before: OrderParts & Recurrence, after: OrderParts & Recurrence): { key: keyof ChangeableParts; label: string }[] {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const parts: { key: keyof ChangeableParts; label: string; changed: boolean }[] = [
        { key: "payeeAccount", label: "IBAN/BIC", changed: before.payeeIban !== after.payeeIban || (after.payeeBic !== null && before.payeeBic !== after.payeeBic) },
        { key: "payeeName", label: "Empfänger", changed: norm(before.payeeName) !== norm(after.payeeName) },
        { key: "amount", label: "Betrag", changed: before.amount !== after.amount },
        { key: "remittance", label: "Verwendungszweck", changed: norm(before.remittance) !== norm(after.remittance) },
        { key: "firstDate", label: "erste Ausführung", changed: before.firstDate !== after.firstDate },
        { key: "unit", label: "Zeiteinheit", changed: before.unit !== after.unit },
        { key: "every", label: "Turnus", changed: before.every !== after.every },
        { key: "executionDay", label: "Ausführungstag", changed: before.executionDay !== after.executionDay },
        { key: "lastDate", label: "letzte Ausführung", changed: before.lastDate !== after.lastDate },
    ];
    return parts.filter((p) => p.changed).map(({ key, label }) => ({ key, label }));
}

export interface OrderParts {
    payeeName: string;
    payeeIban: string;
    payeeBic: string | null;
    amount: number;
    remittance: string;
}

/** Why the bank would refuse this change of a standing order; null if it fits. */
export function standingChangeProblem(rules: RhythmRules & { changeable: ChangeableParts }, before: OrderParts & Recurrence, after: OrderParts & Recurrence, today: string): string | null {
    const changed = changedParts(before, after);
    if (changed.length === 0) return "Es ist nichts geändert.";
    const locked = changed.filter((c) => !rules.changeable[c.key]);
    if (locked.length > 0) return `Die Bank erlaubt nicht, ${locked.map((c) => c.label).join(", ")} zu ändern.`;
    return standingOrderProblem(rules, after, today, { firstDateFixed: after.firstDate === before.firstDate });
}
