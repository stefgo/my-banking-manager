// Suggestions while typing a search or a rule: field names of the search syntax, and after
// "kategorie:" or "konto:" the names of categories or accounts, after "ist:" its values.

import { foldText, quoteTxQueryValue, TX_QUERY_FIELDS, TX_QUERY_FLAGS } from "@mbm/shared";

export interface Suggestion {
    label: string;
    hint?: string;
    /** Text that replaces the word at the cursor. */
    insert: string;
}

export interface SuggestResult {
    /** The word at the cursor that a suggestion replaces. */
    from: number;
    to: number;
    items: Suggestion[];
}

export interface SuggestContext {
    categories: readonly string[];
    accounts: readonly string[];
    /** "rule": no "kategorie:" and no "ist:", as rules cannot use them. */
    mode?: "search" | "rule";
}

const FIELD_HINTS: Record<string, string> = {
    gegenseite: "Name der Gegenseite",
    name: "wie gegenseite:",
    zweck: "Verwendungszweck",
    verwendungszweck: "wie zweck:",
    iban: "IBAN der Gegenseite",
    konto: "eigenes Konto",
    kategorie: "Kategorie",
    kat: "wie kategorie:",
    betrag: "z. B. betrag>50",
    datum: "z. B. datum:3.2026",
    ist: "ist:neu – neue Umsätze",
};

/** Fields rules cannot use. */
const SEARCH_ONLY = new Set(["category", "flag"]);

const MAX = 8;

export function suggest(text: string, caret: number, ctx: SuggestContext): SuggestResult | null {
    const word = /[^\s()]*$/.exec(text.slice(0, caret))![0];
    const rest = /^[^\s()]*/.exec(text.slice(caret))![0];
    if (!word) return null;
    const from = caret - word.length;
    const to = caret + rest.length;
    const colon = word.indexOf(":");

    if (colon < 0) {
        // Only plain lower-case words: "UND", "ODER", "NICHT" and amounts stay quiet
        if (!/^[a-zäöü]+$/.test(word)) return null;
        const items = Object.keys(TX_QUERY_FIELDS)
            .filter((f) => f.startsWith(word) && !(ctx.mode === "rule" && SEARCH_ONLY.has(TX_QUERY_FIELDS[f]!)))
            .map((f) => ({ label: `${f}:`, hint: FIELD_HINTS[f], insert: `${f}:` }));
        return items.length ? { from, to, items } : null;
    }

    const kind = TX_QUERY_FIELDS[word.slice(0, colon).toLowerCase()];
    const searchOnly = ctx.mode !== "rule";
    const names = kind === "category" && searchOnly ? ctx.categories : kind === "flag" && searchOnly ? TX_QUERY_FLAGS : kind === "account" ? ctx.accounts : null;
    if (!names) return null;
    const field = word.slice(0, colon);
    const typed = foldText(word.slice(colon + 1).replace(/^"/, ""));
    const unique = [...new Set(names)];
    const starts = unique.filter((n) => foldText(n).startsWith(typed));
    const contains = unique.filter((n) => !foldText(n).startsWith(typed) && foldText(n).includes(typed));
    const items = [...starts, ...contains].slice(0, MAX).map((n) => ({
        label: n,
        insert: `${field}:${/^[^\s"()]+$/.test(n) ? n : quoteTxQueryValue(n)} `,
    }));
    // Nothing to offer once the value is written out in full
    if (items.length === 1 && foldText(items[0]!.label) === typed) return null;
    return items.length ? { from, to, items } : null;
}

/** The text after taking a suggestion, and where the cursor goes. */
export function applySuggestion(text: string, result: SuggestResult, s: Suggestion): { text: string; caret: number } {
    const next = text.slice(0, result.from) + s.insert + text.slice(result.to);
    return { text: next, caret: result.from + s.insert.length };
}
