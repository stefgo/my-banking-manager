// CSV import: reading the file, guessing which column holds what, turning rows into bookings.
// Pure functions, used by the server (preview and import) and tested on their own.

import { parseDate } from "./dates.js";
import { parseAmount } from "./money.js";
import { cleanIban } from "./iban.js";

export const IMPORT_FIELDS = ["date", "valueDate", "amount", "name", "iban", "purpose", "bookingText", "status", "category"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
    date: "Buchungstag",
    valueDate: "Wertstellung",
    amount: "Betrag",
    name: "Gegenseite",
    iban: "IBAN der Gegenseite",
    purpose: "Verwendungszweck",
    bookingText: "Umsatzart",
    status: "Status (vorgemerkt)",
    category: "Kategorie",
};

/** Column index per field; null = not in the file. */
export type ColumnMap = Record<ImportField, number | null>;

export interface CsvTable {
    delimiter: string;
    header: string[];
    rows: string[][];
}

/** Splits CSV text into rows, honouring quotes, doubled quotes and line breaks inside quotes. */
export function splitCsv(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quoted) {
            if (c === "\"") {
                if (text[i + 1] === "\"") {
                    field += "\"";
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                field += c;
            }
        } else if (c === "\"" && field === "") {
            quoted = true;
        } else if (c === delimiter) {
            row.push(field);
            field = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += c;
        }
    }
    if (field !== "" || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Picks the delimiter that splits the first lines into the most equal, widest rows. */
export function detectDelimiter(text: string): string {
    const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12).join("\n");
    let best = ";";
    let bestScore = -1;
    for (const d of [";", ",", "\t", "|"]) {
        const rows = splitCsv(sample, d);
        if (!rows.length) continue;
        const widths = rows.map((r) => r.length);
        const common = mode(widths);
        if (common < 2) continue;
        const score = widths.filter((w) => w === common).length * 100 + common;
        if (score > bestScore) {
            best = d;
            bestScore = score;
        }
    }
    return best;
}

function mode(values: number[]): number {
    const counts = new Map<number, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = 0;
    let bestN = 0;
    for (const [v, n] of counts) {
        if (n > bestN || (n === bestN && v > best)) {
            best = v;
            bestN = n;
        }
    }
    return best;
}

/** Reads a CSV file. The header is the first row as wide as most rows (skips a bank's preamble). */
export function readCsv(text: string): CsvTable {
    const clean = text.replace(/^\uFEFF/, "");
    const delimiter = detectDelimiter(clean);
    const all = splitCsv(clean, delimiter);
    const width = mode(all.map((r) => r.length));
    const headerAt = all.findIndex((r) => r.length === width);
    if (headerAt < 0) return { delimiter, header: [], rows: [] };
    const header = all[headerAt]!.map((h) => h.trim());
    const rows = all.slice(headerAt + 1).filter((r) => r.length >= Math.min(width, 2));
    return { delimiter, header, rows };
}

const norm = (s: string): string =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u").replace(/[^a-z0-9]/g, "");

// Column names of common exports (Sparkasse CSV-CAMT, MoneyMoney, DKB, ING, PayPal …), normalized
const HINTS: Record<ImportField, string[]> = {
    date: ["buchungstag", "buchungsdatum", "datum", "date", "buchung", "belegdatum", "transaktionsdatum"],
    valueDate: ["valutadatum", "valuta", "wertstellung", "wertstellungsdatum", "valuedate"],
    amount: ["betrag", "netto", "betrageur", "betrag€", "umsatz", "amount", "brutto", "umsatzineur"],
    name: [
        "begunstigterzahlungspflichtiger",
        "name",
        "empfanger",
        "zahlungsempfangerin",
        "zahlungsempfanger",
        "auftraggeberempfanger",
        "auftraggeberbegunstigter",
        "gegenseite",
        "zahlungspflichtigeempfanger",
        "zahlungspflichtiger",
        "payee",
    ],
    iban: ["kontonummeriban", "iban", "ibangegenkonto", "gegenkontoiban", "kontonummer", "konto"],
    purpose: ["verwendungszweck", "buchungsdetails", "zweck", "beschreibung", "purpose", "memo", "typ"],
    bookingText: ["buchungstext", "umsatzart", "buchungsart", "vorgang", "transaktionsart"],
    status: ["info", "status"],
    category: ["kategorie", "category"],
};

/**
 * Hints that only count as the whole column name: "Konto" is the counterparty in MoneyMoney's
 * export, but "Auftragskonto" (Sparkasse) is the own account.
 */
const EXACT_ONLY = new Set(["konto"]);

/** Fields matched by the whole column name only: "Vorgangsnummer" is no "Vorgang". */
const EXACT_FIELDS = new Set<ImportField>(["bookingText", "status"]);

/** Never guessed by a part of its name: "Umsatztyp" contains "umsatz" but holds no amount. */
const NOT_GUESSED = new Set(["umsatztyp"]);

/** Proposes which column holds which field, from the column names. */
export function guessColumns(header: string[]): ColumnMap {
    const names = header.map(norm);
    const used = new Set<number>();
    const map = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as ColumnMap;
    // Fields with the most specific hints go first, so "Valutadatum" is not taken as "Datum"
    // and "Buchungstext" or "Umsatzart" not as date or amount
    for (const field of ["bookingText", "valueDate", "iban", "date", "amount", "name", "purpose", "status", "category"] as ImportField[]) {
        for (const hint of HINTS[field]) {
            const at = names.findIndex((n, i) => !used.has(i) && n === hint);
            if (at >= 0) {
                map[field] = at;
                used.add(at);
                break;
            }
        }
        if (map[field] === null && !EXACT_FIELDS.has(field)) {
            const at = names.findIndex((n, i) => !used.has(i) && !NOT_GUESSED.has(n) && HINTS[field].some((h) => h.length > 4 && !EXACT_ONLY.has(h) && n.includes(h)));
            if (at >= 0) {
                map[field] = at;
                used.add(at);
            }
        }
    }
    return map;
}

export interface ImportRow {
    line: number;
    date: string | null;
    valueDate: string | null;
    amount: number | null;
    name: string;
    iban: string | null;
    purpose: string;
    bookingText: string;
    pending: boolean;
    category: string | null;
    error: string | null;
}

/** Turns the rows of a file into bookings with the given columns. Errors stay on the row. */
export function mapRows(table: CsvTable, map: ColumnMap): ImportRow[] {
    const cell = (r: string[], f: ImportField): string => {
        const at = map[f];
        return at === null ? "" : (r[at] ?? "").trim();
    };
    return table.rows.map((r, i) => {
        const date = parseDate(cell(r, "date"));
        const amount = parseAmount(cell(r, "amount"));
        const ibanRaw = cleanIban(cell(r, "iban"));
        const statusText = cell(r, "status").toLowerCase();
        const row: ImportRow = {
            line: i + 1,
            date,
            valueDate: parseDate(cell(r, "valueDate")),
            amount,
            name: collapse(cell(r, "name")),
            iban: /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(ibanRaw) ? ibanRaw : null,
            purpose: collapse(cell(r, "purpose")),
            bookingText: collapse(cell(r, "bookingText")),
            pending: statusText.includes("vorgemerkt") || statusText === "pending" || statusText === "ausstehend",
            category: cell(r, "category") || null,
            error: null,
        };
        if (map.date === null || map.amount === null) row.error = "Buchungstag und Betrag müssen zugeordnet sein";
        else if (!date) row.error = `Datum „${cell(r, "date")}“ nicht lesbar`;
        else if (amount === null) row.error = `Betrag „${cell(r, "amount")}“ nicht lesbar`;
        return row;
    });
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Normalized text for duplicate detection: case, accents, spaces, line breaks and punctuation do not count. */
export const normalizeText = (s: string | null | undefined): string =>
    (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/**
 * Two bookings of one account are the same when day and amount match (this key) and the
 * counterparty is the same (`sameCounterparty`).
 */
export const duplicateKey = (date: string, amount: number): string => `${date}|${amount}`;

/**
 * Same counterparty: by IBAN when both bookings have one, else by name. A missing name matches any
 * (bank fees, for instance, often come without a counterparty from the bank but with one in exports).
 */
export function sameCounterparty(a: { iban: string | null; name: string }, b: { iban: string | null; name: string }): boolean {
    const ibanA = normalizeText(a.iban);
    const ibanB = normalizeText(b.iban);
    if (ibanA && ibanB) return ibanA === ibanB;
    const nameA = normalizeText(a.name);
    const nameB = normalizeText(b.name);
    return !nameA || !nameB || nameA === nameB;
}
