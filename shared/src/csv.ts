// CSV import: reading the file, guessing which column holds what, turning rows into bookings.
// Pure functions, used by the server (preview and import) and tested on their own.

import { parseDate, type DateOrder } from "./dates.js";
import { parseAmount, type DecimalSeparator } from "./money.js";
import { cleanIban } from "./iban.js";
import { BIC_PATTERN } from "./sepa.js";

export const IMPORT_FIELDS = ["date", "valueDate", "amount", "name", "iban", "purpose", "bookingText", "reference", "mandateId", "creditorId", "counterpartyBic", "status", "category"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
    date: "Buchungstag",
    valueDate: "Wertstellung",
    amount: "Betrag",
    name: "Gegenseite",
    iban: "IBAN der Gegenseite",
    purpose: "Verwendungszweck",
    bookingText: "Umsatzart",
    reference: "Referenz",
    mandateId: "Mandat",
    creditorId: "Gläubiger-ID",
    counterpartyBic: "BIC der Gegenseite",
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
export function splitCsv(text: string, delimiter: string, quote: string | null = "\""): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quoted) {
            if (c === quote) {
                if (text[i + 1] === quote) {
                    field += quote;
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                field += c;
            }
        } else if (c === quote && field === "") {
            quoted = true;
        } else if (text.startsWith(delimiter, i)) {
            row.push(field);
            field = "";
            i += delimiter.length - 1;
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
    return readTable(text, { delimiter: "auto", quote: "\"", headerLine: "auto" });
}

export interface TableOptions {
    /** "auto" picks the delimiter that fits the first lines best. */
    delimiter: string;
    quote: string | null;
    /** Number of the header among the lines with content, from 1; "none" for a file without one. */
    headerLine: number | "auto" | "none";
}

/** Reads a CSV file with the given delimiter, quote and header line. */
export function readTable(text: string, options: TableOptions): CsvTable {
    const clean = text.replace(/^\uFEFF/, "");
    const delimiter = options.delimiter === "auto" ? detectDelimiter(clean) : options.delimiter;
    const all = splitCsv(clean, delimiter, options.quote);
    const width = mode(all.map((r) => r.length));
    if (options.headerLine === "none") {
        const header = Array.from({ length: width }, (_, i) => `Spalte ${i + 1}`);
        return { delimiter, header, rows: all.filter((r) => r.length >= Math.min(width, 2)) };
    }
    const headerAt = options.headerLine === "auto" ? all.findIndex((r) => r.length === width) : options.headerLine - 1;
    if (headerAt < 0 || headerAt >= all.length) return { delimiter, header: [], rows: [] };
    const header = all[headerAt]!.map((h) => h.trim());
    const rows = all.slice(headerAt + 1).filter((r) => r.length >= Math.min(header.length, 2));
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
    reference: ["kundenreferenzendtoend", "endtoendreferenz", "endtoendid", "referenz", "reference"],
    mandateId: ["mandatsreferenz", "mandat", "mandatereference", "mandateid"],
    creditorId: ["glaubigerid", "glaubigeridentifikation", "creditorid"],
    counterpartyBic: ["bicswiftcode", "bic", "swift", "bicgegenkonto"],
    status: ["info", "status"],
    category: ["kategorie", "category"],
};

/**
 * Hints that only count as the whole column name: "Konto" is the counterparty in MoneyMoney's
 * export, but "Auftragskonto" (Sparkasse) is the own account.
 */
const EXACT_ONLY = new Set(["konto"]);

/** Fields matched by the whole column name only: "Vorgangsnummer" is no "Vorgang". */
const EXACT_FIELDS = new Set<ImportField>(["bookingText", "reference", "mandateId", "creditorId", "counterpartyBic", "status"]);

/** Never guessed by a part of its name: "Umsatztyp" contains "umsatz" but holds no amount. */
const NOT_GUESSED = new Set(["umsatztyp"]);

/** Proposes which column holds which field, from the column names. */
export function guessColumns(header: string[]): ColumnMap {
    const names = header.map(norm);
    const used = new Set<number>();
    const map = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as ColumnMap;
    // Fields with the most specific hints go first, so "Valutadatum" is not taken as "Datum"
    // and "Buchungstext" or "Umsatzart" not as date or amount
    for (const field of ["bookingText", "reference", "mandateId", "creditorId", "counterpartyBic", "valueDate", "iban", "date", "amount", "name", "purpose", "status", "category"] as ImportField[]) {
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
    reference: string;
    mandateId: string;
    creditorId: string;
    counterpartyBic: string;
    pending: boolean;
    category: string | null;
    error: string | null;
}

/** How the values of a row are read; without it, as the file's form suggests. */
export interface RowValueOptions {
    dateOrder?: DateOrder;
    decimalSeparator?: DecimalSeparator;
    /** Words in the status that mark a booking as pending; empty for the usual ones. */
    pendingWords?: string[];
}

const USUAL_PENDING = (status: string): boolean => status.includes("vorgemerkt") || status === "pending" || status === "ausstehend";

/** Turns the values of one row into a booking. Errors stay on the row. */
export function toImportRow(line: number, value: (f: ImportField) => string, mapped: boolean, options: RowValueOptions = {}): ImportRow {
    const date = parseDate(value("date"), options.dateOrder);
    const amount = parseAmount(value("amount"), options.decimalSeparator);
    const ibanRaw = cleanIban(value("iban"));
    const bic = value("counterpartyBic").toUpperCase().replace(/\s/g, "");
    const statusText = value("status").toLowerCase();
    const words = (options.pendingWords ?? []).map((w) => w.toLowerCase()).filter(Boolean);
    const row: ImportRow = {
        line,
        date,
        valueDate: parseDate(value("valueDate"), options.dateOrder),
        amount,
        name: collapse(value("name")),
        iban: /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(ibanRaw) ? ibanRaw : null,
        purpose: collapse(value("purpose")),
        bookingText: collapse(value("bookingText")),
        reference: collapse(value("reference")),
        mandateId: collapse(value("mandateId")),
        creditorId: collapse(value("creditorId")),
        counterpartyBic: BIC_PATTERN.test(bic) ? bic : "",
        pending: words.length ? words.some((w) => statusText.includes(w)) : USUAL_PENDING(statusText),
        category: value("category") || null,
        error: null,
    };
    if (!mapped) row.error = "Buchungstag und Betrag müssen zugeordnet sein";
    else if (!date) row.error = `Datum „${value("date")}“ nicht lesbar`;
    else if (amount === null) row.error = `Betrag „${value("amount")}“ nicht lesbar`;
    return row;
}

/** Turns the rows of a file into bookings with the given columns. Errors stay on the row. */
export function mapRows(table: CsvTable, map: ColumnMap): ImportRow[] {
    const cell = (r: string[], f: ImportField): string => {
        const at = map[f];
        return at === null ? "" : (r[at] ?? "").trim();
    };
    return table.rows.map((r, i) => toImportRow(i + 1, (f) => cell(r, f), map.date !== null && map.amount !== null));
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

/** The parts of a booking that identify its counterparty. */
export interface BookingParty {
    iban: string | null;
    name: string;
    purpose: string | null;
}

/**
 * Same counterparty: by IBAN when both bookings have one, else by name. With a name missing
 * (bank fees, for instance, often come without a counterparty from the bank but with one in
 * exports), the purpose of the file must be contained in the purpose of the other booking.
 * Two empty purposes count as equal, so that importing a file again adds nothing.
 */
export function sameCounterparty(booking: BookingParty, file: BookingParty): boolean {
    const ibanA = normalizeText(booking.iban);
    const ibanB = normalizeText(file.iban);
    if (ibanA && ibanB) return ibanA === ibanB;
    const nameA = normalizeText(booking.name);
    const nameB = normalizeText(file.name);
    if (nameA && nameB) return nameA === nameB;
    const purpose = normalizeText(booking.purpose);
    const filePurpose = normalizeText(file.purpose);
    return filePurpose ? purpose.includes(filePurpose) : !purpose;
}
