// What a rule does to a booking. Rules run from top to bottom and the first one that hits wins: its
// account fits, its query matches and every value its actions need was found. Conditions and
// extracts read the bank's values only, so the same booking gives the same result for the same
// rules, whatever is stored. Pure functions, shared by the server and the web client.

import { partKey, REST_PART, runKeywords, runSeparator } from "./importFormat.js";
import type { RuleEdit, RuleExtract, RuleSourceField } from "./schemas/banking.js";
import { cleanValue, parsePattern, parseTemplate, renderTemplate, runPattern, type PatternPart, type TemplatePart } from "./textExtract.js";
import { matchTxQuery, parseTxQuery, type TxQueryNode, type TxQueryTarget } from "./txquery.js";

export const RULE_MAX_EXTRACTS = 5;
export const RULE_MAX_EDITS = 10;
/** Longest stored texts, as for bookings by hand. */
export const RULE_FIELD_LIMITS = { counterparty: 140, remittance: 400 } as const;
/** Names a template can always use; they and `rest` cannot name a piece of a step. */
export const RULE_BUILTIN_VALUES = ["gegenseite", "zweck", "umsatzart"] as const;
const RESERVED = new Set<string>([...RULE_BUILTIN_VALUES, REST_PART]);

/** The bank's values of a booking, as conditions and extracts read them. */
export interface RuleBooking {
    accountId: number;
    counterpartyName: string;
    ultimateParty: string;
    remittance: string;
    bookingText: string;
    reference: string;
    mandateId: string;
    creditorId: string;
    target: TxQueryTarget;
}

export interface RuleDefinition {
    id: number;
    query: string;
    categoryId: number | null;
    /** null: every account. */
    accountIds: readonly number[] | null;
    extracts: readonly RuleExtract[];
    edits: readonly RuleEdit[];
}

type CompiledExtract = RuleExtract & { parsed?: readonly PatternPart[] };
type CompiledEdit =
    | { op: "set"; field: RuleEdit["field"]; template: readonly TemplatePart[] }
    | { op: "remove"; field: RuleEdit["field"]; text: string }
    | { op: "replace"; field: RuleEdit["field"]; text: string; template: readonly TemplatePart[] };

export interface CompiledRule<R extends RuleDefinition = RuleDefinition> {
    rule: R;
    node: TxQueryNode;
    accounts: ReadonlySet<number> | null;
    extracts: readonly CompiledExtract[];
    edits: readonly CompiledEdit[];
    /** Pieces a later step or a template reads; the others stay in the rest of their step. */
    used: ReadonlySet<string>;
    needed: readonly string[];
}

export interface RuleResult<R extends RuleDefinition = RuleDefinition> {
    rule: R;
    categoryId: number | null;
    /** The new text; null where the rule leaves the bank's value. */
    counterparty: string | null;
    remittance: string | null;
    /** Every value the rule found, for the sample in the rule form. */
    values: Record<string, string>;
}

const piecesOf = (e: RuleExtract, parts: readonly PatternPart[] | undefined): string[] => {
    if (e.type === "pattern") return (parts ?? []).flatMap((p) => (p.k === "slot" ? [p.name] : []));
    return e.type === "separator" ? e.parts : e.keywords.map((k) => k.part);
};

const templatesOf = (e: RuleEdit): string[] => (e.op === "set" ? [e.value] : e.op === "replace" ? [e.with] : []);

/** What is wrong with the extracts and actions of a rule, in words for the user; empty when sound. */
export function ruleIssues(rule: { categoryId?: number | null; extracts: readonly RuleExtract[]; edits: readonly RuleEdit[] }): string[] {
    const issues: string[] = [];
    if (rule.categoryId == null && !rule.edits.length) issues.push("Die Regel braucht mindestens eine Aktion.");
    const steps = new Map<string, Set<string>>();
    const names = new Set<string>();
    rule.extracts.forEach((e, i) => {
        const where = `Stufe ${i + 1}`;
        if (steps.has(e.id)) issues.push(`${where}: Die Kennung „${e.id}“ gibt es schon.`);
        if ("step" in e.input) {
            const known = steps.get(e.input.step);
            if (!known) issues.push(`${where} liest aus einer unbekannten Stufe.`);
            else if (e.input.part !== REST_PART && !known.has(e.input.part)) issues.push(`${where} liest den unbekannten Ausschnitt „${e.input.part}“.`);
        }
        let parts: readonly PatternPart[] | undefined;
        if (e.type === "pattern") {
            const parsed = parsePattern(e.pattern);
            if (parsed.ok) parts = parsed.parts;
            else issues.push(`${where}: ${parsed.error}`);
        }
        const pieces = piecesOf(e, parts);
        for (const name of pieces) {
            if (RESERVED.has(name)) issues.push(`${where}: Der Name „${name}“ ist reserviert.`);
            else if (names.has(name)) issues.push(`${where}: Den Namen „${name}“ gibt es schon.`);
            names.add(name);
        }
        steps.set(e.id, new Set(pieces));
    });
    rule.edits.forEach((edit, i) => {
        const where = `Aktion ${i + 1}`;
        for (const src of templatesOf(edit)) {
            const parsed = parseTemplate(src);
            if (!parsed.ok) {
                issues.push(`${where}: ${parsed.error}`);
                continue;
            }
            for (const p of parsed.parts) {
                if (p.k !== "value" || names.has(p.name) || (RULE_BUILTIN_VALUES as readonly string[]).includes(p.name)) continue;
                issues.push(p.name === REST_PART ? `${where}: Der Rest lässt sich nicht einsetzen.` : `${where}: Den Ausschnitt „${p.name}“ gibt es nicht.`);
            }
        }
    });
    return issues;
}

/** Prepares a rule once per operation; null when a stored rule no longer reads, it then hits nothing. */
export function compileRule<R extends RuleDefinition>(rule: R): CompiledRule<R> | null {
    const query = parseTxQuery(rule.query, { mode: "rule" });
    if (!query.ok || !query.query || ruleIssues(rule).length) return null;
    const extracts: CompiledExtract[] = rule.extracts.map((e) => {
        if (e.type !== "pattern") return e;
        const p = parsePattern(e.pattern);
        return { ...e, parsed: p.ok ? p.parts : [] };
    });
    const template = (src: string): TemplatePart[] => {
        const t = parseTemplate(src);
        return t.ok ? t.parts : [];
    };
    const edits = rule.edits.map((e): CompiledEdit => {
        if (e.op === "set") return { op: "set", field: e.field, template: template(e.value) };
        if (e.op === "remove") return { op: "remove", field: e.field, text: e.text };
        return { op: "replace", field: e.field, text: e.text, template: template(e.with) };
    });
    const needed = [...new Set(edits.flatMap((e) => (e.op === "remove" ? [] : e.template.flatMap((p) => (p.k === "value" ? [p.name] : [])))))];
    const stepOf = new Map(extracts.flatMap((e) => piecesOf(e, e.parsed).map((n) => [n, e.id] as const)));
    const used = new Set<string>();
    for (const n of needed) if (stepOf.has(n)) used.add(partKey(stepOf.get(n)!, n));
    for (const e of extracts) if ("step" in e.input && e.input.part !== REST_PART) used.add(partKey(e.input.step, e.input.part));
    return { rule, node: query.query, accounts: rule.accountIds ? new Set(rule.accountIds) : null, extracts, edits, used, needed };
}

export const compileRules = <R extends RuleDefinition>(rules: readonly R[]): CompiledRule<R>[] => rules.flatMap((r) => compileRule(r) ?? []);

function sourceText(b: RuleBooking, field: RuleSourceField): string {
    switch (field) {
        case "party":
            return b.ultimateParty || b.counterpartyName;
        case "ultimateParty":
            return b.ultimateParty;
        case "counterpartyName":
            return b.counterpartyName;
        case "remittance":
            return b.remittance;
        case "bookingText":
            return b.bookingText;
        case "reference":
            return b.reference;
        case "mandateId":
            return b.mandateId;
        case "creditorId":
            return b.creditorId;
    }
}

/** All values of the steps: pieces by name, and every piece by step for later steps. */
function runExtracts(c: CompiledRule, b: RuleBooking): { named: Map<string, string>; byPart: Map<string, string> } {
    const named = new Map<string, string>();
    const byPart = new Map<string, string>();
    for (const e of c.extracts) {
        const text = "field" in e.input ? sourceText(b, e.input.field) : (byPart.get(partKey(e.input.step, e.input.part)) ?? "");
        const isUsed = (part: string) => c.used.has(partKey(e.id, part));
        if (e.type === "keywords") runKeywords(text, e, isUsed, byPart);
        else if (e.type === "separator") runSeparator(text, e, isUsed, byPart);
        else {
            const m = runPattern(e.parsed ?? [], text);
            if (m) {
                for (const [name, value] of m.values) byPart.set(partKey(e.id, name), value);
                byPart.set(partKey(e.id, REST_PART), `${text.slice(0, m.start)} ${text.slice(m.end)}`.trim());
            }
        }
        for (const name of piecesOf(e, e.parsed)) {
            const value = byPart.get(partKey(e.id, name));
            if (value) named.set(name, value);
        }
    }
    return { named, byPart };
}

/** Replaces or removes fixed text whatever its case; `with` is inserted as it is. */
function replaceText(value: string, text: string, by: string): string {
    if (!text) return value;
    const lower = value.toLowerCase();
    const needle = text.toLowerCase();
    // Lower case can change the length of a few characters; such a text is compared exactly
    const [hay, find] = lower.length === value.length && needle.length === text.length ? [lower, needle] : [value, text];
    let out = "";
    let from = 0;
    for (let at = hay.indexOf(find); at >= 0; at = hay.indexOf(find, from)) {
        out += value.slice(from, at) + by;
        from = at + find.length;
    }
    return out + value.slice(from);
}

function applyEdits(c: CompiledRule, field: RuleEdit["field"], bank: string, value: (name: string) => string | undefined): string | null {
    let current = bank;
    for (const e of c.edits) {
        if (e.field !== field) continue;
        let next: string;
        if (e.op === "remove") next = replaceText(current, e.text, "");
        else {
            const filled = renderTemplate(e.template, value);
            if (filled === null) return null;
            next = e.op === "set" ? filled : replaceText(current, e.text, filled);
        }
        // A step that leaves nothing is skipped, the value before it stays
        const clean = cleanValue(next, RULE_FIELD_LIMITS[field]);
        if (clean) current = clean;
    }
    return current;
}

/** Does a rule's account and query fit this booking? */
export const ruleConditionHits = (c: CompiledRule, b: RuleBooking): boolean => (!c.accounts || c.accounts.has(b.accountId)) && matchTxQuery(c.node, b.target);

/** The result of one rule; null when it does not hit. */
export function evaluateRule<R extends RuleDefinition>(c: CompiledRule<R>, b: RuleBooking): RuleResult<R> | null {
    if (!ruleConditionHits(c, b)) return null;
    const { named } = runExtracts(c, b);
    const party = b.ultimateParty || b.counterpartyName;
    const builtin: Record<string, string> = { gegenseite: party, zweck: b.remittance, umsatzart: b.bookingText };
    const value = (name: string) => named.get(name) ?? (Object.hasOwn(builtin, name) ? builtin[name] : undefined);
    // A value an action needs is missing or empty: the rule does not hit at all
    if (c.needed.some((n) => !value(n))) return null;
    const hasEdit = (field: RuleEdit["field"]) => c.edits.some((e) => e.field === field);
    const result = (field: RuleEdit["field"], bank: string): string | null => {
        if (!hasEdit(field)) return null;
        const out = applyEdits(c, field, bank, value);
        return out === null || foldExact(out) === foldExact(bank) ? null : out;
    };
    return {
        rule: c.rule,
        categoryId: c.rule.categoryId,
        counterparty: result("counterparty", party),
        remittance: result("remittance", b.remittance),
        values: Object.fromEntries(named),
    };
}

/** Texts count as equal when only surrounding or repeated spaces differ. */
const foldExact = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The first rule that hits, with its result; later rules are not looked at. */
export function evaluateRules<R extends RuleDefinition>(rules: readonly CompiledRule<R>[], b: RuleBooking): RuleResult<R> | null {
    for (const c of rules) {
        const r = evaluateRule(c, b);
        if (r) return r;
    }
    return null;
}
