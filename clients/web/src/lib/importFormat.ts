import { useDeferredValue, useMemo } from "react";
import { foldText, FORMAT_FIELDS, ImportFormatDefinition, formatIssues, missingColumns, parseDateSpec, readTable, REST_PART, todayIso, type CsvTable, type FormatField, type FormatStep, type FormatValueRef, type ImportPreview } from "@mbm/shared";
import { decodeCsv } from "./decode";
import { plural } from "./format";

/** A place a value can come from, for the selects of the import dialog. */
export interface SourceOption {
    key: string;
    label: string;
    ref: FormatValueRef;
}

export const refKey = (ref: FormatValueRef): string => JSON.stringify(ref);

/** The key of a source as the selects list it: a column with a unique name goes by that name. */
export function sourceKey(ref: FormatValueRef, header: string[]): string {
    if (!("columnIndex" in ref)) return refKey(ref);
    const name = header[ref.columnIndex];
    return name && header.indexOf(name) === header.lastIndexOf(name) ? refKey({ column: name }) : refKey(ref);
}

/** How a source reads when the file does not have it. */
export const sourceLabel = (ref: FormatValueRef): string => ("column" in ref ? ref.column : "columnIndex" in ref ? `Spalte ${ref.columnIndex + 1}` : `${ref.step} › ${ref.part}`);

const stepParts = (step: FormatStep): { part: string; label: string }[] =>
    step.type === "keywords" ? step.keywords.map((k) => ({ part: k.part, label: k.text })) : step.parts.map((p) => ({ part: p, label: p }));

/** The columns of the file and the parts of the steps before `beforeStep`. */
export function sourceOptions(def: ImportFormatDefinition, header: string[], beforeStep = def.steps.length): SourceOption[] {
    const options: SourceOption[] = header.map((h, i) => {
        const unique = !!h && header.indexOf(h) === header.lastIndexOf(h);
        const ref: FormatValueRef = unique ? { column: h } : { columnIndex: i };
        return { key: refKey(ref), label: h || `Spalte ${i + 1}`, ref };
    });
    def.steps.slice(0, beforeStep).forEach((step, i) => {
        for (const { part, label } of [...stepParts(step), { part: REST_PART, label: "Rest" }]) {
            const ref: FormatValueRef = { step: step.id, part };
            options.push({ key: refKey(ref), label: `Stufe ${i + 1} › ${label}`, ref });
        }
    });
    return options;
}

/** A name for a part from free text: letters, digits, - and _, not yet taken. */
export function partName(text: string, taken: Iterable<string>): string {
    const base =
        text
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/ß/g, "ss")
            .replace(/[^A-Za-z0-9_-]+/g, "-")
            .replace(/^[^A-Za-z]+/, "")
            .replace(/-+$/, "")
            .slice(0, 34) || "part";
    const used = new Set(taken);
    used.add(REST_PART);
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Puts a changed step in place. Parts renamed in their line take their fields and later steps along. */
export function replaceStep(def: ImportFormatDefinition, index: number, next: FormatStep): ImportFormatDefinition {
    const before = def.steps[index]!;
    const renamed = new Map<string, string>();
    if (before.type === "separator" && next.type === "separator" && before.parts.length === next.parts.length) {
        before.parts.forEach((part, i) => {
            if (part !== next.parts[i]) renamed.set(part, next.parts[i]!);
        });
    }
    const move = (ref: FormatValueRef): FormatValueRef => ("step" in ref && ref.step === before.id && renamed.has(ref.part) ? { step: ref.step, part: renamed.get(ref.part)! } : ref);
    const fields: ImportFormatDefinition["fields"] = {};
    for (const [field, refs] of Object.entries(def.fields) as [keyof ImportFormatDefinition["fields"], FormatValueRef[] | undefined][]) {
        if (refs) fields[field] = refs.map(move);
    }
    const steps = def.steps.map((s, at) => (at === index ? next : { ...s, input: move(s.input) }));
    return { ...def, steps, fields };
}

/** A new step reading the first column, with a keyword to start from. */
export function newStep(def: ImportFormatDefinition, header: string[]): FormatStep {
    const ids = new Set(def.steps.map((s) => s.id));
    let n = def.steps.length + 1;
    while (ids.has(`step${n}`)) n++;
    return {
        id: `step${n}`,
        input: sourceOptions(def, header, 0)[0]?.ref ?? { columnIndex: 0 },
        type: "keywords",
        prefix: ", ",
        suffix: ": ",
        keywords: [{ text: "Stichwort", part: "Stichwort" }],
    };
}

/** Fields by what they are about, in the order the editor shows them. */
export const FIELD_GROUPS: { label: string; fields: FormatField[] }[] = [
    { label: "Pflicht", fields: ["bookingDate", "amount"] },
    { label: "Gegenseite", fields: ["counterpartyName", "counterpartyIban", "counterpartyBic"] },
    { label: "Inhalt", fields: ["remittance", "bookingText", "category"] },
    { label: "Zahlungsdetails", fields: ["reference", "customerReference", "bankReference", "mandateId", "creditorId"] },
    { label: "Weitere", fields: ["valueDate", "status"] },
];

/** A format to start from, with nothing assigned yet. */
export const emptyFormat = (): ImportFormatDefinition => ({
    version: 1,
    file: { encoding: "auto", delimiter: ";", quote: "\"", headerLine: 1 },
    steps: [],
    fields: {},
    values: { dateOrder: "auto", decimalSeparator: "auto", categorySeparator: "auto", pendingWords: [] },
});

/** The columns a format names, for editing it without a file. */
export function formatColumns(def: ImportFormatDefinition): string[] {
    const names = new Set<string>();
    const add = (ref: FormatValueRef) => {
        if ("column" in ref) names.add(ref.column);
    };
    for (const field of FORMAT_FIELDS) for (const ref of def.fields[field] ?? []) add(ref);
    for (const step of def.steps) add(step.input);
    return [...names];
}

const DELIMITER_NAMES: Record<string, string> = { auto: "Trenner automatisch", ";": "Semikolon", ",": "Komma", "\t": "Tabulator", "|": "Senkrechter Strich" };

export function fileSummary(def: ImportFormatDefinition): string {
    const { delimiter, headerLine } = def.file;
    const header = headerLine === "auto" ? "Kopfzeile automatisch" : headerLine === "none" ? "ohne Kopfzeile" : `Kopfzeile ${headerLine}`;
    return `${DELIMITER_NAMES[delimiter] ?? `Trenner „${delimiter}“`} · ${header}`;
}

export const stepsSummary = (def: ImportFormatDefinition): string => (def.steps.length ? plural(def.steps.length, "Stufe", "Stufen") : "keine Zerlegung");

export const fieldsSummary = (def: ImportFormatDefinition): string => `${FORMAT_FIELDS.filter((f) => def.fields[f]?.length).length} von ${FORMAT_FIELDS.length} zugeordnet`;

/** What keeps a format from being used, in words for the user; "" when it is fine. */
export function formatProblem(def: ImportFormatDefinition, table: CsvTable | null): string {
    if (table && !table.header.length) return "Mit diesen Einstellungen steht keine Tabelle in der Datei.";
    if (table) {
        const absent = missingColumns(def, table.header);
        if (absent.length) return `In der Datei fehlt: ${absent.join(", ")}.`;
    }
    if (!def.fields.bookingDate?.length || !def.fields.amount?.length) return "Buchungstag und Betrag müssen zugeordnet sein.";
    if (!ImportFormatDefinition.safeParse(def).success) return formatIssues(def)[0] ?? "Bitte alle Angaben der Stufen ausfüllen.";
    return "";
}

/**
 * The table of a sample file with the file settings of a format. Only these settings read the
 * file again, and a change of them does not hold up typing.
 */
export function useFormatTable(sample: { buffer: ArrayBuffer } | null, file: ImportFormatDefinition["file"]): CsvTable | null {
    const settings = useDeferredValue(file);
    return useMemo(() => {
        if (!sample) return null;
        if (!settings.delimiter) return { delimiter: "", header: [], rows: [] };
        return readTable(decodeCsv(sample.buffer, settings.encoding), settings);
    }, [sample, settings]);
}

// ---------- The review of an import ----------

type ReviewRow = ImportPreview["rows"][number];

/** What the list of the review shows; `changes` is everything that does something or failed. */
export type ReviewFilter = "changes" | "new" | "fill" | "differs" | "duplicate" | "invalid" | "all";

/** A stored booking with an empty kind of booking or detail the file has. */
export const rowFillsFields = (r: ReviewRow): boolean => r.fillsBookingText || r.fillsDetails;
/** A stored booking without a category, where the file names one. */
export const rowFillsCategory = (r: ReviewRow): boolean => r.categoryState === "empty";
export const rowFills = (r: ReviewRow): boolean => rowFillsFields(r) || rowFillsCategory(r);
/** A stored booking whose category conflicts with the file's. */
export const rowDiffers = (r: ReviewRow): boolean => r.categoryState === "differs";

export function matchesFilter(r: ReviewRow, filter: ReviewFilter): boolean {
    switch (filter) {
        case "new":
            return r.state === "new";
        case "invalid":
            return r.state === "invalid";
        case "fill":
            return rowFills(r);
        case "differs":
            return rowDiffers(r);
        case "duplicate":
            return r.state === "duplicate" && !rowFills(r) && !rowDiffers(r);
        case "changes":
            // A conflict changes nothing by itself, so it has its own filter
            return r.state !== "duplicate" || rowFills(r);
        case "all":
            return true;
    }
}

export function reviewCounts(rows: ReviewRow[]): Record<ReviewFilter, number> {
    const counts: Record<ReviewFilter, number> = { changes: 0, new: 0, fill: 0, differs: 0, duplicate: 0, invalid: 0, all: 0 };
    for (const r of rows) for (const f of Object.keys(counts) as ReviewFilter[]) if (matchesFilter(r, f)) counts[f]++;
    return counts;
}

/** Finds text in the counterparty, purpose, IBAN or a reference; an IBAN also when typed with spaces. */
type DateCmp = ">" | ">=" | "<" | "<=" | "=" | ":";

/** The search of the review: text plus date conditions as the transaction list reads them. */
export interface ReviewSearch {
    /** Folded text the row must contain; "" for none. */
    text: string;
    /** Days the booking date must lie in, all of them. */
    dates: { op: DateCmp; from: string; to: string }[];
    /** Why a date condition cannot be read; "" if all can. */
    error: string;
}

// datum>=1.3.2026, date:vormonat, datum< -30t: a field name at the start of a word, a comparison and the date
const DATE_TERM = /(^|\s)(?:datum|date)(:(?:>=|<=|>|<|=)?|>=|<=|>|<|=)\s*([^\s]*)/gi;

/** Reads the search of the review: date conditions (datum>=1.3.2026, datum:2026-11, datum<-30t) and text. */
export function parseReviewSearch(input: string, today = todayIso()): ReviewSearch {
    const dates: ReviewSearch["dates"] = [];
    let error = "";
    const rest = input.replace(DATE_TERM, (_all, lead: string, sign: string, value: string) => {
        const op = (sign.length > 1 && sign.startsWith(":") ? sign.slice(1) : sign) as DateCmp;
        const spec = value ? parseDateSpec(value, today) : null;
        if (spec) dates.push({ op, from: spec.from, to: spec.to });
        else error ||= value ? `„${value}“ ist kein gültiges Datum (z. B. 1.3.2026, 3.2026, 2026, -30t oder vormonat)` : `Nach „datum${sign}“ fehlt ein Datum`;
        return lead;
    });
    return { text: foldText(rest).trim(), dates, error };
}

function matchesDate(day: string, { op, from, to }: ReviewSearch["dates"][number]): boolean {
    switch (op) {
        case ">":
            return day > to;
        case ">=":
            return day >= from;
        case "<":
            return day < from;
        case "<=":
            return day <= to;
        default:
            return day >= from && day <= to;
    }
}

export function matchesSearch(r: ReviewRow, search: ReviewSearch): boolean {
    // A row without a readable date never meets a date condition
    const day = r.date;
    if (search.dates.length && !(day && search.dates.every((d) => matchesDate(day, d)))) return false;
    const needle = search.text;
    if (!needle) return true;
    if ([r.name, r.purpose, r.iban ?? "", r.reference, r.customerReference, r.bankReference].some((v) => foldText(v).includes(needle))) return true;
    return !!r.iban && foldText(r.iban).replace(/ /g, "").includes(needle.replace(/ /g, ""));
}

/** What was decided in the review. It lasts as long as file, format and account stay the same. */
export interface ReviewChoice {
    /** Lines whose new booking or filled-in values are left out. */
    excluded: ReadonlySet<number>;
    /** Lines whose differing category replaces the stored one. None by default. */
    replaced: ReadonlySet<number>;
    createCategories: boolean;
}

export const NO_CHOICE: ReviewChoice = { excluded: new Set(), replaced: new Set(), createCategories: false };

/** The two decisions a row can hold: take what is new or empty, and replace a differing category. */
export type RowPart = "take" | "category";

const rowHasPart = (r: ReviewRow, part: RowPart): boolean => (part === "take" ? r.state === "new" || rowFills(r) : rowDiffers(r));
const partChosen = (r: ReviewRow, part: RowPart, choice: ReviewChoice): boolean => (part === "take" ? !choice.excluded.has(r.line) : choice.replaced.has(r.line));

/** A row with something to decide. */
export const rowSelectable = (r: ReviewRow): boolean => rowHasPart(r, "take") || rowHasPart(r, "category");

/** Both decisions of a row together; `partial` when only one of them is chosen. */
export type RowCheck = "none" | "off" | "partial" | "on";

export function rowCheck(r: ReviewRow, choice: ReviewChoice): RowCheck {
    const chosen = (["take", "category"] as const).filter((p) => rowHasPart(r, p)).map((p) => partChosen(r, p, choice));
    if (!chosen.length) return "none";
    return chosen.every(Boolean) ? "on" : chosen.some(Boolean) ? "partial" : "off";
}

/** Sets one decision for the rows that have it. */
export function setRowPart(rows: readonly ReviewRow[], part: RowPart, on: boolean, choice: ReviewChoice): ReviewChoice {
    const excluded = new Set(choice.excluded);
    const replaced = new Set(choice.replaced);
    for (const r of rows) {
        if (!rowHasPart(r, part)) continue;
        if (part === "category") {
            if (on) replaced.add(r.line);
            else replaced.delete(r.line);
        } else if (on) excluded.delete(r.line);
        else excluded.add(r.line);
    }
    return { ...choice, excluded, replaced };
}

/** A click on a row: everything on, or from fully on to everything off. */
export function toggleRow(r: ReviewRow, choice: ReviewChoice): ReviewChoice {
    const on = rowCheck(r, choice) !== "on";
    return setRowPart([r], "category", on, setRowPart([r], "take", on, choice));
}

/** What "all shown" decides: categories under "Abweichend", else only what is new or empty. */
const shownPart = (filter: ReviewFilter): RowPart => (filter === "differs" ? "category" : "take");

/** The state of "all shown". `chosen` counts the shown rows with anything chosen. */
export function shownSelection(rows: readonly ReviewRow[], filter: ReviewFilter, choice: ReviewChoice) {
    const part = shownPart(filter);
    const targets = rows.filter((r) => rowHasPart(r, part));
    const on = targets.filter((r) => partChosen(r, part, choice)).length;
    const chosen = rows.filter((r) => ["on", "partial"].includes(rowCheck(r, choice))).length;
    return { targets: targets.length, all: targets.length > 0 && on === targets.length, some: on > 0 && on < targets.length, chosen };
}

export function toggleShown(rows: readonly ReviewRow[], filter: ReviewFilter, choice: ReviewChoice): ReviewChoice {
    return setRowPart(rows, shownPart(filter), !shownSelection(rows, filter, choice).all, choice);
}

/** What the import does with the category of a stored booking, and if nothing, why. */
export type CategoryChange = "replaced" | "filled" | "not-chosen" | "left-out" | "needs-category";

export function categoryChange(r: ReviewRow, choice: ReviewChoice): CategoryChange {
    if (rowDiffers(r) && !choice.replaced.has(r.line)) return "not-chosen";
    if (rowFillsCategory(r) && choice.excluded.has(r.line)) return "left-out";
    if (r.categoryId === null && !choice.createCategories) return "needs-category";
    return rowDiffers(r) ? "replaced" : "filled";
}

/** What the import does with the rows that are selected. */
export function reviewOutcome(rows: ReviewRow[], choice: ReviewChoice) {
    const kept = rows.filter((r) => !choice.excluded.has(r.line));
    const differing = rows.filter(rowDiffers);
    const chosen = differing.filter((r) => choice.replaced.has(r.line));
    const empty = kept.filter(rowFillsCategory);
    // Missing categories of rows that will be written
    const missing = [...new Set([...kept.filter((r) => r.state === "new"), ...empty, ...chosen].filter((r) => r.newCategory).map((r) => r.newCategory!))];
    const create = choice.createCategories && missing.length > 0;
    const writes = (r: ReviewRow) => r.categoryId !== null || (create && !!r.newCategory);
    const replaced = new Set(chosen.filter(writes).map((r) => r.line));
    const fillsAny = (r: ReviewRow) => rowFillsFields(r) || (rowFillsCategory(r) && writes(r));
    return {
        differing: differing.length,
        chosen: chosen.length,
        missing,
        create,
        changes: replaced.size,
        blocked: chosen.length + empty.length > replaced.size + empty.filter(writes).length,
        fresh: kept.filter((r) => r.state === "new").length,
        fills: kept.filter(fillsAny).length,
        affected: rows.filter((r) => replaced.has(r.line) || (!choice.excluded.has(r.line) && (r.state === "new" || fillsAny(r)))).length,
        leftOut: rows.filter((r) => choice.excluded.has(r.line) && (r.state === "new" || fillsAny(r))).length,
    };
}

/** Drops what points to a step or part that no longer exists. A step falls back to the first column. */
export function pruneRefs(def: ImportFormatDefinition): ImportFormatDefinition {
    const known = new Map<string, Set<string>>();
    const valid = (ref: FormatValueRef): boolean => !("step" in ref) || (known.has(ref.step) && (ref.part === REST_PART || known.get(ref.step)!.has(ref.part)));
    const steps = def.steps.map((step) => {
        const next: FormatStep = valid(step.input) ? step : { ...step, input: { columnIndex: 0 } };
        known.set(step.id, new Set(stepParts(step).map((p) => p.part)));
        return next;
    });
    const fields: ImportFormatDefinition["fields"] = {};
    for (const [field, refs] of Object.entries(def.fields) as [keyof ImportFormatDefinition["fields"], FormatValueRef[] | undefined][]) {
        const kept = (refs ?? []).filter(valid);
        if (kept.length) fields[field] = kept;
    }
    return { ...def, steps, fields };
}

/** "Name (Kopie)", or the next free number. */
export function copyName(name: string, taken: string[]): string {
    const used = new Set(taken.map((t) => t.toLowerCase()));
    const first = `${name} (Kopie)`;
    if (!used.has(first.toLowerCase())) return first;
    for (let n = 2; ; n++) if (!used.has(`${name} (Kopie ${n})`.toLowerCase())) return `${name} (Kopie ${n})`;
}
