import { REST_PART, type FormatStep, type FormatValueRef, type ImportFormatDefinition } from "@mbm/shared";

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

/**
 * Keywords from their texts. A text that stays keeps its part, and so does one edited in its line
 * while the number of lines stays: its field stays assigned while the word is typed.
 */
export function keywordsFrom(texts: string[], current: { text: string; part: string }[]): { text: string; part: string }[] {
    const taken = new Set<string>();
    const lines = [...new Set(texts)];
    const exact = new Set(current.filter((k) => lines.includes(k.text)).map((k) => k.part));
    return lines.map((text, i) => {
        const inLine = lines.length === current.length && !exact.has(current[i]!.part) ? current[i] : undefined;
        const known = current.find((k) => k.text === text) ?? inLine;
        const part = known && !taken.has(known.part) ? known.part : partName(text, [...taken, ...current.map((k) => k.part)]);
        taken.add(part);
        return { text, part };
    });
}

/** Part names from their labels. */
export function partsFrom(names: string[]): string[] {
    const out: string[] = [];
    for (const name of names) out.push(partName(name, out));
    return out;
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
