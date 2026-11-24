// Import formats: how a file is read, how its values are taken apart in steps and which part goes
// into which field. Pure functions, used by the server (preview and import) and by the web client
// (the live sample of the format editor). Separators are fixed text, never patterns, so a stored
// format cannot make the server spend unbounded time on a value.

import { IMPORT_FIELDS, readTable, toImportRow, type ColumnMap, type CsvTable, type ImportField, type ImportRow } from "./csv.js";
import type { FormatStep, FormatValueRef, ImportFormatDefinition } from "./schemas/banking.js";

/** Target fields of a format, named as in the API. */
export const FORMAT_FIELDS = [
    "bookingDate",
    "valueDate",
    "amount",
    "counterpartyName",
    "counterpartyIban",
    "counterpartyBic",
    "remittance",
    "bookingText",
    "reference",
    "customerReference",
    "bankReference",
    "mandateId",
    "creditorId",
    "status",
    "category",
] as const;
export type FormatField = (typeof FORMAT_FIELDS)[number];

export const FORMAT_FIELD_LABELS: Record<FormatField, string> = {
    bookingDate: "Buchungstag",
    valueDate: "Wertstellung",
    amount: "Betrag",
    counterpartyName: "Gegenseite",
    counterpartyIban: "IBAN der Gegenseite",
    counterpartyBic: "BIC der Gegenseite",
    remittance: "Verwendungszweck",
    bookingText: "Umsatzart",
    reference: "End-to-End-Referenz",
    customerReference: "Kundenreferenz",
    bankReference: "Bankreferenz",
    mandateId: "Mandat",
    creditorId: "Gläubiger-ID",
    status: "Status (vorgemerkt)",
    category: "Kategorie",
};

export const FORMAT_MAX_STEPS = 5;

/** The kinds of reference a booking has, as fields of a format and of a booking. */
export const REFERENCE_KINDS = ["reference", "customerReference", "bankReference"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/**
 * The kinds of reference of a booking already stored that are searched for the value of a
 * reference field of the file. Its own kind always counts; without a setting, all of them.
 */
export function referenceMatch(def: ImportFormatDefinition, kind: ReferenceKind): ReferenceKind[] {
    const chosen = def.values.referenceMatch?.[kind] ?? REFERENCE_KINDS;
    return REFERENCE_KINDS.filter((k) => k === kind || chosen.includes(k));
}

/** The part of every step that holds what no field took. */
export const REST_PART = "rest";

// The column map of the API keeps its older names
const FIELD_OF: Record<ImportField, FormatField> = {
    date: "bookingDate",
    valueDate: "valueDate",
    amount: "amount",
    name: "counterpartyName",
    iban: "counterpartyIban",
    purpose: "remittance",
    bookingText: "bookingText",
    reference: "reference",
    customerReference: "customerReference",
    bankReference: "bankReference",
    mandateId: "mandateId",
    creditorId: "creditorId",
    counterpartyBic: "counterpartyBic",
    status: "status",
    category: "category",
};

export const partKey = (step: string, part: string): string => `${step}\u0000${part}`;

/** The parts a later step or a field reads; all others stay in the rest of their step. */
function usedParts(def: ImportFormatDefinition): Set<string> {
    const used = new Set<string>();
    const add = (ref: FormatValueRef) => {
        if ("step" in ref && ref.part !== REST_PART) used.add(partKey(ref.step, ref.part));
    };
    for (const step of def.steps) add(step.input);
    for (const refs of Object.values(def.fields)) for (const ref of refs ?? []) add(ref);
    return used;
}

/** Where a keyword stands: its last occurrence, at the start of the text or after the prefix. */
function findKeyword(text: string, word: string, prefix: string, suffix: string): { start: number; valueStart: number } | null {
    const plain = word + suffix;
    if (prefix) {
        const at = text.lastIndexOf(prefix + plain);
        if (at >= 0) return { start: at, valueStart: at + prefix.length + plain.length };
        return text.startsWith(plain) ? { start: 0, valueStart: plain.length } : null;
    }
    // Without a prefix a keyword must not be the end of a longer word
    for (let at = text.lastIndexOf(plain); at >= 0; at = at > 0 ? text.lastIndexOf(plain, at - 1) : -1) {
        if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]!)) return { start: at, valueStart: at + plain.length };
    }
    return null;
}

export function runKeywords(text: string, step: Pick<Extract<FormatStep, { type: "keywords" }>, "id" | "prefix" | "suffix" | "keywords">, isUsed: (part: string) => boolean, out: Map<string, string>): void {
    const hits = step.keywords
        .flatMap((k) => {
            const hit = findKeyword(text, k.text, step.prefix, step.suffix);
            return hit ? [{ ...hit, part: k.part }] : [];
        })
        .sort((a, b) => a.start - b.start);
    const kept: typeof hits = [];
    for (const hit of hits) if (!kept.length || hit.start >= kept[kept.length - 1]!.valueStart) kept.push(hit);
    let rest = text.slice(0, kept[0]?.start ?? text.length);
    kept.forEach((hit, i) => {
        const end = kept[i + 1]?.start ?? text.length;
        out.set(partKey(step.id, hit.part), text.slice(hit.valueStart, end).trim());
        if (!isUsed(hit.part)) rest += text.slice(hit.start, end);
    });
    if (step.prefix && rest.startsWith(step.prefix)) rest = rest.slice(step.prefix.length);
    out.set(partKey(step.id, REST_PART), rest.trim());
}

export function runSeparator(text: string, step: Pick<Extract<FormatStep, { type: "separator" }>, "id" | "separator" | "parts">, isUsed: (part: string) => boolean, out: Map<string, string>): void {
    const pieces = text.split(step.separator);
    step.parts.forEach((part, i) => out.set(partKey(step.id, part), (pieces[i] ?? "").trim()));
    const left = pieces.filter((_, i) => i >= step.parts.length || !isUsed(step.parts[i]!));
    out.set(partKey(step.id, REST_PART), left.join(step.separator).trim());
}

const columnsOf = (header: string[]): Map<string, number> => {
    const columns = new Map<string, number>();
    header.forEach((h, i) => {
        if (!columns.has(h)) columns.set(h, i);
    });
    return columns;
};

function refValue(ref: FormatValueRef, cells: string[], columns: Map<string, number>, parts: Map<string, string>): string {
    if ("step" in ref) return parts.get(partKey(ref.step, ref.part)) ?? "";
    const at = "column" in ref ? columns.get(ref.column) : ref.columnIndex;
    return at === undefined ? "" : (cells[at] ?? "").trim();
}

/** Runs the steps of a format on the cells of one row; returns the parts by step and name. */
export function applySteps(cells: string[], def: ImportFormatDefinition, columns: Map<string, number>, used = usedParts(def)): Map<string, string> {
    const out = new Map<string, string>();
    for (const step of def.steps) {
        const text = refValue(step.input, cells, columns, out);
        const isUsed = (part: string) => used.has(partKey(step.id, part));
        if (step.type === "keywords") runKeywords(text, step, isUsed, out);
        else runSeparator(text, step, isUsed, out);
    }
    return out;
}

/** The value of one reference for every kind of source; for the sample of the format editor. */
export function previewParts(table: CsvTable, def: ImportFormatDefinition, row: number): (ref: FormatValueRef) => string {
    const columns = columnsOf(table.header);
    const cells = table.rows[row] ?? [];
    const parts = applySteps(cells, def, columns);
    return (ref) => refValue(ref, cells, columns, parts);
}

export const readWithFormat = (text: string, def: ImportFormatDefinition): CsvTable => readTable(text, def.file);

/** Turns the rows of a file into bookings with the given format. Errors stay on the row. */
export function mapFormatRows(table: CsvTable, def: ImportFormatDefinition): ImportRow[] {
    const columns = columnsOf(table.header);
    const used = usedParts(def);
    const mapped = !!def.fields.bookingDate?.length && !!def.fields.amount?.length;
    return table.rows.map((cells, i) => {
        const parts = applySteps(cells, def, columns, used);
        const value = (field: ImportField): string =>
            (def.fields[FIELD_OF[field]] ?? [])
                .map((ref) => refValue(ref, cells, columns, parts))
                .filter(Boolean)
                .join(" ");
        return toImportRow(i + 1, value, mapped, def.values);
    });
}

/** Columns a format names that the file does not have. */
export function missingColumns(def: ImportFormatDefinition, header: string[]): string[] {
    const missing = new Set<string>();
    const check = (ref: FormatValueRef) => {
        if ("column" in ref && !header.includes(ref.column)) missing.add(ref.column);
        if ("columnIndex" in ref && ref.columnIndex >= header.length) missing.add(`Spalte ${ref.columnIndex + 1}`);
    };
    for (const step of def.steps) check(step.input);
    for (const refs of Object.values(def.fields)) for (const ref of refs ?? []) check(ref);
    return [...missing];
}

/** A format for plain column assignments, naming a column where its name is unique. */
export function formatFromColumns(map: ColumnMap, header: string[]): ImportFormatDefinition {
    const fields: ImportFormatDefinition["fields"] = {};
    for (const f of IMPORT_FIELDS) {
        const at = map[f];
        if (at === null || at === undefined) continue;
        const name = header[at];
        const unique = !!name && header.indexOf(name) === header.lastIndexOf(name);
        fields[FIELD_OF[f]] = [unique ? { column: name } : { columnIndex: at }];
    }
    return {
        version: 1,
        file: { encoding: "auto", delimiter: "auto", quote: "\"", headerLine: "auto" },
        steps: [],
        fields,
        values: { dateOrder: "auto", decimalSeparator: "auto", categorySeparator: "auto", pendingWords: [] },
    };
}

/** The column assignment of a format; a field fed by a step or by several sources has none. */
export function columnsFromFormat(def: ImportFormatDefinition, header: string[]): ColumnMap {
    const columns = columnsOf(header);
    const map = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as ColumnMap;
    for (const f of IMPORT_FIELDS) {
        const refs = def.fields[FIELD_OF[f]];
        if (refs?.length !== 1) continue;
        const ref = refs[0]!;
        if ("column" in ref) map[f] = columns.get(ref.column) ?? null;
        else if ("columnIndex" in ref) map[f] = ref.columnIndex < header.length ? ref.columnIndex : null;
    }
    return map;
}

/** How many columns a format names; the more, the surer a matching header is this format. */
function namedColumns(def: ImportFormatDefinition): Set<string> {
    const names = new Set<string>();
    const add = (ref: FormatValueRef) => {
        if ("column" in ref) names.add(ref.column);
    };
    for (const step of def.steps) add(step.input);
    for (const refs of Object.values(def.fields)) for (const ref of refs ?? []) add(ref);
    return names;
}

const SAMPLE_LENGTH = 64_000;

/**
 * The format that fits the header of a file. Date and amount must come from named columns and all
 * its columns must exist. Earlier candidates win a tie, so own formats go before the built-in ones.
 */
export function matchFormat<F extends { definition: ImportFormatDefinition }>(text: string, candidates: F[]): F | null {
    const sample = text.slice(0, SAMPLE_LENGTH);
    let best: { format: F; score: number } | null = null;
    for (const format of candidates) {
        const def = format.definition;
        const named = (refs: FormatValueRef[] | undefined) => !!refs?.length && refs.every((r) => "column" in r);
        if (def.file.headerLine === "none" || !named(def.fields.bookingDate) || !named(def.fields.amount)) continue;
        const { header } = readWithFormat(sample, def);
        if (!header.length || missingColumns(def, header).length) continue;
        const score = namedColumns(def).size;
        if (!best || score > best.score) best = { format, score };
    }
    return best?.format ?? null;
}

/** What is wrong with a format's structure, in words for the user; empty when it is sound. */
export function formatIssues(def: ImportFormatDefinition): string[] {
    const issues: string[] = [];
    const known = new Map<string, Set<string>>();
    const refIssue = (ref: FormatValueRef, where: string) => {
        if (!("step" in ref)) return;
        const parts = known.get(ref.step);
        if (!parts) issues.push(`${where} liest aus der unbekannten Stufe „${ref.step}“.`);
        else if (ref.part !== REST_PART && !parts.has(ref.part)) issues.push(`${where} liest den unbekannten Teil „${ref.part}“.`);
    };
    def.steps.forEach((step, i) => {
        const where = `Stufe ${i + 1}`;
        if (known.has(step.id)) issues.push(`${where}: Die Kennung „${step.id}“ gibt es schon.`);
        refIssue(step.input, where);
        const parts = step.type === "keywords" ? step.keywords.map((k) => k.part) : step.parts;
        if (new Set(parts).size !== parts.length) issues.push(`${where}: Teile müssen verschiedene Namen haben.`);
        if (parts.includes(REST_PART)) issues.push(`${where}: Der Name „${REST_PART}“ ist für den Rest reserviert.`);
        if (step.type === "keywords" && new Set(step.keywords.map((k) => k.text)).size !== step.keywords.length) issues.push(`${where}: Ein Trennwort steht doppelt.`);
        known.set(step.id, new Set(parts));
    });
    for (const field of FORMAT_FIELDS) for (const ref of def.fields[field] ?? []) refIssue(ref, FORMAT_FIELD_LABELS[field]);
    // One source for two kinds of reference would store its value twice
    const readBy = new Map<string, ReferenceKind>();
    for (const kind of REFERENCE_KINDS) {
        for (const ref of def.fields[kind] ?? []) {
            const key = JSON.stringify("step" in ref ? [ref.step, ref.part] : "column" in ref ? [ref.column] : [ref.columnIndex]);
            const other = readBy.get(key);
            if (other && other !== kind) issues.push(`${FORMAT_FIELD_LABELS[other]} und ${FORMAT_FIELD_LABELS[kind]} lesen dieselbe Quelle.`);
            else readBy.set(key, kind);
        }
    }
    return issues;
}
