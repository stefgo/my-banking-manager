import { toIsoDate } from "@mbm/shared";
import { dayMonth, monthYearLong, monthYearShort, quarterLabel, shortDate, yearLabel } from "./format";

/** How the balance chart groups the daily balances. */
export const SERIES_GROUP_IDS = ["day", "month", "quarter", "year"] as const;
export type SeriesGroup = (typeof SERIES_GROUP_IDS)[number];

/** How the grouped balance chart draws its values, with the name of each choice. */
export const CHART_STYLE_IDS = ["bar", "line", "flow"] as const;
export type ChartStyle = (typeof CHART_STYLE_IDS)[number];
export const CHART_STYLES: Record<ChartStyle, string> = { bar: "Balken", line: "Linie", flow: "Eingänge und Ausgaben" };

/**
 * Name, short name for the switch and axis label of each grouping. On the axis a value gets `labelSlot` px when every
 * value carries its label, `slot` px when only the values picked by `mark` do; without `mark` every value is named.
 */
export const SERIES_GROUPS: Record<
    SeriesGroup,
    { label: string; short: string; slot: number; labelSlot: number; mark?: (iso: string) => boolean; tick: (iso: string) => string }
> = {
    day: { label: "Tag", short: "T", slot: 14, labelSlot: 48, mark: (iso) => iso.endsWith("-01") || iso.endsWith("-15"), tick: shortDate },
    month: { label: "Monat", short: "M", slot: 20, labelSlot: 44, mark: (iso) => ["01", "04", "07", "10"].includes(iso.slice(5, 7)), tick: monthYearShort },
    quarter: { label: "Quartal", short: "Q", slot: 24, labelSlot: 48, mark: (iso) => iso.slice(5, 7) === "01", tick: quarterLabel },
    year: { label: "Jahr", short: "J", slot: 36, labelSlot: 36, tick: yearLabel },
};

/**
 * Room per value on the axis (`slot`), room left at each end for a label there (`edge`) and the axis label per value.
 * When a picked value lies in the range only those carry a label (`sparse`); otherwise every value does, with room for it.
 */
export function axisLayout(group: SeriesGroup, dates: readonly string[]): { slot: number; edge: number; sparse: boolean; tick: (iso: string) => string } {
    const { slot, labelSlot, mark, tick } = SERIES_GROUPS[group];
    if (!mark || !dates.some(mark)) return { slot: labelSlot, edge: 0, sparse: false, tick };
    return { slot, edge: Math.max(0, (labelSlot - slot) / 2), sparse: true, tick: (iso) => (mark(iso) ? tick(iso) : "") };
}

/** One value of a grouped series: `date` is the first day of the period, `from`/`to` the days it covers. */
export type GroupPoint = { date: string; from: string; to: string; partial: boolean; balance: number };

/** First and last day of the period of `group` that holds `iso`. */
export function periodOf(iso: string, group: Exclude<SeriesGroup, "day">): { start: string; end: string } {
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7)) - 1;
    const first = group === "month" ? m : group === "quarter" ? Math.floor(m / 3) * 3 : 0;
    const months = group === "month" ? 1 : group === "quarter" ? 3 : 12;
    return { start: toIsoDate(new Date(y, first, 1)), end: toIsoDate(new Date(y, first + months, 0)) };
}

/** Average of the daily balances per month, quarter or year (rounded to cents); periods cut by the series are marked partial. */
export function groupSeries(points: readonly { date: string; balance: number }[], group: Exclude<SeriesGroup, "day">): GroupPoint[] {
    const out: GroupPoint[] = [];
    let cur: { start: string; end: string; from: string; to: string; sum: number; n: number } | undefined;
    const flush = () => {
        if (!cur) return;
        out.push({ date: cur.start, from: cur.from, to: cur.to, partial: cur.from !== cur.start || cur.to !== cur.end, balance: Math.round(cur.sum / cur.n) });
    };
    for (const p of points) {
        if (!cur || p.date > cur.end) {
            flush();
            cur = { ...periodOf(p.date, group), from: p.date, to: p.date, sum: 0, n: 0 };
        }
        cur.to = p.date;
        cur.sum += p.balance;
        cur.n++;
    }
    flush();
    return out;
}

/** One value of the income and expenses per period: the sums of its days and their total (`net`). */
export type FlowGroupPoint = Omit<GroupPoint, "balance"> & { income: number; expenses: number; net: number };

/** Sums of income and expenses per day, month, quarter or year; periods cut by the series are marked partial. */
export function groupFlows(points: readonly { date: string; income: number; expenses: number }[], group: SeriesGroup): FlowGroupPoint[] {
    if (group === "day") return points.map((p) => ({ date: p.date, from: p.date, to: p.date, partial: false, income: p.income, expenses: p.expenses, net: p.income + p.expenses }));
    const out: FlowGroupPoint[] = [];
    let cur: (FlowGroupPoint & { end: string }) | undefined;
    const flush = () => {
        if (!cur) return;
        const { end, ...point } = cur;
        out.push({ ...point, partial: point.from !== point.date || point.to !== end, net: point.income + point.expenses });
    };
    for (const p of points) {
        if (!cur || p.date > cur.end) {
            flush();
            const { start, end } = periodOf(p.date, group);
            cur = { date: start, end, from: p.date, to: p.date, partial: false, income: 0, expenses: 0, net: 0 };
        }
        cur.to = p.date;
        cur.income += p.income;
        cur.expenses += p.expenses;
    }
    flush();
    return out;
}

/** Total of income and expenses per day, month, quarter or year as the value of a grouped series (the sum of a category). */
export function groupSums(points: readonly { date: string; income: number; expenses: number }[], group: SeriesGroup): GroupPoint[] {
    return groupFlows(points, group).map(({ date, from, to, partial, net }) => ({ date, from, to, partial, balance: net }));
}

/** Name of a period for the tooltip: "November 2026", with the days when the period is cut. */
export function periodLabel(p: { date: string; from: string; to: string; partial: boolean }, group: Exclude<SeriesGroup, "day">): string {
    const name = group === "month" ? monthYearLong(p.date) : group === "quarter" ? quarterLabel(p.date) : yearLabel(p.date);
    if (!p.partial) return name;
    const days = p.from === p.to ? dateOnly(p.from) : `${dayMonth(p.from)}–${dateOnly(p.to)}`;
    return `${name} (${days})`;
}

/** Name of a grouped value for the tooltip: "Ø November 2026", with the days when the period is cut. */
export function groupPointLabel(p: GroupPoint, group: Exclude<SeriesGroup, "day">): string {
    return `Ø ${periodLabel(p, group)}`;
}

const dateOnly = (iso: string) => `${dayMonth(iso)}${iso.slice(0, 4)}`;

/** Evenly spaced axis values in whole euros around `min`..`max` (cents): the domain and its ticks. */
export function niceScale(min: number, max: number, count = 5): { domain: [number, number]; ticks: number[] } {
    if (min > max) [min, max] = [max, min];
    if (min === max) {
        const pad = Math.max(Math.abs(max) * 0.05, 100);
        min -= pad;
        max += pad;
    }
    const rough = (max - min) / Math.max(1, count - 1);
    const mag = 10 ** Math.floor(Math.log10(rough));
    const norm = rough / mag;
    // At least one euro per step: the axis shows whole euros
    const step = Math.max(100, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let i = 0; lo + i * step <= hi + step / 2; i++) ticks.push(Math.round(lo + i * step));
    return { domain: [Math.round(lo), Math.round(hi)], ticks };
}
