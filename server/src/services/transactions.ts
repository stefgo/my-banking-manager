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
import { accountsInScope, balanceAt, getAccount, keepBankBalance, requireAccount, requireOffline } from "./accounts.js";
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
    funding_of_id: number | null;
    funded_by_id: number | null;
    first_seen_at: string;
    deleted_at: string | null;
    original_amount: number | null;
    original_booking_date: string | null;
    category_id: number | null;
    category_source: "rule" | "manual" | "auto" | null;
    edit_counterparty: string | null;
    edit_counterparty_source: TxEdit["source"] | null;
    edit_remittance: string | null;
    edit_remittance_source: TxEdit["source"] | null;
    /** 1 when new for the user asking; missing where no user asks. */
    unread?: number;
}

const RETURNED_BY = "(SELECT rb.id FROM transactions rb WHERE rb.return_of_id = t.id AND rb.deleted_at IS NULL) AS returned_by_id";
/** The booking MBM added for where the money of a PayPal payment came from. */
const FUNDED_BY = "(SELECT fb.id FROM transactions fb WHERE fb.funding_of_id = t.id AND fb.deleted_at IS NULL ORDER BY fb.id LIMIT 1) AS funded_by_id";

/** Bookings left out of lists and figures: those the user deleted. */
export const LIVE = "deleted_at IS NULL";

/**
 * Bookings that count in figures: neither a linked return nor the booking it gave back. A pair
 * whose other half was deleted counts again.
 */
const NOT_RETURNED =
    "NOT EXISTS (SELECT 1 FROM transactions ro WHERE ro.id = t.return_of_id AND ro.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM transactions rb WHERE rb.return_of_id = t.id AND rb.deleted_at IS NULL)";

const EDIT_COLUMNS = "ec.value AS edit_counterparty, ec.source AS edit_counterparty_source, er.value AS edit_remittance, er.source AS edit_remittance_source";
// One row per booking: a split booking shows its largest share
const TX_JOINS = `transactions t
    LEFT JOIN transaction_categories c ON c.rowid = (
        SELECT x.rowid FROM transaction_categories x WHERE x.transaction_id = t.id ORDER BY abs(x.amount) DESC, x.category_id LIMIT 1)
    LEFT JOIN transaction_edits ec ON ec.transaction_id = t.id AND ec.field = 'counterparty'
    LEFT JOIN transaction_edits er ON er.transaction_id = t.id AND er.field = 'remittance'`;

const TX_SELECT = `
    SELECT t.*, ${RETURNED_BY}, ${FUNDED_BY}, c.category_id, c.source AS category_source, ${EDIT_COLUMNS}
    FROM ${TX_JOINS}`;

/** Like TX_SELECT, with `unread` for the user given as the first parameter. */
const TX_SELECT_FOR_USER = `
    SELECT t.*, ${RETURNED_BY}, ${FUNDED_BY}, c.category_id, c.source AS category_source, ${EDIT_COLUMNS},
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
    fundingOfId: r.funding_of_id,
    fundedById: r.funded_by_id,
    categoryId: r.category_id,
    categorySource: r.category_source,
    createdAt: r.first_seen_at,
    unread: r.unread === 1,
    edits: {
        counterparty: r.edit_counterparty_source ? { value: r.edit_counterparty, source: r.edit_counterparty_source } : null,
        remittance: r.edit_remittance_source ? { value: r.edit_remittance, source: r.edit_remittance_source } : null,
    },
    original: r.original_amount !== null && r.original_booking_date !== null ? { amount: r.original_amount, bookingDate: r.original_booking_date } : null,
    deletedAt: r.deleted_at,
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
    /** Only the deleted bookings, which are left out otherwise. */
    deleted?: boolean;
    limit: number;
}

/** Bookings matching the filter; `unread` and `ist:neu` are those of `userId`. */
export function listTransactions(db: Db, f: TxFilter, userId: number): TransactionList {
    const accountIds = accountsInScope(db, f.scope);
    if (!accountIds.length) return { items: [], total: 0, count: 0, truncated: false };
    const where: string[] = [`t.account_id IN (${accountIds.map(() => "?").join(",")})`, f.deleted ? "t.deleted_at IS NOT NULL" : "t.deleted_at IS NULL"];
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
        // A split booking belongs to every category it has a share in
        if (ids.length) parts.push(`EXISTS (SELECT 1 FROM transaction_categories x WHERE x.transaction_id = t.id AND x.category_id IN (${ids.map(() => "?").join(",")}))`);
        if (none) parts.push("NOT EXISTS (SELECT 1 FROM transaction_categories x WHERE x.transaction_id = t.id)");
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

/**
 * Books by hand. On an account with a bank balance the balance stays the bank's: the booking only
 * changes the history before it (as an import does). A fetch later takes it over when the bank
 * delivers the same booking.
 */
export function createManual(db: Db, accountId: number, input: ManualInput, userId: number | null): Transaction {
    requireAccount(db, accountId);
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
    keepBankBalance(db, accountId, input.amount);
    return getTransaction(db, id);
}

function requireLive(tx: Transaction): void {
    if (tx.deletedAt) throw conflict("Dieser Umsatz ist gelöscht. Stelle ihn zuerst wieder her.", "deleted");
}

/** Fields only a booking entered by hand can change; of all others only amount and booking date. */
const MANUAL_ONLY = ["valueDate", "counterpartyName", "counterpartyIban", "remittance", "status", "categoryId"] as const;

/** A single share follows the new amount; the shares of a split stay as they are. */
export function followAmount(db: Db, id: number, amount: number): void {
    db.prepare(
        "UPDATE transaction_categories SET amount = @amount WHERE transaction_id = @id AND (SELECT count(*) FROM transaction_categories WHERE transaction_id = @id) = 1",
    ).run({ amount, id });
}

/**
 * Gives a booking from the bank, an import or MBM the amount and booking date that count. The
 * values it came with are kept as the original once one of them differs, and go again when both
 * are the same as the original.
 */
export function setCountingValues(db: Db, id: number, amount: number, bookingDate: string): void {
    const row = db.prepare("SELECT amount, booking_date, original_amount, original_booking_date FROM transactions WHERE id = ?").get(id) as {
        amount: number;
        booking_date: string;
        original_amount: number | null;
        original_booking_date: string | null;
    };
    const originalAmount = row.original_amount ?? row.amount;
    const originalDate = row.original_booking_date ?? row.booking_date;
    const unchanged = amount === originalAmount && bookingDate === originalDate;
    db.prepare("UPDATE transactions SET amount = ?, booking_date = ?, original_amount = ?, original_booking_date = ? WHERE id = ?").run(
        amount,
        bookingDate,
        unchanged ? null : originalAmount,
        unchanged ? null : originalDate,
        id,
    );
    if (amount !== row.amount) followAmount(db, id, amount);
}

/**
 * Changes a booking. One entered by hand changes as a whole; of one from the bank, an import or
 * added by MBM only amount and booking date, and not while it is pending. On an account with a bank
 * balance, the balance stays the bank's.
 */
export function updateTransaction(db: Db, id: number, input: Partial<ManualInput>): Transaction {
    const tx = getTransaction(db, id);
    requireLive(tx);
    if (tx.source === "manual") updateManual(db, tx, input);
    else {
        if (MANUAL_ONLY.some((k) => input[k] !== undefined)) throw badRequest("Bei diesem Umsatz lassen sich nur Datum und Betrag ändern.", "not_manual");
        if (tx.status === "pending") throw conflict("Vorgemerkte Umsätze lassen sich erst ändern, wenn sie gebucht sind.", "pending");
        const amount = input.amount ?? tx.amount;
        const bookingDate = input.bookingDate ?? tx.bookingDate;
        setCountingValues(db, id, amount, bookingDate);
        // What MBM added for a PayPal payment moves with its date, unless its own date was changed
        if (bookingDate !== tx.bookingDate) {
            const added = db.prepare("SELECT id, amount FROM transactions WHERE funding_of_id = ? AND booking_date = ?").all(id, tx.bookingDate) as { id: number; amount: number }[];
            for (const a of added) setCountingValues(db, a.id, a.amount, bookingDate);
        }
        followCounter(db, tx, input);
    }
    keepBankBalance(db, tx.accountId, (input.amount ?? tx.amount) - tx.amount);
    return getTransaction(db, id);
}

function updateManual(db: Db, tx: Transaction, input: Partial<ManualInput>): void {
    const id = tx.id;
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
    else followAmount(db, id, input.amount ?? tx.amount);
    // A new text by hand is what the booking says now; an older adjustment of it is obsolete
    const dropEdit = db.prepare("DELETE FROM transaction_edits WHERE transaction_id = ? AND field = ?");
    if (input.counterpartyName !== undefined && input.counterpartyName !== tx.counterpartyName) dropEdit.run(id, "counterparty");
    if (input.remittance !== undefined && input.remittance !== tx.remittance) dropEdit.run(id, "remittance");
    followCounter(db, tx, input);
}

/** A counter booking (always one by hand, in an offline account) follows its partner's amount and date. */
function followCounter(db: Db, tx: Transaction, input: Partial<ManualInput>): void {
    if (!tx.counterTransactionId || (input.amount === undefined && input.bookingDate === undefined)) return;
    const changed = db
        .prepare("UPDATE transactions SET amount = ?, booking_date = ?, value_date = ? WHERE id = ? AND source = 'manual'")
        .run(-(input.amount ?? tx.amount), input.bookingDate ?? tx.bookingDate, input.bookingDate ?? tx.bookingDate, tx.counterTransactionId).changes;
    if (changed) followAmount(db, tx.counterTransactionId, -(input.amount ?? tx.amount));
}

/**
 * Deletes a booking. One entered by hand goes for good. All others stay as deleted, with their
 * fingerprint, so that neither a fetch nor an import brings them back; what MBM added for a PayPal
 * payment is deleted with it. On an account with a bank balance, the balance stays the bank's.
 */
export function deleteTransaction(db: Db, id: number): Transaction {
    const tx = getTransaction(db, id);
    requireLive(tx);
    // Deleting a counter booking keeps its origin; deleting the origin takes the counter booking along
    if (tx.counterTransactionId) unlinkCounter(db, id, tx.id < tx.counterTransactionId);
    if (tx.source === "manual") {
        db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
        keepBankBalance(db, tx.accountId, -tx.amount);
        return tx;
    }
    const now = nowIso();
    // The same time marks what goes with the booking, so that it comes back with it
    const ids = (db.prepare(`SELECT id FROM transactions WHERE (id = ? OR funding_of_id = ?) AND ${LIVE}`).all(id, id) as { id: number }[]).map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const { sum } = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS sum FROM transactions WHERE id IN (${marks})`).get(...ids) as { sum: number };
    db.prepare(`UPDATE transactions SET deleted_at = ? WHERE id IN (${marks})`).run(now, ...ids);
    db.prepare(`DELETE FROM transaction_unread WHERE transaction_id IN (${marks})`).run(...ids);
    keepBankBalance(db, tx.accountId, -sum);
    return getTransaction(db, id);
}

/** Brings back a deleted booking, with what MBM added for it and was deleted with it. */
export function restoreTransaction(db: Db, id: number): Transaction {
    const tx = getTransaction(db, id);
    if (!tx.deletedAt) throw conflict("Dieser Umsatz ist nicht gelöscht.", "not_deleted");
    const ids = (db.prepare("SELECT id FROM transactions WHERE (id = ? OR funding_of_id = ?) AND deleted_at = ?").all(id, id, tx.deletedAt) as { id: number }[]).map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const { sum } = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS sum FROM transactions WHERE id IN (${marks})`).get(...ids) as { sum: number };
    db.prepare(`UPDATE transactions SET deleted_at = NULL WHERE id IN (${marks})`).run(...ids);
    keepBankBalance(db, tx.accountId, sum);
    return getTransaction(db, id);
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
    requireLive(tx);
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
             FROM transactions WHERE ${LIVE} AND counterparty_name <> '' AND counterparty_name <> 'Saldo-Abgleich' ${accountId ? "AND account_id = ?" : ""}
             GROUP BY counterparty_name COLLATE NOCASE ORDER BY uses DESC, last DESC LIMIT 200`,
        )
        .all(...(accountId ? [accountId] : [])) as { name: string; iban: string | null; uses: number }[];
    return rows.map(({ name, iban, uses }) => ({ name, iban, uses }));
}

// ---------- Figures ----------

const SERIES_MAX_DAYS = 730;

type SeriesSpan = { from?: string; to?: string };

/**
 * First and last day of a series: the last `days` days, the days of `range` ("all" from the first booking) or a span
 * from the search (open ends from the first booking to today, at most 730 days). Undefined when the span is empty.
 */
function seriesBounds(db: Db, ids: number[], days: number, range: TxRange | undefined, today: string, span?: SeriesSpan): { from: string; to: string } | undefined {
    const firstBooking = () => {
        const first = ids.length
            ? (db.prepare(`SELECT MIN(booking_date) AS d FROM transactions WHERE account_id IN (${ids.map(() => "?").join(",")}) AND ${LIVE}`).get(...ids) as { d: string | null }).d
            : null;
        return first && first < today ? first : addDaysIso(today, -29);
    };
    if (span && (span.from || span.to)) {
        const to = span.to && span.to < today ? span.to : today;
        let from = span.from ?? firstBooking();
        if (from < addDaysIso(to, -(SERIES_MAX_DAYS - 1))) from = addDaysIso(to, -(SERIES_MAX_DAYS - 1));
        return from > to ? undefined : { from, to };
    }
    if (range) {
        const b = rangeBounds(range, today);
        return { from: b.from ?? firstBooking(), to: b.to ?? today };
    }
    return { from: addDaysIso(today, -(days - 1)), to: today };
}

/** Daily end-of-day balance over the last `days` days, or over `range` when given. */
export function balanceSeries(db: Db, scope: AccountScope, days: number, range?: TxRange, today = todayIso(), span?: SeriesSpan): { date: string; balance: number }[] {
    const ids = accountsInScope(db, scope);
    const bounds = seriesBounds(db, ids, days, range, today, span);
    if (!bounds) return [];
    const { from, to } = bounds;
    const current = ids.reduce((s, id) => s + getAccount(db, id).balance, 0);
    // Bookings after a day lower the balance of that day when going backwards
    const deltas = new Map<string, number>();
    if (ids.length) {
        const rows = db
            .prepare(`SELECT booking_date AS d, SUM(amount) AS s FROM transactions WHERE account_id IN (${ids.map(() => "?").join(",")}) AND ${LIVE} AND booking_date > ? GROUP BY booking_date`)
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

/**
 * Income and expenses of the bookings of `ids` between `from` and `to` as they count in figures: per share (a split
 * booking counts with each share in its category), without returns and excluded categories such as own transfers.
 */
function flowQuery(db: Db, ids: number[], select: string, tail = ""): string {
    const none = uncategorizedCounts(db) ? "tc.category_id IS NULL OR " : "";
    return `SELECT ${select},
                COALESCE(SUM(CASE WHEN COALESCE(tc.amount, t.amount) > 0 THEN COALESCE(tc.amount, t.amount) END), 0) AS income,
                COALESCE(SUM(CASE WHEN COALESCE(tc.amount, t.amount) < 0 THEN COALESCE(tc.amount, t.amount) END), 0) AS expenses
            FROM transactions t
            LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
            WHERE t.account_id IN (${ids.map(() => "?").join(",")}) AND t.booking_date BETWEEN ? AND ? AND t.${LIVE}
              AND ${NOT_RETURNED}
              AND (${none}tc.category_id NOT IN (${EXCLUDED_CATEGORIES}))
            ${tail}`;
}

export function cashflow(db: Db, scope: AccountScope, from: string, to: string): { income: number; expenses: number; count: number } {
    const ids = accountsInScope(db, scope);
    if (!ids.length) return { income: 0, expenses: 0, count: 0 };
    return db.prepare(flowQuery(db, ids, "count(DISTINCT t.id) AS count")).get(...ids, from, to) as { income: number; expenses: number; count: number };
}

/** Income and expenses per day over the days of the balance series, as the cashflow counts them; every day has a point. */
export function flowSeries(db: Db, scope: AccountScope, days: number, range?: TxRange, today = todayIso(), span?: SeriesSpan): { date: string; income: number; expenses: number }[] {
    const ids = accountsInScope(db, scope);
    const bounds = seriesBounds(db, ids, days, range, today, span);
    if (!bounds) return [];
    const byDay = new Map<string, { income: number; expenses: number }>();
    if (ids.length) {
        const rows = db.prepare(flowQuery(db, ids, "t.booking_date AS d", "GROUP BY t.booking_date")).all(...ids, bounds.from, bounds.to) as { d: string; income: number; expenses: number }[];
        for (const r of rows) byDay.set(r.d, { income: r.income, expenses: r.expenses });
    }
    const points: { date: string; income: number; expenses: number }[] = [];
    for (let date = bounds.from; date <= bounds.to; date = addDaysIso(date, 1)) points.push({ date, ...(byDay.get(date) ?? { income: 0, expenses: 0 }) });
    return points;
}

export function categorySums(db: Db, scope: AccountScope, from: string, to: string): { categoryId: number | null; amount: number; count: number }[] {
    const ids = accountsInScope(db, scope);
    if (!ids.length) return [];
    return db
        .prepare(
            `SELECT tc.category_id AS categoryId, SUM(COALESCE(tc.amount, t.amount)) AS amount, count(*) AS count
             FROM transactions t LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
             WHERE t.account_id IN (${ids.map(() => "?").join(",")}) AND t.booking_date BETWEEN ? AND ? AND t.${LIVE}
               AND ${NOT_RETURNED}
             GROUP BY tc.category_id`,
        )
        .all(...ids, from, to) as { categoryId: number | null; amount: number; count: number }[];
}
