// The period of the transaction list as a condition in the search text ("datum>=1.3.2026
// datum<=31.3.2026"). The search text lives in memory only, so a chosen period never reaches the
// URL or the browser history.

const OPS = "UND|AND|ODER|OR";
const DATE_TERM = /(^|[\s(])(?:(?:NICHT|NOT)\s+)?datum(?::|>=|<=|>|<|=)[^\s()]+/g;

/** The search text without its date conditions, and without operators left dangling by that. */
export function withoutDate(q: string): string {
    let s = q.replace(DATE_TERM, "$1");
    let before: string;
    do {
        before = s;
        s = s
            .replace(/\(\s*\)/g, " ")
            .replace(new RegExp(`\\b(${OPS})\\s+(?=(${OPS})\\b)`, "g"), "")
            .replace(new RegExp(`(\\(\\s*)(${OPS})\\s+`, "g"), "$1")
            .replace(new RegExp(`\\s+(${OPS})(\\s*\\))`, "g"), "$2")
            .replace(new RegExp(`^\\s*(${OPS})\\s+`), "")
            .replace(new RegExp(`\\s+(${OPS})\\s*$`), "")
            .replace(/\s+/g, " ")
            .replace(/\(\s+/g, "(")
            .replace(/\s+\)/g, ")")
            .trim();
    } while (s !== before);
    return s;
}

/** "2026-03-01" → "1.3.2026", the form the search syntax reads. */
export function searchDate(iso: string): string {
    const [y, m, d] = iso.split("-").map(Number);
    return `${d}.${m}.${y}`;
}

/** The search text with the period `from`–`to` (ISO dates, both included) in place of its date conditions. */
export function withDateRange(q: string, from: string, to: string): string {
    return `${withoutDate(q)} datum>=${searchDate(from)} datum<=${searchDate(to)}`.trim();
}
