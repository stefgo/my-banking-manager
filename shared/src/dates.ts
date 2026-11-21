// Booking dates are calendar days ("YYYY-MM-DD") without a time zone.

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string): boolean {
    if (!ISO_DATE.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Today in local time as "YYYY-MM-DD". */
export function todayIso(now = new Date()): string {
    return toIsoDate(now);
}

export function toIsoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fromIsoDate(s: string): Date {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d);
}

export function addDaysIso(s: string, days: number): string {
    const d = fromIsoDate(s);
    d.setDate(d.getDate() + days);
    return toIsoDate(d);
}

/**
 * Reads a date as banks write it into CSV files: "31.12.2026", "31.12.26", "2026-12-31",
 * "12/31/2026" is not accepted (ambiguous). Returns "YYYY-MM-DD" or null.
 */
export function parseDate(input: string, order: DateOrder = "auto"): string | null {
    const s = input.trim();
    if (order !== "auto") return parseOrdered(s, order);
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
    if (m) return normalize(Number(m[1]), Number(m[2]), Number(m[3]));
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(s);
    if (m) {
        let year = Number(m[3]);
        if (m[3]!.length === 2) year += year < 70 ? 2000 : 1900;
        return normalize(year, Number(m[2]), Number(m[1]));
    }
    return null;
}

/** Order of day, month and year in a date; "auto" takes the forms banks use in Germany. */
export type DateOrder = "auto" | "dmy" | "mdy" | "ymd";

function parseOrdered(s: string, order: Exclude<DateOrder, "auto">): string | null {
    const m = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})(?:[T ].*)?$/.exec(s);
    if (!m) return null;
    const [first, second, third] = [m[1]!, m[2]!, m[3]!];
    const [yearText, month, day] = order === "ymd" ? [first, second, third] : order === "dmy" ? [third, second, first] : [third, first, second];
    if (yearText.length !== 2 && yearText.length !== 4) return null;
    if (month.length > 2 || day.length > 2) return null;
    const year = yearText.length === 2 ? Number(yearText) + (Number(yearText) < 70 ? 2000 : 1900) : Number(yearText);
    return normalize(year, Number(month), Number(day));
}

function normalize(y: number, mo: number, d: number): string | null {
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return isValidIsoDate(iso) ? iso : null;
}
