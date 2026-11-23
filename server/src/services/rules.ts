// Rules and their runs. The first active rule that hits a booking wins. A run is planned without
// writing anything; the same plan is shown for checking and recomputed when it is taken over, and a
// plan that came out differently is refused. New bookings get the result once when they arrive.

import { createHash } from "node:crypto";
import {
    compileRule,
    compileRules,
    evaluateRule,
    evaluateRules,
    ruleConditionHits,
    ruleIssues,
    type CompiledRule,
    type Rule,
    type RuleBooking,
    type RuleChangeField,
    type RuleDefinition,
    type RuleEdit,
    type RuleExtract,
    type RuleFieldChange,
    type RulePreview,
    type RuleResult,
    type RuleRunItem,
    type RuleRunMode,
    type RuleSample,
    type RuleTestResult,
    type TxEditField,
} from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { queryTargets, type QueryRow } from "./querytarget.js";

export interface StoredRule extends RuleDefinition {
    name: string;
    position: number;
    active: boolean;
    extracts: RuleExtract[];
    edits: RuleEdit[];
    accountIds: number[] | null;
}

export type StoredResult = RuleResult<StoredRule>;

interface RuleRow {
    id: number;
    name: string;
    query: string;
    category_id: number | null;
    extracts: string;
    edits: string;
    all_accounts: number;
    position: number;
    active: number;
}

function loadRules(db: Db, activeOnly = false): StoredRule[] {
    const rows = db.prepare(`SELECT * FROM rules ${activeOnly ? "WHERE active = 1" : ""} ORDER BY position, id`).all() as RuleRow[];
    const chosen = new Map<number, number[]>();
    for (const r of db.prepare("SELECT rule_id, account_id FROM rule_accounts ORDER BY account_id").all() as { rule_id: number; account_id: number }[]) {
        chosen.set(r.rule_id, [...(chosen.get(r.rule_id) ?? []), r.account_id]);
    }
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        query: r.query,
        categoryId: r.category_id,
        // Without accounts left the rule hits nothing; it never turns into "all accounts"
        accountIds: r.all_accounts === 1 ? null : (chosen.get(r.id) ?? []),
        extracts: JSON.parse(r.extracts) as RuleExtract[],
        edits: JSON.parse(r.edits) as RuleEdit[],
        position: r.position,
        active: r.active === 1,
    }));
}

export const activeRules = (db: Db): CompiledRule<StoredRule>[] => compileRules(loadRules(db, true));

/** A booking's bank values; `category_id` stays empty because rules never read stored results. */
export interface BookingRow extends QueryRow {
    booking_text: string;
    reference: string;
    mandate_id: string;
    creditor_id: string;
}

interface RunRow extends BookingRow {
    id: number;
    source: "bank" | "manual" | "import";
    status: "booked" | "pending";
    fingerprint: string | null;
    return_of_id: number | null;
}

const RUN_SELECT = `SELECT t.id, t.account_id, t.booking_date, t.amount, t.counterparty_name, t.ultimate_party, t.counterparty_iban, t.remittance,
    t.booking_text, t.reference, t.mandate_id, t.creditor_id, t.source, t.status, t.fingerprint, t.return_of_id, NULL AS category_id FROM transactions t`;

/** Prepares bookings for the rules; account and category names are loaded once. */
export function ruleBookings(db: Db): (row: BookingRow) => RuleBooking {
    const target = queryTargets(db);
    return (r) => ({
        accountId: r.account_id,
        counterpartyName: r.counterparty_name,
        ultimateParty: r.ultimate_party,
        remittance: r.remittance,
        bookingText: r.booking_text,
        reference: r.reference,
        mandateId: r.mandate_id,
        creditorId: r.creditor_id,
        target: target({ ...r, category_id: null }),
    });
}

const allBookings = (db: Db): RunRow[] => db.prepare(`${RUN_SELECT} ORDER BY t.booking_date DESC, t.id DESC`).all() as RunRow[];

export function listRules(db: Db): Rule[] {
    const rules = loadRules(db);
    const compiled = rules.map((r) => compileRule(r));
    const hits = rules.map(() => 0);
    const wins = rules.map(() => 0);
    const book = ruleBookings(db);
    for (const row of allBookings(db)) {
        const booking = book(row);
        let won = false;
        rules.forEach((rule, i) => {
            const c = compiled[i];
            if (!c || !evaluateRule(c, booking)) return;
            hits[i]!++;
            if (rule.active && !won) {
                wins[i]!++;
                won = true;
            }
        });
    }
    return rules.map((r, i) => ({ ...r, hits: hits[i]!, wins: wins[i]! }));
}

export function getRule(db: Db, id: number): Rule {
    const rule = listRules(db).find((r) => r.id === id);
    if (!rule) throw notFound("Regel");
    return rule;
}

function requireRule(db: Db, id: number): StoredRule {
    const rule = loadRules(db).find((r) => r.id === id);
    if (!rule) throw notFound("Regel");
    return rule;
}

function requireCategory(db: Db, id: number | null | undefined): void {
    if (id != null && !db.prepare("SELECT id FROM categories WHERE id = ?").get(id)) throw badRequest("Diese Kategorie gibt es nicht.");
}

function requireAccounts(db: Db, ids: readonly number[] | null | undefined): void {
    const known = db.prepare("SELECT id FROM accounts WHERE id = ?");
    for (const id of ids ?? []) if (!known.get(id)) throw badRequest("Dieses Konto gibt es nicht.");
}

function setAccounts(db: Db, ruleId: number, accountIds: readonly number[] | null): void {
    db.prepare("UPDATE rules SET all_accounts = ? WHERE id = ?").run(accountIds ? 0 : 1, ruleId);
    db.prepare("DELETE FROM rule_accounts WHERE rule_id = ?").run(ruleId);
    const add = db.prepare("INSERT INTO rule_accounts (rule_id, account_id) VALUES (?, ?)");
    for (const id of new Set(accountIds ?? [])) add.run(ruleId, id);
}

export interface RuleInput {
    name: string;
    query: string;
    categoryId: number | null;
    accountIds: number[] | null;
    extracts: RuleExtract[];
    edits: RuleEdit[];
}

export function createRule(db: Db, input: RuleInput): number {
    requireCategory(db, input.categoryId);
    requireAccounts(db, input.accountIds);
    const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rules").get() as { p: number }).p;
    const id = Number(
        db
            .prepare("INSERT INTO rules (name, query, category_id, extracts, edits, position, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
            .run(input.name, input.query, input.categoryId, JSON.stringify(input.extracts), JSON.stringify(input.edits), pos, nowIso()).lastInsertRowid,
    );
    setAccounts(db, id, input.accountIds);
    return id;
}

export function updateRule(db: Db, id: number, input: Partial<RuleInput> & { active?: boolean }): void {
    const rule = requireRule(db, id);
    requireCategory(db, input.categoryId);
    requireAccounts(db, input.accountIds);
    const next = {
        name: input.name ?? rule.name,
        query: input.query ?? rule.query,
        categoryId: input.categoryId === undefined ? rule.categoryId : input.categoryId,
        extracts: input.extracts ?? rule.extracts,
        edits: input.edits ?? rule.edits,
    };
    // Only the combination tells whether a rule still has an action and every value a source
    const [issue] = ruleIssues(next);
    if (issue) throw badRequest(issue);
    db.prepare("UPDATE rules SET name = ?, query = ?, category_id = ?, extracts = ?, edits = ?, active = ? WHERE id = ?").run(
        next.name,
        next.query,
        next.categoryId,
        JSON.stringify(next.extracts),
        JSON.stringify(next.edits),
        input.active === undefined ? (rule.active ? 1 : 0) : input.active ? 1 : 0,
        id,
    );
    if (input.accountIds !== undefined) setAccounts(db, id, input.accountIds);
}

export function deleteRule(db: Db, id: number): void {
    requireRule(db, id);
    db.prepare("DELETE FROM rules WHERE id = ?").run(id);
}

export function orderRules(db: Db, ids: number[]): void {
    const all = new Set((db.prepare("SELECT id FROM rules").all() as { id: number }[]).map((r) => r.id));
    if (ids.length !== all.size || new Set(ids).size !== ids.length || ids.some((id) => !all.has(id))) throw badRequest("Die Reihenfolge muss alle Regeln genau einmal nennen.");
    const stmt = db.prepare("UPDATE rules SET position = ? WHERE id = ?");
    ids.forEach((id, i) => stmt.run(i, id));
}

// ---------- Trying a draft ----------

const SAMPLE_COUNT = 20;
/** Samples kept for bookings a draft misses, so the misses show next to many hits. */
const MISSED_SAMPLES = 5;

/** What a draft would hit. Rules further up only count on the draft's hits. Writes nothing. */
export function testRule(db: Db, draft: RuleInput & { ruleId?: number | undefined }): RuleTestResult {
    requireAccounts(db, draft.accountIds);
    const all = loadRules(db);
    const own = draft.ruleId === undefined ? -1 : all.findIndex((r) => r.id === draft.ruleId);
    if (draft.ruleId !== undefined && own < 0) throw notFound("Regel");
    const upper = compileRules((own < 0 ? all : all.slice(0, own)).filter((r) => r.active));
    // A draft may not have an action yet; what its condition hits still shows
    const compiled = compileRule({ ...draft, id: draft.ruleId ?? 0, categoryId: draft.categoryId ?? (draft.edits.length ? null : 0) });
    if (!compiled) throw badRequest("Die Regel lässt sich nicht auswerten.");
    const book = ruleBookings(db);
    const result = { matches: 0, hits: 0, missed: 0, wins: 0 };
    const taken = new Map<number, number>();
    const hitSamples: RuleSample[] = [];
    const missSamples: RuleSample[] = [];
    for (const row of allBookings(db)) {
        const booking = book(row);
        if (!ruleConditionHits(compiled, booking)) continue;
        result.matches++;
        const hit = evaluateRule(compiled, booking);
        const base = {
            transactionId: row.id,
            bookingDate: row.booking_date,
            amount: row.amount,
            counterparty: row.ultimate_party || row.counterparty_name,
            remittance: row.remittance,
        };
        if (!hit) {
            result.missed++;
            if (missSamples.length < MISSED_SAMPLES) missSamples.push({ ...base, values: {}, newCounterparty: null, newRemittance: null, hit: false, takenBy: null });
            continue;
        }
        result.hits++;
        const first = evaluateRules(upper, booking);
        if (first) taken.set(first.rule.id, (taken.get(first.rule.id) ?? 0) + 1);
        else result.wins++;
        if (hitSamples.length < SAMPLE_COUNT) hitSamples.push({ ...base, values: hit.values, newCounterparty: hit.counterparty, newRemittance: hit.remittance, hit: true, takenBy: first?.rule.id ?? null });
    }
    return {
        ...result,
        takenBy: [...taken].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count),
        samples: [...hitSamples.slice(0, SAMPLE_COUNT - missSamples.length), ...missSamples],
    };
}

// ---------- A run over stored bookings ----------

interface StoredEdit {
    value: string | null;
    source: "rule" | "manual";
}

interface StoredCategory {
    category_id: number;
    source: string;
}

function editsByBooking(db: Db): Map<number, Partial<Record<TxEditField, StoredEdit>>> {
    const out = new Map<number, Partial<Record<TxEditField, StoredEdit>>>();
    const rows = db.prepare("SELECT transaction_id, field, value, source FROM transaction_edits").all() as ({ transaction_id: number; field: TxEditField } & StoredEdit)[];
    for (const r of rows) out.set(r.transaction_id, { ...out.get(r.transaction_id), [r.field]: { value: r.value, source: r.source } });
    return out;
}

function categoriesByBooking(db: Db): Map<number, StoredCategory[]> {
    const out = new Map<number, StoredCategory[]>();
    const rows = db.prepare("SELECT transaction_id, category_id, source FROM transaction_categories").all() as ({ transaction_id: number } & StoredCategory)[];
    for (const r of rows) out.set(r.transaction_id, [...(out.get(r.transaction_id) ?? []), { category_id: r.category_id, source: r.source }]);
    return out;
}

function textChange(field: TxEditField, bank: string, edit: StoredEdit | undefined, result: string | null, mode: RuleRunMode, manual: boolean): RuleFieldChange | null {
    const before = edit?.value ?? bank;
    const change = (kind: RuleFieldChange["kind"], after: string): RuleFieldChange => ({ field, kind, before, after, selected: !manual && kind !== "replace" });
    if (mode === "empty") return !edit && result !== null ? change("fill", result) : null;
    if (result === null) return edit?.source === "rule" ? change("reset", bank) : null;
    if (!edit) return change("fill", result);
    if (edit.value === result) return null;
    return change(edit.source === "rule" ? "change" : "replace", result);
}

function categoryChange(stored: StoredCategory[], result: number | null, mode: RuleRunMode, manual: boolean, linkedReturn: boolean): RuleFieldChange | null {
    // A split keeps its parts and a linked return the category of its booking
    if (result === null || stored.length > 1 || linkedReturn) return null;
    const current = stored[0];
    const change = (kind: RuleFieldChange["kind"]): RuleFieldChange => ({
        field: "category",
        kind,
        before: current ? String(current.category_id) : null,
        after: String(result),
        selected: !manual && kind !== "replace",
    });
    if (!current) return change("fill");
    if (mode === "empty" || current.category_id === result) return null;
    return change(current.source === "rule" ? "change" : "replace");
}

/** Pending bookings of the bank get a new id at every fetch, so they go by account and fingerprint. */
const stableKey = (r: RunRow): string => (r.source === "bank" && r.status === "pending" && r.fingerprint ? `p:${r.account_id}:${r.fingerprint}` : `t:${r.id}`);

interface RulePlan extends RulePreview {
    /** The winning result per booking, for writing the rule of a category. */
    amounts: Map<number, number>;
}

/** Every change of a run; writes nothing. With `ruleId` only the bookings that rule wins. */
export function planRuleRun(db: Db, ruleId: number | undefined, mode: RuleRunMode): RulePlan {
    if (ruleId !== undefined && !requireRule(db, ruleId).active) throw badRequest("Die Regel ist abgeschaltet. Schalte sie ein, um sie auszuführen.");
    const rules = activeRules(db);
    const edits = editsByBooking(db);
    const categories = categoriesByBooking(db);
    const book = ruleBookings(db);
    const items: RuleRunItem[] = [];
    const amounts = new Map<number, number>();
    let unchanged = 0;
    for (const row of allBookings(db)) {
        const result = evaluateRules(rules, book(row));
        if (ruleId !== undefined && result?.rule.id !== ruleId) continue;
        const manual = row.source === "manual";
        const stored = categories.get(row.id) ?? [];
        const edit = edits.get(row.id);
        const party = row.ultimate_party || row.counterparty_name;
        const changes = [
            textChange("counterparty", party, edit?.counterparty, result?.counterparty ?? null, mode, manual),
            textChange("remittance", row.remittance, edit?.remittance, result?.remittance ?? null, mode, manual),
            categoryChange(stored, result?.categoryId ?? null, mode, manual, row.return_of_id !== null),
        ].filter((c): c is RuleFieldChange => c !== null);
        if (!changes.length) {
            unchanged++;
            continue;
        }
        amounts.set(row.id, row.amount);
        items.push({
            key: stableKey(row),
            transactionId: row.id,
            accountId: row.account_id,
            bookingDate: row.booking_date,
            amount: row.amount,
            counterparty: party,
            remittance: row.remittance,
            manual,
            split: stored.length > 1,
            ruleId: result?.rule.id ?? null,
            changes,
        });
    }
    // By key, so that a fetch that only brings the same pending bookings again changes nothing
    const lines = items.flatMap((i) => i.changes.map((c) => JSON.stringify([i.key, c.field, c.kind, c.before, c.after, c.selected]))).sort();
    const planHash = createHash("sha256").update(JSON.stringify([ruleId ?? null, mode, lines])).digest("hex");
    return { items, unchanged, planHash, amounts };
}

export function previewRules(db: Db, ruleId: number | undefined, mode: RuleRunMode): RulePreview {
    const { items, unchanged, planHash } = planRuleRun(db, ruleId, mode);
    return { items, unchanged, planHash };
}

export interface ApplyInput {
    ruleId?: number | undefined;
    mode: RuleRunMode;
    planHash: string;
    deviations: { key: string; field: RuleChangeField; selected: boolean }[];
}

/** Writes the chosen changes of a checked plan; call inside a transaction. */
export function commitRuleRun(db: Db, input: ApplyInput): number {
    const plan = planRuleRun(db, input.ruleId, input.mode);
    if (plan.planHash !== input.planHash) throw conflict("Das Ergebnis hat sich seit der Prüfung geändert. Bitte prüfe es erneut.", "rule_plan_stale");
    const choice = new Map(input.deviations.map((d) => [`${d.key}\u0000${d.field}`, d.selected]));
    const known = new Set(plan.items.flatMap((i) => i.changes.map((c) => `${i.key}\u0000${c.field}`)));
    for (const key of choice.keys()) if (!known.has(key)) throw badRequest("Die Auswahl passt nicht zur Prüfung.");
    const writeEdit = db.prepare(
        `INSERT INTO transaction_edits (transaction_id, field, value, source) VALUES (?, ?, ?, 'rule')
         ON CONFLICT (transaction_id, field) DO UPDATE SET value = excluded.value, source = 'rule'`,
    );
    const dropEdit = db.prepare("DELETE FROM transaction_edits WHERE transaction_id = ? AND field = ?");
    const dropCategory = db.prepare("DELETE FROM transaction_categories WHERE transaction_id = ?");
    const addCategory = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, 'rule', ?)");
    let changed = 0;
    for (const item of plan.items) {
        let wrote = false;
        for (const c of item.changes) {
            if (!(choice.get(`${item.key}\u0000${c.field}`) ?? c.selected)) continue;
            wrote = true;
            if (c.field === "category") {
                dropCategory.run(item.transactionId);
                addCategory.run(item.transactionId, Number(c.after), plan.amounts.get(item.transactionId), item.ruleId);
            } else if (c.kind === "reset") dropEdit.run(item.transactionId, c.field);
            else writeEdit.run(item.transactionId, c.field, c.after);
        }
        if (wrote) changed++;
    }
    return changed;
}

// ---------- New bookings ----------

/** The result of the rules for new bookings, by id; nothing is written yet. */
export function evaluateNew(db: Db, ids: readonly number[]): Map<number, StoredResult> {
    const out = new Map<number, StoredResult>();
    if (!ids.length) return out;
    const rules = activeRules(db);
    if (!rules.length) return out;
    const book = ruleBookings(db);
    const stmt = db.prepare(`${RUN_SELECT} WHERE t.id = ?`);
    for (const id of ids) {
        const row = stmt.get(id) as RunRow | undefined;
        if (!row) continue;
        const result = evaluateRules(rules, book(row));
        if (result) out.set(id, result);
    }
    return out;
}

/** Gives bookings without a category the one of their rule, except those in `skip`. */
export function writeRuleCategories(db: Db, results: ReadonlyMap<number, StoredResult>, skip: ReadonlySet<number> = new Set()): void {
    const insert = db.prepare(
        `INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id)
         SELECT t.id, ?, t.amount, 'rule', ? FROM transactions t
         WHERE t.id = ? AND NOT EXISTS (SELECT 1 FROM transaction_categories c WHERE c.transaction_id = t.id)`,
    );
    for (const [id, r] of results) if (r.categoryId !== null && !skip.has(id)) insert.run(r.categoryId, r.rule.id, id);
}

/** Stores the texts of the rules where a field has no value yet. */
export function writeRuleTexts(db: Db, results: ReadonlyMap<number, StoredResult>): void {
    const insert = db.prepare("INSERT OR IGNORE INTO transaction_edits (transaction_id, field, value, source) VALUES (?, ?, ?, 'rule')");
    for (const [id, r] of results) {
        if (r.counterparty !== null) insert.run(id, "counterparty", r.counterparty);
        if (r.remittance !== null) insert.run(id, "remittance", r.remittance);
    }
}
