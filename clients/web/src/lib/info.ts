// Own information (label/value pairs and a note) of accounts, groups and categories: the rows of
// the edit dialog and what goes back to the server.

import type { Info } from "@mbm/shared";

export type InfoTarget = "account" | "group" | "category";

/** A row of the edit dialog; `id` keeps React keys stable while rows move. */
export interface InfoRow {
    id: number;
    key: string;
    value: string;
}

export const hasInfo = (info: Info): boolean => info.attributes.length > 0 || info.notes.trim() !== "";

let nextId = 1;
export const newRow = (key = "", value = ""): InfoRow => ({ id: nextId++, key, value });

export const rowsOf = (info: Info): InfoRow[] => info.attributes.map((a) => newRow(a.key, a.value));

/**
 * What the dialog saves: rows without label and value are dropped, a value without a label and a
 * label used twice (case ignored) are errors, keyed by row id.
 */
export function infoFromRows(rows: InfoRow[], notes: string): { info: Info; errors: Record<number, string> } {
    const errors: Record<number, string> = {};
    const seen = new Set<string>();
    const attributes: Info["attributes"] = [];
    for (const r of rows) {
        const key = r.key.trim();
        const value = r.value.trim();
        if (!key && !value) continue;
        if (!key) {
            errors[r.id] = "Bitte eine Bezeichnung eingeben.";
            continue;
        }
        const k = key.toLocaleLowerCase("de");
        if (seen.has(k)) errors[r.id] = `„${key}“ gibt es schon.`;
        seen.add(k);
        attributes.push({ key, value });
    }
    return { info: { attributes, notes: notes.replace(/\s+$/, "") }, errors };
}

/** Moves the row at `from` to `to`. */
export function moveRow<T>(rows: T[], from: number, to: number): T[] {
    if (from === to || to < 0 || to >= rows.length) return rows;
    const out = [...rows];
    const [r] = out.splice(from, 1);
    out.splice(to, 0, r!);
    return out;
}

/** Labels used elsewhere, sorted, without those in `taken`. */
export function labelSuggestions(infos: Info[], taken: string[]): string[] {
    const skip = new Set(taken.map((k) => k.trim().toLocaleLowerCase("de")));
    const out = new Map<string, string>();
    for (const info of infos) {
        for (const a of info.attributes) {
            const k = a.key.toLocaleLowerCase("de");
            if (!skip.has(k) && !out.has(k)) out.set(k, a.key);
        }
    }
    return [...out.values()].sort((a, b) => a.localeCompare(b, "de"));
}
