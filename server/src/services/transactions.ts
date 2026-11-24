import {
    addDaysIso,
    cleanValue,
    formatCents,
    matchTxQuery,
    parseTxQuery,
    todayIso,
    toIsoDate,
    RULE_FIELD_LIMITS,
    type AccountScope,
    type Transaction,
    type TransactionList,
    type TxEdit,
    type TxEditField,
    type TxRange,
} from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { accountsInScope, balanceAt, getAccount, requireAccount, requireOffline } from "./accounts.js";
import { descendantIds, getSlot } from "./categories.js";
import { queryTargets } from "./querytarget.js";

interface TxRow {
    id: number;
    account_id: number;
    booking_date: string;
    value_date: string | null;
    amount: number;
    counterparty_name: string;
    ultimate_party: string;
    counterparty_iban: string | null;
    remittance: string;
    booking_text: string;
    reference: string;
    customer_reference: string;
    bank_reference: string;
    mandate_id: string;
    creditor_id: string;
    counterparty_bic: string;
    counterparty_account: string;
    counterparty_bank_code: string;
    status: "booked" | "pending";
    source: "bank" | "manual" | "import";
    import_id: number | null;
    counter_transaction_id: number | null;
    is_return: number;
    return_reason: string;
    return_of_id: number | null;
    returned_by_id: number | null;
    first_seen_at: string;
    category_id: number | null;
    category_source: "rule" | "manual" | "auto" | null;
    edit_counterparty: string | null;
    edit_counterparty_source: TxEdit["source"] | null;
    edit_remittance: string | null;
    edit_remittance_source: TxEdit["source"] | null;
    /** 1 when new for the user asking; missing where no user asks. */
    unread?: number;
}

const RETURNED_BY = "(SELECT rb.id FROM transactions rb WHERE rb.return_of_id = t.id) AS returned_by_id";

/** Bookings that count in figures: neither a linked return nor the booking it gave back. */
const NOT_RETURNED = "t.return_of_id IS NULL AND NOT EXISTS (SELECT 1 FROM transactions rb WHERE rb.return_of_id = t.id)";

const EDIT_COLUMNS = "ec.value AS edit_counterparty, ec.source AS edit_counterparty_source, er.value AS edit_remittance, er.source AS edit_remittance_source";
const TX_JOINS = `transactions t LEFT JOIN transaction_categories c ON c.transaction_id = t.id
    LEFT JOIN transaction_edits ec ON ec.transaction_id = t.id AND ec.field = 'counterparty'
    LEFT JOIN transaction_edits er ON er.transaction_id = t.id AND er.field = 'remittance'`;

const TX_SELECT = `
    SELECT t.*, ${RETURNED_BY}, c.category_id, c.source AS category_source, ${EDIT_COLUMNS}
    FROM ${TX_JOINS}`;

/** Like TX_SELECT, with `unread` for the user given as the first parameter. */
const TX_SELECT_FOR_USER = `
    SELECT t.*, ${RETURNED_BY}, c.category_id, c.source AS category_source, ${EDIT_COLUMNS},
           EXISTS (SELECT 1 FROM transaction_unread u WHERE u.transaction_id = t.id AND u.user_id = ?) AS unread
    FROM ${TX_JOINS}`;

export const toTransaction = (r: TxRow): Transaction => ({
    id: r.id,
    accountId: r.account_id,
    bookingDate: r.booking_date,
    valueDate: r.value_date,
    amount: r.amount,
    currency: "EUR",
    counterpartyName: r.counterparty_name,
    ultimateParty: r.ultimate_party,
    counterpartyIban: r.counterparty_iban,
    remittance: r.remittance,
    bookingText: r.booking_text,
    reference: r.reference,
    customerReference: r.customer_reference,
    bankReference: r.bank_reference,
    mandateId: r.mandate_id,
    creditorId: r.creditor_id,
    counterpartyBic: r.counterparty_bic,
    counterpartyAccount: r.counterparty_account,
    counterpartyBankCode: r.counterparty_bank_code,
    status: r.status,
    source: r.source,
    importId: r.import_id,
    counterTransactionId: r.counter_transaction_id,
    isReturn: r.is_return === 1,
    returnReason: r.return_reason,
    returnOfId: r.return_of_id,
    returnedById: r.returned_by_id,
    categoryId: r.category_id,
    categorySource: r.category_source,
    createdAt: r.first_seen_at,
    unread: r.unread === 1,
    edits: {
        counterparty: r.edit_counterparty_source ? { value: r.edit_counterparty, source: r.edit_counterparty_source } : null,
        remittance: r.edit_remittance_source ? { value: r.edit_remittance, source: r.edit_remittance_source } : null,
    },
});

export function getTransaction(db: Db, id: number): Transaction {
    const row = db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id) as TxRow | undefined;
    if (!row) throw notFound("Umsatz");
    return toTransaction(row);
}

/** First and last day of a range, relative to `today`. `to` is open for ranges that end today. */
export function rangeBounds(range: TxRange, today = todayIso()): { from: string | null; to: string | null } {
    const [y, m] = today.split("-").map(Number) as [number, number];
    switch (range) {
        case "month":
            return { from: toIsoDate(new Date(y, m - 1, 1)), to: null };
        case "last":
            return { from: toIsoDate(new Date(y, m - 2, 1)), to: toIsoDate(new Date(y, m - 1, 0)) };
        case "30":
            return { from: addDaysIso(today, -29), to: null };
        case "90":
            return { from: addDaysIso(today, -89), to: null };
        case "365":
            return { from: addDaysIso(today, -364), to: null };
        case "all":
            return { from: null, to: null };
    }
}

/** Ids of a category and all its descendants. */
export const categorySubtree = descendantIds;

/** Categories that do not count in figures: excluded ones and everything below them. */
const EXCLUDED_CATEGORIES = `WITH RECURSIVE ex(id) AS (
    SELECT id FROM categories WHERE excluded_from_stats = 1
    UNION SELECT c.id FROM categories c JOIN ex ON c.parent_id = ex.id
) SELECT id FROM ex`;

/** Do bookings without a category count in figures? Not when "Ohne Kategorie" sits below an excluded category. */
function uncategorizedCounts(db: Db): boolean {
    const parent = getSlot(db).parentId;
    if (parent === null) return true;
    return !(db.prepare(`SELECT 1 FROM (${EXCLUDED_CATEGORIES}) WHERE id = ?`).get(parent) as unknown);
}

export interface TxFilter {
    scope: AccountScope;
    range?: TxRange;
    from?: string;
    to?: string;
    q?: string;
    category: string;
    dir: "all" | "in" | "out";
    pending?: boolean;
    limit: number;
}

/** Bookings matching the filter; `unread` and `ist:neu` are those of `userId`. */
export function listTransactions(db: Db, f: TxFilter, userId: number): TransactionList {
    const accountIds = accountsInScope(db, f.scope);
    if (!accountIds.length) return { items: [], total: 0, count: 0, truncated: false };
    const where: string[] = [`t.account_id IN (${accountIds.map(() => "?").join(",")})`];
    const args: unknown[] = [...accountIds];
    const bounds = f.range ? rangeBounds(f.range) : { from: null, to: null };
    const from = f.from ?? bounds.from;
    const to = f.to ?? bounds.to;
    if (from) {
        where.push("t.booking_date >= ?");
        args.push(from);
    }
    if (to) {
        where.push("t.booking_date <= ?");
        args.push(to);
    }
    if (f.category !== "all") {
        const picked = new Set(f.category.split(","));
        const ids = [...new Set([...picked].filter((x) => x !== "none").flatMap((x) => categorySubtree(db, Number(x))))];
        // "Ohne Kategorie" below a picked category belongs to it like a subcategory
        const parent = getSlot(db).parentId;
        const none = picked.has("none") || (parent !== null && ids.includes(parent));
        const parts: string[] = [];
        if (ids.length) parts.push(`c.category_id IN (${ids.map(() => "?").join(",")})`);
        if (none) parts.push("c.category_id IS NULL");
        where.push(`(${parts.join(" OR ")})`);
        args.push(...ids);
    }
    if (f.dir === "in") where.push("t.amount > 0");
    if (f.dir === "out") where.push("t.amount < 0");
    if (f.pending) where.push("t.status = 'pending'");
    let rows = db.prepare(`${TX_SELECT_FOR_USER} WHERE ${where.join(" AND ")} ORDER BY t.booking_date DESC, t.id DESC`).all(userId, ...args) as TxRow[];

    const parsed = f.q ? parseTxQuery(f.q.trim()) : null;
    if (parsed && !parsed.ok) throw badRequest(parsed.error);
    if (parsed?.query) {
        const query = parsed.query;
        const target = queryTargets(db);
        rows = rows.filter((r) => matchTxQuery(query, target(r)));
    }
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return {
        items: rows.slice(0, f.limit).map(toTransaction),
        total,
        count: rows.length,
        truncated: rows.length > f.limit,
    };
}

// ---------- Bookings by hand ----------

export interface ManualInput {
    bookingDate: string;
    valueDate?: string | null;
    amount: number;
    counterpartyName: string;
    counterpartyIban?: string | null;
    remittance: string;
    status: "booked" | "pending";
    categoryId?: number | null;
}

function setCategory(db: Db, txId: number, categoryId: number | null, source: "manual" | "auto"): void {
    db.prepare("DELETE FROM transaction_categories WHERE transaction_id = ?").run(txId);
    if (categoryId === null) return;
    const amount = (db.prepare("SELECT amount FROM transactions WHERE id = ?").get(txId) as { amount: number }).amount;
    db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source) VALUES (?, ?, ?, ?)").run(txId, categoryId, amount, source);
}

function requireCategory(db: Db, id: number): void {
    if (!db.prepare("SELECT id FROM categories WHERE id = ?").get(id)) throw badRequest("Diese Kategorie gibt es nicht.");
}

/** The preset category of counter bookings, if the user keeps one. */
export function counterDefaultCategoryId(db: Db): number | null {
    return (db.prepare("SELECT id FROM categories WHERE counter_default = 1 ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
}

export function createManual(db: Db, accountId: number, input: ManualInput, userId: number | null): Transaction {
    requireOffline(db, accountId);
    if (input.categoryId) requireCategory(db, input.categoryId);
    const id = Number(
        db.prepare(
            `INSERT INTO transactions (account_id, booking_date, value_date, amount, counterparty_name, counterparty_iban, remittance, status, first_seen_at, source, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
        ).run(
            accountId,
            input.bookingDate,
            input.valueDate ?? input.bookingDate,
            input.amount,
            input.counterpartyName,
            input.counterpartyIban || null,
            input.remittance,
            input.status,
            nowIso(),
            userId,
        ).lastInsertRowid,
    );
    // Rules never run on a booking by hand by themselves
    if (input.categoryId != null) setCategory(db, id, input.categoryId, "manual");
    return getTransaction(db, id);
}

function requireManual(db: Db, id: number): Transaction {
    const tx = getTransaction(db, id);
    if (tx.source !== "manual") throw conflict("Nur Buchungen, die von Hand erfasst wurden, lassen sich ändern oder löschen.", "not_manual");
    return tx;
}

export function updateManual(db: Db, id: number, input: Partial<ManualInput>): Transaction {
    const tx = requireManual(db, id);
    if (input.categoryId) requireCategory(db, input.categoryId);
    db.prepare(
        `UPDATE transactions SET booking_date = ?, value_date = ?, amount = ?, counterparty_name = ?, counterparty_iban = ?, remittance = ?, status = ?
         WHERE id = ?`,
    ).run(
        input.bookingDate ?? tx.bookingDate,
        input.valueDate === undefined ? (input.bookingDate ?? tx.valueDate) : input.valueDate,
        input.amount ?? tx.amount,
        input.counterpartyName ?? tx.counterpartyName,
        input.counterpartyIban === undefined ? tx.counterpartyIban : input.counterpartyIban || null,
        input.remittance ?? tx.remittance,
        input.status ?? tx.status,
        id,
    );
    if (input.categoryId !== undefined) setCategory(db, id, input.categoryId, "manual");
    else db.prepare("UPDATE transaction_categories SET amount = ? WHERE transaction_id = ?").run(input.amount ?? tx.amount, id);
    // A new text by hand is what the booking says now; an older adjustment of it is obsolete
    const dropEdit = db.prepare("DELETE FROM transaction_edits WHERE transaction_id = ? AND field = ?");
    if (input.counterpartyName !== undefined && input.counterpartyName !== tx.counterpartyName) dropEdit.run(id, "counterparty");
    if (input.remittance !== undefined && input.remittance !== tx.remittance) dropEdit.run(id, "remittance");
    // A counter booking follows its partner's amount and date
    if (tx.counterTransactionId && (input.amount !== undefined || input.bookingDate !== undefined)) {
        db.prepare("UPDATE transactions SET amount = ?, booking_date = ?, value_date = ? WHERE id = ? AND source = 'manual'").run(
            -(input.amount ?? tx.amount),
            input.bookingDate ?? tx.bookingDate,
            input.bookingDate ?? tx.bookingDate,
            tx.counterTransactionId,
        );
        db.prepare(
            "UPDATE transaction_categories SET amount = ? WHERE transaction_id = ? AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND source = 'manual')",
        ).run(-(input.amount ?? tx.amount), tx.counterTransactionId, tx.counterTransactionId);
    }
    return getTransaction(db, id);
}

export function deleteManual(db: Db, id: number): Transaction {
    const tx = requireManual(db, id);
    // Deleting a counter booking keeps its origin; deleting the origin takes the counter booking along
    if (tx.counterTransactionId) unlinkCounter(db, id, tx.id < tx.counterTransactionId);
    db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    return tx;
}

/** Shows an own text for a field; null shows the bank's value and keeps rules from filling it. */
export function setTransactionEdit(db: Db, id: number, field: TxEditField, value: string | null): Transaction {
    const tx = getTransaction(db, id);
    const bank = field === "counterparty" ? tx.ultimateParty || tx.counterpartyName : tx.remittance;
    const clean = value === null ? null : cleanValue(value, RULE_FIELD_LIMITS[field]);
    if (clean === "") throw badRequest("Bitte einen Text eingeben.");
    db.prepare(
        `INSERT INTO transaction_edits (transaction_id, field, value, source) VALUES (?, ?, ?, 'manual')
         ON CONFLICT (transaction_id, field) DO UPDATE SET value = excluded.value, source = 'manual'`,
    ).run(id, field, clean === bank ? null : clean);
    return getTransaction(db, id);
}

/** Takes back the decision for a field: it shows the bank's value and counts as not set again. */
export function clearTransactionEdit(db: Db, id: number, field: TxEditField): Transaction {
    getTransaction(db, id);
    db.prepare("DELETE FROM transaction_edits WHERE transaction_id = ? AND field = ?").run(id, field);
    return getTransaction(db, id);
}

export function assignCategory(db: Db, ids: number[], categoryId: number | null): number {
    if (categoryId !== null) requireCategory(db, categoryId);
    let changed = 0;
    for (const id of ids) {
        if (!db.prepare("SELECT id FROM transactions WHERE id = ?").get(id)) continue;
        setCategory(db, id, categoryId, "manual");
        changed++;
    }
    return changed;
}

// ---------- Counter bookings ----------

/**
 * Books the opposite amount of `txId` in the offline account `offlineId` (e.g. a cash withdrawal
 * from the current account → cash). Both get `categoryId`; left out, that is the preset category
 * of counter bookings. Without a category the booking keeps its own and the counter booking has none.
 */
export function createCounter(db: Db, txId: number, offlineId: number, userId: number | null, categoryId?: number | null): Transaction {
    const tx = getTransaction(db, txId);
    const target = requireOffline(db, offlineId);
    if (tx.accountId === offlineId) throw badRequest("Die Gegenbuchung muss in einem anderen Konto liegen.");
    if (tx.counterTransactionId) throw conflict("Dieser Umsatz hat schon eine Gegenbuchung.", "has_counter");
    const source = requireAccount(db, tx.accountId);
    if (categoryId) requireCategory(db, categoryId);
    const category = categoryId === undefined ? counterDefaultCategoryId(db) : categoryId;
    const id = Number(
        db.prepare(
            `INSERT INTO transactions (account_id, booking_date, value_date, amount, counterparty_name, remittance, status, first_seen_at, source, counter_transaction_id, created_by)
             VALUES (?, ?, ?, ?, ?, ?, 'booked', ?, 'manual', ?, ?)`,
        ).run(target.id, tx.bookingDate, tx.bookingDate, -tx.amount, source.name, tx.remittance || tx.counterpartyName, nowIso(), tx.id, userId).lastInsertRowid,
    );
    db.prepare("UPDATE transactions SET counter_transaction_id = ? WHERE id = ?").run(id, tx.id);
    if (category !== null) {
        setCategory(db, id, category, "auto");
        setCategory(db, tx.id, category, "auto");
    }
    return getTransaction(db, id);
}

/**
 * Removes the link between a booking and its counter booking. The counter booking is always the
 * younger of the two (the button creates it); it is deleted unless `deleteCounter` is false. The
 * booking it came from loses the category the counter booking gave it, unless either of the two
 * was recategorised since. Rules do not run on it again.
 */
export function unlinkCounter(db: Db, txId: number, deleteCounter = true): void {
    const tx = getTransaction(db, txId);
    if (!tx.counterTransactionId) throw conflict("Dieser Umsatz hat keine Gegenbuchung.", "no_counter");
    const origin = Math.min(tx.id, tx.counterTransactionId);
    const counter = Math.max(tx.id, tx.counterTransactionId);
    db.prepare("UPDATE transactions SET counter_transaction_id = NULL WHERE id IN (?, ?)").run(origin, counter);
    // Both still carry the same automatic category: it came from the counter booking
    db.prepare(
        `DELETE FROM transaction_categories WHERE transaction_id = ? AND source = 'auto'
           AND category_id IN (SELECT category_id FROM transaction_categories WHERE transaction_id = ? AND source = 'auto')`,
    ).run(origin, counter);
    if (deleteCounter) db.prepare("DELETE FROM transactions WHERE id = ? AND source = 'manual'").run(counter);
}

// ---------- Reconcile ----------

export function reconcile(db: Db, accountId: number, date: string, counted: number, userId: number | null): { difference: number; transactionId: number | null } {
    requireOffline(db, accountId);
    const expected = balanceAt(db, accountId, date);
    const difference = counted - expected;
    if (difference === 0) return { difference, transactionId: null };
    const tx = createManual(
        db,
        accountId,
        {
            bookingDate: date,
            amount: difference,
            counterpartyName: "Saldo-Abgleich",
            remittance: `Gezählt ${formatCents(counted)}, erwartet ${formatCents(expected)}`,
            status: "booked",
            categoryId: null,
        },
        userId,
    );
    return { difference, transactionId: tx.id };
}

// ---------- Counterparties used before ----------

export function payees(db: Db, accountId?: number): { name: string; iban: string | null; uses: number }[] {
    const rows = db
        .prepare(
            `SELECT counterparty_name AS name, MAX(counterparty_iban) AS iban, count(*) AS uses, MAX(booking_date) AS last
             FROM transactions WHERE counterparty_name <> '' AND counterparty_name <> 'Saldo-Abgleich' ${accountId ? "AND account_id = ?" : ""}
             GROUP BY counterparty_name COLLATE NOCASE ORDER BY uses DESC, last DESC LIMIT 200`,
        )
        .all(...(accountId ? [accountId] : [])) as { name: string; iban: string | null; uses: number }[];
    return rows.map(({ name, iban, uses }) => ({ name, iban, uses }));
}

// ---------- Figures ----------

const SERIES_MAX_DAYS = 730;

/** Daily balance of the accounts in `scope` for the last `days` days, today included. */
/** Daily end-of-day balance over the last `days` days, or over `range` when given. */
export function balanceSeries(
    db: Db,
    scope: AccountScope,
    days: number,
    range?: TxRange,
    today = todayIso(),
    span?: { from?: string; to?: string },
): { date: string; balance: number }[] {
    const ids = accountsInScope(db, scope);
    const inIds = `account_id IN (${ids.map(() => "?").join(",")})`;
    const firstBooking = () => {
        const first = ids.length ? (db.prepare(`SELECT MIN(booking_date) AS d FROM transactions WHERE ${inIds}`).get(...ids) as { d: string | null }).d : null;
        return first && first < today ? first : addDaysIso(today, -29);
    };
    let from = addDaysIso(today, -(days - 1));
    let to = today;
    if (span && (span.from || span.to)) {
        // A span from the search: open ends run from the first booking to today, at most 730 days
        to = span.to && span.to < today ? span.to : today;
        from = span.from ?? firstBooking();
        if (from < addDaysIso(to, -(SERIES_MAX_DAYS - 1))) from = addDaysIso(to, -(SERIES_MAX_DAYS - 1));
        if (from > to) return [];
    } else if (range) {
        const b = rangeBounds(range, today);
        to = b.to ?? today;
        from = b.from ?? firstBooking();
    }
    const current = ids.reduce((s, id) => s + getAccount(db, id).balance, 0);
    // Bookings after a day lower the balance of that day when going backwards
    const deltas = new Map<string, number>();
    if (ids.length) {
        const rows = db
            .prepare(`SELECT booking_date AS d, SUM(amount) AS s FROM transactions WHERE ${inIds} AND booking_date > ? GROUP BY booking_date`)
            .all(...ids, from) as { d: string; s: number }[];
        for (const r of rows) deltas.set(r.d, r.s);
    }
    let later = 0;
    for (const [d, s] of deltas) if (d > to) later += s;
    const points: { date: string; balance: number }[] = [];
    let balance = current - later;
    for (let date = to; date >= from; date = addDaysIso(date, -1)) {
        points.push({ date, balance });
        balance -= deltas.get(date) ?? 0;
    }
    return points.reverse();
}

export function cashflow(db: Db, scope: AccountScope, from: string, to: string): { income: number; expenses: number; count: number } {
    const ids = accountsInScope(db, scope);
    if (!ids.length) return { income: 0, expenses: 0, count: 0 };
    const none = uncategorizedCounts(db) ? "tc.category_id IS NULL OR " : "";
    const row = db
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS income,
                    COALESCE(SUM(CASE WHEN t.amount < 0 THEN t.amount END), 0) AS expenses,
                    count(*) AS count
             FROM transactions t
             LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
             WHERE t.account_id IN (${ids.map(() => "?").join(",")}) AND t.booking_date BETWEEN ? AND ?
               AND ${NOT_RETURNED}
               AND (${none}tc.category_id NOT IN (${EXCLUDED_CATEGORIES}))`,
        )
        .get(...ids, from, to) as { income: number; expenses: number; count: number };
    return row;
}

export function categorySums(db: Db, scope: AccountScope, from: string, to: string): { categoryId: number | null; amount: number; count: number }[] {
    const ids = accountsInScope(db, scope);
    if (!ids.length) return [];
    return db
        .prepare(
            `SELECT tc.category_id AS categoryId, SUM(t.amount) AS amount, count(*) AS count
             FROM transactions t LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
             WHERE t.account_id IN (${ids.map(() => "?").join(",")}) AND t.booking_date BETWEEN ? AND ?
               AND ${NOT_RETURNED}
             GROUP BY tc.category_id`,
        )
        .all(...ids, from, to) as { categoryId: number | null; amount: number; count: number }[];
}
