import { useDeferredValue, useMemo } from "react";
import { foldText, FORMAT_FIELDS, ImportFormatDefinition, formatIssues, missingColumns, readTable, REST_PART, type CsvTable, type FormatField, type FormatStep, type FormatValueRef, type ImportPreview } from "@mbm/shared";
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
    { label: "Zahlungsdetails", fields: ["reference", "mandateId", "creditorId"] },
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

export const rowFills = (r: ReviewRow): boolean => r.fillsBookingText || r.fillsDetails;
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
            return r.state !== "duplicate" || rowFills(r) || rowDiffers(r);
        case "all":
            return true;
    }
}

export function reviewCounts(rows: ReviewRow[]): Record<ReviewFilter, number> {
    const counts: Record<ReviewFilter, number> = { changes: 0, new: 0, fill: 0, differs: 0, duplicate: 0, invalid: 0, all: 0 };
    for (const r of rows) for (const f of Object.keys(counts) as ReviewFilter[]) if (matchesFilter(r, f)) counts[f]++;
    return counts;
}

/** Finds text in the counterparty, purpose, IBAN or reference; an IBAN also when typed with spaces. */
export function matchesSearch(r: ReviewRow, text: string): boolean {
    const needle = foldText(text).trim();
    if (!needle) return true;
    if ([r.name, r.purpose, r.iban ?? "", r.reference].some((v) => foldText(v).includes(needle))) return true;
    return !!r.iban && foldText(r.iban).replace(/ /g, "").includes(needle.replace(/ /g, ""));
}

/** What was decided in the review. It lasts as long as file, format and account stay the same. */
export interface ReviewChoice {
    /** Lines of the file left out. */
    excluded: ReadonlySet<number>;
    createCategories: boolean;
    overwriteCategories: boolean;
}

export const NO_CHOICE: ReviewChoice = { excluded: new Set(), createCategories: false, overwriteCategories: false };

/** A row that can be left out, because taking it would change something. */
export const rowSelectable = (r: ReviewRow, overwriteCategories: boolean): boolean => r.state === "new" || rowFills(r) || (overwriteCategories && rowDiffers(r));

/** What the import does with the stored category of a differing row, and if nothing, why. */
export type CategoryChange = "replaced" | "no-overwrite" | "left-out" | "needs-category";

export function categoryChange(r: ReviewRow, choice: ReviewChoice): CategoryChange {
    if (!choice.overwriteCategories) return "no-overwrite";
    if (choice.excluded.has(r.line)) return "left-out";
    return r.categoryId !== null || choice.createCategories ? "replaced" : "needs-category";
}

/** What the import does with the rows that are selected. */
export function reviewOutcome(rows: ReviewRow[], choice: ReviewChoice) {
    const kept = rows.filter((r) => !choice.excluded.has(r.line));
    const differing = kept.filter(rowDiffers);
    const overwrite = choice.overwriteCategories && differing.length > 0;
    // Missing categories of rows that will be written: new ones, and differing ones when overwritten
    const missing = [...new Set(kept.filter((r) => r.newCategory && (r.state === "new" || (overwrite && rowDiffers(r)))).map((r) => r.newCategory!))];
    const create = choice.createCategories && missing.length > 0;
    const takesCategory = (r: ReviewRow) => overwrite && rowDiffers(r) && (r.categoryId !== null || (create && !!r.newCategory));
    const changes = kept.filter(takesCategory).length;
    return {
        differing: differing.length,
        missing,
        overwrite,
        create,
        changes,
        blocked: overwrite && differing.length > changes,
        fresh: kept.filter((r) => r.state === "new").length,
        fills: kept.filter(rowFills).length,
        affected: kept.filter((r) => r.state === "new" || rowFills(r) || takesCategory(r)).length,
        leftOut: rows.filter((r) => choice.excluded.has(r.line) && rowSelectable(r, choice.overwriteCategories)).length,
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
