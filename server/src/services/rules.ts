import { matchTxQuery, parseTxQuery, RULE_PREVIEW_LIMIT, type Rule, type RulePreview, type TxQueryNode, type TxQueryTarget } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { badRequest, notFound } from "../http/errors.js";
import { queryTargets, type QueryRow } from "./querytarget.js";

export interface RuleLike {
    id: number;
    query: string;
    categoryId: number;
    active: boolean;
}

/** A rule with its query parsed once per operation. */
export interface CompiledRule extends RuleLike {
    node: TxQueryNode;
}

/** Parses the active rules; a stored query that no longer parses matches nothing. */
export function compileRules<R extends RuleLike>(rules: R[]): (R & CompiledRule)[] {
    const out: (R & CompiledRule)[] = [];
    for (const r of rules) {
        if (!r.active) continue;
        const parsed = parseTxQuery(r.query, { mode: "rule" });
        if (parsed.ok && parsed.query) out.push({ ...r, node: parsed.query });
    }
    return out;
}

/** The first rule in order that matches, or null. */
export const firstMatch = <R extends CompiledRule>(rules: R[], tx: TxQueryTarget): R | null => rules.find((r) => matchTxQuery(r.node, tx)) ?? null;

interface RuleRow {
    id: number;
    query: string;
    category_id: number;
    position: number;
    active: number;
}

const toRuleLike = (r: RuleRow): RuleLike & { position: number } => ({
    id: r.id,
    query: r.query,
    categoryId: r.category_id,
    active: r.active === 1,
    position: r.position,
});

export const activeRules = (db: Db): CompiledRule[] =>
    compileRules((db.prepare("SELECT * FROM category_rules WHERE active = 1 ORDER BY position, id").all() as RuleRow[]).map(toRuleLike));

interface TxRow extends QueryRow {
    id: number;
}

/** Bookings as rules see them: never with a category, since rules only give one to bookings without. */
const TX_FOR_RULES = "SELECT t.id, t.account_id, t.booking_date, t.amount, t.counterparty_name, t.ultimate_party, t.counterparty_iban, t.remittance, NULL AS category_id FROM transactions t";

/** Bookings the rule's query matches, whether it is active or not. */
const countHits = (rule: RuleLike, txs: TxQueryTarget[]): number => {
    const [compiled] = compileRules([{ ...rule, active: true }]);
    return compiled ? txs.filter((t) => matchTxQuery(compiled.node, t)).length : 0;
};

const ruleTargets = (db: Db): TxQueryTarget[] => (db.prepare(TX_FOR_RULES).all() as TxRow[]).map(queryTargets(db));

export function listRules(db: Db): Rule[] {
    const rules = (db.prepare("SELECT * FROM category_rules ORDER BY position, id").all() as RuleRow[]).map(toRuleLike);
    const txs = ruleTargets(db);
    return rules.map((r) => ({ ...r, hits: countHits(r, txs) }));
}

function requireRule(db: Db, id: number): RuleRow {
    const row = db.prepare("SELECT * FROM category_rules WHERE id = ?").get(id) as RuleRow | undefined;
    if (!row) throw notFound("Regel");
    return row;
}

function requireCategory(db: Db, id: number): void {
    if (!db.prepare("SELECT id FROM categories WHERE id = ?").get(id)) throw badRequest("Diese Kategorie gibt es nicht.");
}

export function createRule(db: Db, input: { query: string; categoryId: number }): number {
    requireCategory(db, input.categoryId);
    const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM category_rules").get() as { p: number }).p;
    return Number(
        db.prepare("INSERT INTO category_rules (query, category_id, position, active, created_at) VALUES (?, ?, ?, 1, ?)").run(input.query, input.categoryId, pos, nowIso())
            .lastInsertRowid,
    );
}

export function updateRule(db: Db, id: number, input: { query?: string; categoryId?: number; active?: boolean }): void {
    const row = requireRule(db, id);
    if (input.categoryId !== undefined) requireCategory(db, input.categoryId);
    db.prepare("UPDATE category_rules SET query = ?, category_id = ?, active = ? WHERE id = ?").run(
        input.query ?? row.query,
        input.categoryId ?? row.category_id,
        input.active === undefined ? row.active : input.active ? 1 : 0,
        id,
    );
}

export function deleteRule(db: Db, id: number): void {
    requireRule(db, id);
    db.prepare("DELETE FROM category_rules WHERE id = ?").run(id);
}

export function orderRules(db: Db, ids: number[]): void {
    const all = new Set((db.prepare("SELECT id FROM category_rules").all() as { id: number }[]).map((r) => r.id));
    if (ids.length !== all.size || ids.some((id) => !all.has(id))) throw badRequest("Die Reihenfolge muss alle Regeln genau einmal nennen.");
    const stmt = db.prepare("UPDATE category_rules SET position = ? WHERE id = ?");
    ids.forEach((id, i) => stmt.run(i, id));
}

export function getRule(db: Db, id: number): Rule {
    const rule = toRuleLike(requireRule(db, id));
    return { ...rule, hits: countHits(rule, ruleTargets(db)) };
}

export interface RuleScope {
    /** Only this rule, whatever its position; it must be active. Missing: the first matching active rule. */
    ruleId?: number;
    /** Only these bookings. Missing: every booking. */
    ids?: number[];
}

/**
 * Bookings without category and the rule that would give them one, newest first. The preview and
 * the assignment both go through here, so they cannot disagree.
 */
function matchUncategorized(db: Db, scope: RuleScope): { row: TxRow; rule: RuleLike }[] {
    let rules: CompiledRule[];
    if (scope.ruleId !== undefined) {
        const rule = toRuleLike(requireRule(db, scope.ruleId));
        if (!rule.active) throw badRequest("Die Regel ist abgeschaltet. Schalte sie ein, um sie anzuwenden.");
        rules = compileRules([rule]);
    } else rules = activeRules(db);
    if (!rules.length) return [];
    const ids = scope.ids;
    const where = ids ? `AND t.id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
    const rows = db
        .prepare(
            `${TX_FOR_RULES}
             WHERE NOT EXISTS (SELECT 1 FROM transaction_categories c WHERE c.transaction_id = t.id) ${where}
             ORDER BY t.booking_date DESC, t.id DESC`,
        )
        .all(...(ids ?? [])) as TxRow[];
    const target = queryTargets(db);
    const out: { row: TxRow; rule: RuleLike }[] = [];
    for (const row of rows) {
        const rule = firstMatch(rules, target(row));
        if (rule) out.push({ row, rule });
    }
    return out;
}

/** What applying the rules would change; nothing is written. */
export function previewRules(db: Db, ruleId?: number): RulePreview {
    const matches = matchUncategorized(db, { ruleId });
    return {
        total: matches.length,
        items: matches.slice(0, RULE_PREVIEW_LIMIT).map(({ row, rule }) => ({
            transactionId: row.id,
            accountId: row.account_id,
            bookingDate: row.booking_date,
            amount: row.amount,
            counterpartyName: row.counterparty_name,
            ultimateParty: row.ultimate_party,
            remittance: row.remittance,
            categoryId: rule.categoryId,
            ruleId: rule.id,
        })),
    };
}

/**
 * Gives bookings without category the category of the matching rule (see `RuleScope`). Bookings
 * that meanwhile got a category or no longer match are left alone.
 */
export function applyRules(db: Db, scope: RuleScope = {}): number {
    const insert = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, 'rule', ?)");
    const matches = matchUncategorized(db, scope);
    for (const { row, rule } of matches) insert.run(row.id, rule.categoryId, row.amount, rule.id);
    return matches.length;
}
