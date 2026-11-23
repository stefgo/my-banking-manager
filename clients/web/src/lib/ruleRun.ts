// The choice on the page "Regeln ausführen": which changes of a checked run get written. Only what
// differs from the preview's own choice is kept and sent.

import type { RuleChangeField, RuleChangeKind, RuleFieldChange, RuleRunItem } from "@mbm/shared";

export type RunFilter = "all" | RuleChangeKind;
export type RunChoice = ReadonlyMap<string, boolean>;
export type RowCheck = "on" | "off" | "partial";

/** A row counts under its weightiest kind of change. */
const RANK: readonly RuleChangeKind[] = ["replace", "reset", "change", "fill"];

const choiceKey = (key: string, field: RuleChangeField): string => `${key}\u0000${field}`;

export const itemKind = (item: RuleRunItem): RuleChangeKind => RANK.find((k) => item.changes.some((c) => c.kind === k))!;

export const isChosen = (item: RuleRunItem, change: RuleFieldChange, choice: RunChoice): boolean => choice.get(choiceKey(item.key, change.field)) ?? change.selected;

export function rowCheck(item: RuleRunItem, choice: RunChoice): RowCheck {
    const on = item.changes.filter((c) => isChosen(item, c, choice)).length;
    return on === 0 ? "off" : on === item.changes.length ? "on" : "partial";
}

export function setChosen(items: readonly RuleRunItem[], on: boolean, choice: RunChoice, field?: RuleChangeField): RunChoice {
    const next = new Map(choice);
    for (const item of items) {
        for (const c of item.changes) {
            if (field && c.field !== field) continue;
            const key = choiceKey(item.key, c.field);
            if (on === c.selected) next.delete(key);
            else next.set(key, on);
        }
    }
    return next;
}

export const toggleRow = (item: RuleRunItem, choice: RunChoice): RunChoice => setChosen([item], rowCheck(item, choice) !== "on", choice);

export function shownState(items: readonly RuleRunItem[], choice: RunChoice): { all: boolean; some: boolean; chosen: number } {
    const chosen = items.filter((i) => rowCheck(i, choice) !== "off").length;
    const all = items.length > 0 && items.every((i) => rowCheck(i, choice) === "on");
    return { all, some: chosen > 0 && !all, chosen };
}

export const toggleShown = (items: readonly RuleRunItem[], choice: RunChoice): RunChoice => setChosen(items, !shownState(items, choice).all, choice);

export function runCounts(items: readonly RuleRunItem[]): Record<RunFilter, number> {
    const counts: Record<RunFilter, number> = { all: items.length, fill: 0, change: 0, replace: 0, reset: 0 };
    for (const item of items) counts[itemKind(item)]++;
    return counts;
}

export function runOutcome(items: readonly RuleRunItem[], choice: RunChoice): { chosen: number; left: number; replaces: number; byKind: Record<RuleChangeKind, number> } {
    const byKind: Record<RuleChangeKind, number> = { fill: 0, change: 0, replace: 0, reset: 0 };
    let chosen = 0;
    let replaces = 0;
    for (const item of items) {
        const picked = item.changes.filter((c) => isChosen(item, c, choice));
        if (!picked.length) continue;
        chosen++;
        replaces += picked.filter((c) => c.kind === "replace").length;
        byKind[RANK.find((k) => picked.some((c) => c.kind === k))!]++;
    }
    return { chosen, left: items.length - chosen, replaces, byKind };
}

/** The choice as the server takes it: only fields that differ from the preview's. */
export function deviationsOf(items: readonly RuleRunItem[], choice: RunChoice): { key: string; field: RuleChangeField; selected: boolean }[] {
    return items.flatMap((item) =>
        item.changes.flatMap((c) => {
            const selected = isChosen(item, c, choice);
            return selected === c.selected ? [] : [{ key: item.key, field: c.field, selected }];
        }),
    );
}

/** After a new check the choice stays for every change that is still the same. */
export function carryChoice(before: readonly RuleRunItem[], after: readonly RuleRunItem[], choice: RunChoice): RunChoice {
    const same = (a: RuleFieldChange, b: RuleFieldChange) => a.kind === b.kind && a.before === b.before && a.after === b.after;
    const old = new Map(before.flatMap((i) => i.changes.map((c) => [choiceKey(i.key, c.field), c] as const)));
    const next = new Map<string, boolean>();
    for (const item of after) {
        for (const c of item.changes) {
            const key = choiceKey(item.key, c.field);
            const previous = old.get(key);
            const picked = choice.get(key);
            if (previous && picked !== undefined && same(previous, c) && picked !== c.selected) next.set(key, picked);
        }
    }
    return next;
}
