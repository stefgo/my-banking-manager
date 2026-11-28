// Takes fetched bookings and the balance of a bank account into the database.
//
// - Booked: a fingerprint (booking date, amount, counterparty IBAN, remittance, end-to-end id,
//   plus a running number for equal bookings on one day) keeps every booking once.
// - Pending: replaced by the bank's current list at every fetch. A category the user gave a
//   pending booking goes over to its successor (the same pending booking again, or the booked one).
// - New bookings run through the rules, which fill only what is empty; a pending booking that
//   merely comes back keeps its values and skips them. Then transfers between own accounts get the
//   preset category for counter bookings.
// - New bookings are new (unread) for every user; the successor of a pending booking stays read
//   for whoever had read that one.
// - Imported or by hand: a booked booking the bank delivers for the first time takes over an equal
//   booking from a CSV import or entered by hand (same comparison as the import), which keeps its
//   id, category and read state.
// - Deleted by the user: a booked one keeps its fingerprint and so never comes again; the mark of a
//   pending one goes over to its successor, as its category does. Deleted bookings get no rules,
//   are not new and do not count in the balance.
// - Changed by the user (amount, booking date): the fingerprint stays, matching goes by the values
//   the bank or the file gave.
// - Returns: linked to the booking they give back, whose category they take. One stored with this
//   account as its counterparty is corrected in place, since the corrected IBAN changes its fingerprint.
// - The balance: the account's opening balance is set so that opening balance plus booked
//   bookings equals the bank's booked balance (balance series and totals keep working).
// - Moves between own pockets the connector marks (PayPal: repayment of "Pay in 30 days", payout,
//   refund of a rejected payment) get the preset category for counter bookings instead of a rule's;
//   the mark stays in raw. For PayPal, MBM then adds where the money of each payment came from
//   (paypalfunding.ts). A fetch from the start (`refetchAll`) gives stored bookings the marks too.

import { createHash } from "node:crypto";
import { duplicateKey, normalizeText, sameCounterparty, type ConnectorBalance, type ConnectorTransaction } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { alignBankBalance, isPaypalAccount } from "./accounts.js";
import { evaluateNew, writeRuleCategories, writeRuleTexts } from "./rules.js";
import { cleanIban, inheritReturnCategories, linkReturns } from "./returns.js";
import { counterDefaultCategoryId } from "./transactions.js";
import { deriveFunding } from "./paypalfunding.js";
import { linkBookedTransfers } from "./transfers.js";
import { markNew, markNewFor } from "./unread.js";

const norm = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** The end-to-end reference to show; banks send "NOTPROVIDED" when there is none. */
const referenceOf = (t: ConnectorTransaction): string => {
    const reference = (t.endToEndId ?? "").trim();
    return reference.toUpperCase() === "NOTPROVIDED" ? "" : reference;
};

/** A customer or bank reference as stored; "" if none. */
const refOf = (s: string | null | undefined): string => (s ?? "").trim();

export const fingerprintBase = (t: ConnectorTransaction): string =>
    createHash("sha256")
        .update([t.bookingDate, t.amount, t.counterpartyIban ?? "", norm(t.remittance), t.endToEndId ?? "", t.status].join("|"))
        .digest("hex")
        .slice(0, 32);

/** Fingerprints with a running number for equal bookings within the list. */
function fingerprints(txs: ConnectorTransaction[]): string[] {
    const seen = new Map<string, number>();
    return txs.map((t) => {
        const base = fingerprintBase(t);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return `${base}#${n}`;
    });
}

const daysBetween = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

interface OldPending {
    id: number;
    fingerprint: string;
    booking_date: string;
    amount: number;
    counterparty_name: string;
    counterparty_iban: string | null;
    remittance: string;
    /** Its categories (more than one for a split booking); filled before it is deleted. */
    shares: { category_id: number; amount: number; source: string }[];
    /** Users who had not read it; filled before it is deleted. */
    unreadBy: number[];
    /** Deleted by the user: its successor is deleted as well. */
    deleted_at: string | null;
    /** Its adjusted texts; filled before it is deleted. */
    edits: { field: string; value: string | null; source: string }[];
}

/**
 * Is this booking the one a pending booking became? Two empty names say nothing, so without a name
 * the purposes must overlap; a booking often carries more text than its pending form.
 */
function samePendingParty(p: OldPending, t: ConnectorTransaction): boolean {
    if (p.counterparty_iban && p.counterparty_iban === t.counterpartyIban) return true;
    const pendingName = norm(p.counterparty_name);
    const bookedName = norm(t.counterpartyName);
    if (pendingName || bookedName) return pendingName === bookedName;
    const pendingPurpose = normalizeText(p.remittance);
    const bookedPurpose = normalizeText(t.remittance);
    return !!pendingPurpose && !!bookedPurpose && (pendingPurpose.includes(bookedPurpose) || bookedPurpose.includes(pendingPurpose));
}

export interface FetchResult {
    newTransactions: number;
    newIds: number[];
}

export interface FetchOptions {
    /** The fetch reached back as far as the bank allows, to give stored bookings what is new about them. */
    refetchAll?: boolean;
}

export function applyFetch(db: Db, accountId: number, txs: ConnectorTransaction[], balance: ConnectorBalance | null, userId: number | null, options: FetchOptions = {}): FetchResult {
    return db.transaction((): FetchResult => {
        const now = new Date().toISOString();
        const booked = txs.filter((t) => t.status === "booked");
        const pending = txs.filter((t) => t.status === "pending");

        // Pending bookings of the last fetch, with the category a user may have given them
        const oldPending = db
            .prepare(
                `SELECT t.id, t.fingerprint, t.booking_date, t.amount, t.counterparty_name, t.counterparty_iban, t.remittance, t.deleted_at
                 FROM transactions t WHERE t.account_id = ? AND t.source = 'bank' AND t.status = 'pending'`,
            )
            .all(accountId) as OldPending[];
        const sharesOf = db.prepare("SELECT category_id, amount, source FROM transaction_categories WHERE transaction_id = ? ORDER BY category_id");
        const unreadOf = db.prepare("SELECT user_id FROM transaction_unread WHERE transaction_id = ?");
        const editsOf = db.prepare("SELECT field, value, source FROM transaction_edits WHERE transaction_id = ?");
        for (const p of oldPending) {
            p.unreadBy = (unreadOf.all(p.id) as { user_id: number }[]).map((r) => r.user_id);
            p.edits = editsOf.all(p.id) as OldPending["edits"];
            p.shares = sharesOf.all(p.id) as OldPending["shares"];
        }
        const insertEdit = db.prepare("INSERT OR IGNORE INTO transaction_edits (transaction_id, field, value, source) VALUES (?, ?, ?, ?)");
        const carryEdits = (id: number, from: OldPending) => {
            for (const e of from.edits) insertEdit.run(id, e.field, e.value, e.source);
        };
        const usedPending = new Set<number>();
        db.prepare("DELETE FROM transactions WHERE account_id = ? AND source = 'bank' AND status = 'pending'").run(accountId);

        const existing = new Set((db.prepare("SELECT fingerprint FROM transactions WHERE account_id = ? AND fingerprint IS NOT NULL").all(accountId) as { fingerprint: string }[]).map((r) => r.fingerprint));
        const insertTx = db.prepare(
            `INSERT INTO transactions (account_id, fingerprint, booking_date, value_date, amount, currency, counterparty_name, ultimate_party, counterparty_iban, remittance, end_to_end_id, booking_text, reference, mandate_id, creditor_id, counterparty_bic, counterparty_account, counterparty_bank_code, customer_reference, bank_reference, is_return, return_reason, status, raw, first_seen_at, source, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bank', ?)`,
        );
        const rawOf = (t: ConnectorTransaction) =>
            JSON.stringify({ bookingText: t.bookingText, mandateId: t.mandateId, creditorId: t.creditorId, customerReference: t.customerReference, bankReference: t.bankReference, counterpartyBic: t.counterpartyBic, ...(t.transfer ? { transfer: t.transfer } : {}) });
        const insertCat = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, ?, NULL)");
        // A single category takes the booking's amount; a split keeps its shares
        const carryCategories = (id: number, from: OldPending, amount: number) => {
            for (const s of from.shares) insertCat.run(id, s.category_id, from.shares.length === 1 ? amount : s.amount, s.source);
        };

        const newIds: number[] = [];
        // Successors of a deleted pending booking: deleted too, so no rules, not new
        const deletedIds = new Set<number>();
        const markDeleted = db.prepare("UPDATE transactions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
        const carryDeleted = (id: number, from: OldPending | undefined) => {
            if (!from?.deleted_at) return;
            markDeleted.run(from.deleted_at, id);
            deletedIds.add(id);
        };
        // Moves between own pockets: the preset category of counter bookings, no rule's
        const transferIds = new Set<number>();
        // A pending booking that comes back is not new to the rules
        const returning = new Set<number>();
        let newBooked = 0;
        const insert = (t: ConnectorTransaction, fp: string, carried: OldPending | undefined) => {
            const id = Number(
                insertTx.run(accountId, fp, t.bookingDate, t.valueDate, t.amount, t.currency, t.counterpartyName, t.ultimateParty, t.counterpartyIban, t.remittance, t.endToEndId, t.bookingText, referenceOf(t), t.mandateId ?? "", t.creditorId ?? "", t.counterpartyBic ?? "", t.counterpartyAccount, t.counterpartyBankCode, refOf(t.customerReference), refOf(t.bankReference), t.isReturn ? 1 : 0, t.returnReason, t.status, rawOf(t), now, userId)
                    .lastInsertRowid,
            );
            if (carried) {
                carryCategories(id, carried, t.amount);
                carryEdits(id, carried);
                if (t.status === "pending") returning.add(id);
                carryDeleted(id, carried);
                if (!carried.deleted_at) markNewFor(db, id, carried.unreadBy);
            } else markNew(db, [id]);
            newIds.push(id);
            if (t.transfer) transferIds.add(id);
            return id;
        };

        // A pending booking that matches: same fingerprint, or same amount and counterparty within 10 days
        const successorOf = (t: ConnectorTransaction, fp?: string): OldPending | undefined => {
            const exact = fp ? oldPending.find((p) => !usedPending.has(p.id) && p.fingerprint === fp) : undefined;
            const match =
                exact ??
                oldPending.find(
                    (p) =>
                        !usedPending.has(p.id) &&
                        p.amount === t.amount &&
                        daysBetween(p.booking_date, t.bookingDate) <= 10 &&
                        samePendingParty(p, t),
                );
            if (match) usedPending.add(match.id);
            return match;
        };

        // Bookings from a CSV import or entered by hand, by day and amount (as the file gave them);
        // each one stands for one booking of the bank. Counter bookings and balance checks stand for none.
        // A deleted one is taken over as well and stays deleted.
        const imported = new Map<string, { id: number; iban: string | null; name: string; purpose: string }[]>();
        const importedRows = db
            .prepare(
                `SELECT id, COALESCE(original_booking_date, booking_date) AS booking_date, COALESCE(original_amount, amount) AS amount, counterparty_iban AS iban, counterparty_name AS name, remittance AS purpose
                 FROM transactions WHERE account_id = ? AND (source = 'import' OR (source = 'manual' AND counter_transaction_id IS NULL AND counterparty_name <> 'Saldo-Abgleich')) ORDER BY id`,
            )
            .all(accountId) as { id: number; booking_date: string; amount: number; iban: string | null; name: string; purpose: string }[];
        for (const r of importedRows) {
            const key = duplicateKey(r.booking_date, r.amount);
            imported.set(key, [...(imported.get(key) ?? []), { id: r.id, iban: r.iban, name: r.name, purpose: r.purpose }]);
        }
        const takeImported = (t: ConnectorTransaction): number | undefined => {
            const candidates = imported.get(duplicateKey(t.bookingDate, t.amount)) ?? [];
            // The imported booking holds the text of the file, the bank's is the complete one
            // A file may name a batch by its first item, as earlier versions of the fetch did
            const party = { iban: t.replaces?.counterpartyIban ?? t.counterpartyIban, name: t.counterpartyName, purpose: t.replaces?.remittance ?? t.remittance };
            const at = candidates.findIndex((c) => sameCounterparty(party, c));
            return at < 0 ? undefined : candidates.splice(at, 1)[0]!.id;
        };
        // The bank's details win; where it sends nothing, the file's value stays
        const adoptImported = db.prepare(
            `UPDATE transactions SET fingerprint = ?, value_date = COALESCE(?, value_date), currency = ?,
                counterparty_name = COALESCE(NULLIF(?, ''), counterparty_name), ultimate_party = COALESCE(NULLIF(?, ''), ultimate_party),
                counterparty_iban = COALESCE(?, counterparty_iban), remittance = COALESCE(NULLIF(?, ''), remittance), end_to_end_id = ?,
                booking_text = COALESCE(NULLIF(?, ''), booking_text), reference = COALESCE(NULLIF(?, ''), reference),
                mandate_id = COALESCE(NULLIF(?, ''), mandate_id), creditor_id = COALESCE(NULLIF(?, ''), creditor_id),
                counterparty_bic = COALESCE(NULLIF(?, ''), counterparty_bic),
                counterparty_account = COALESCE(NULLIF(?, ''), counterparty_account), counterparty_bank_code = COALESCE(NULLIF(?, ''), counterparty_bank_code),
                customer_reference = COALESCE(NULLIF(?, ''), customer_reference), bank_reference = COALESCE(NULLIF(?, ''), bank_reference),
                is_return = MAX(is_return, ?), return_reason = COALESCE(NULLIF(?, ''), return_reason),
                status = 'booked', raw = ?, source = 'bank', import_id = NULL
             WHERE id = ?`,
        );
        const hasCategory = db.prepare("SELECT 1 FROM transaction_categories WHERE transaction_id = ?");
        const markReturn = db.prepare("UPDATE transactions SET is_return = 1, return_reason = COALESCE(NULLIF(?, ''), return_reason) WHERE account_id = ? AND fingerprint = ?");
        // Stored before the account was kept; the fingerprint does not hold it, so it can follow
        const fillAccount = db.prepare(
            `UPDATE transactions SET counterparty_account = CASE WHEN counterparty_account = '' THEN ? ELSE counterparty_account END,
                counterparty_bank_code = CASE WHEN counterparty_bank_code = '' THEN ? ELSE counterparty_bank_code END
             WHERE account_id = ? AND fingerprint = ? AND counterparty_iban IS NULL`,
        );
        // Stored before the references were kept; the fingerprint does not hold them either
        const fillReferences = db.prepare(
            `UPDATE transactions SET customer_reference = CASE WHEN customer_reference = '' THEN ? ELSE customer_reference END,
                bank_reference = CASE WHEN bank_reference = '' THEN ? ELSE bank_reference END
             WHERE account_id = ? AND fingerprint = ?`,
        );
        // A batch stored under its first item: that item's counterparty goes, the category stays.
        // A linked return keeps its mark, the link depends on it.
        const correctBatch = db.prepare(
            `UPDATE transactions SET fingerprint = ?, counterparty_name = '', ultimate_party = '', counterparty_iban = NULL, counterparty_bic = '',
                counterparty_account = '', counterparty_bank_code = '', remittance = ?, end_to_end_id = NULL, booking_text = ?, reference = '',
                mandate_id = '', creditor_id = '', customer_reference = '', bank_reference = ?, is_return = CASE WHEN return_of_id IS NULL THEN ? ELSE is_return END,
                return_reason = CASE WHEN return_of_id IS NULL THEN '' ELSE return_reason END, raw = ?
             WHERE account_id = ? AND fingerprint = ?`,
        );

        // Bookings stored with this account as their own counterparty, as returns once were. Their
        // fingerprint holds that IBAN, so the corrected booking would otherwise arrive as a new one.
        const ownIban = cleanIban((db.prepare("SELECT iban FROM accounts WHERE id = ?").get(accountId) as { iban: string | null } | undefined)?.iban);
        const selfKey = (date: string, amount: number, remittance: string | null, endToEndId: string | null) => [date, amount, norm(remittance), endToEndId ?? ""].join("|");
        const selfBooked = new Map<string, number[]>();
        if (ownIban) {
            const rows = db
                .prepare(
                    `SELECT id, COALESCE(original_booking_date, booking_date) AS booking_date, COALESCE(original_amount, amount) AS amount, remittance, end_to_end_id
                     FROM transactions WHERE account_id = ? AND source = 'bank' AND status = 'booked' AND UPPER(REPLACE(counterparty_iban, ' ', '')) = ? ORDER BY id`,
                )
                .all(accountId, ownIban) as { id: number; booking_date: string; amount: number; remittance: string; end_to_end_id: string | null }[];
            for (const r of rows) {
                const key = selfKey(r.booking_date, r.amount, r.remittance, r.end_to_end_id);
                selfBooked.set(key, [...(selfBooked.get(key) ?? []), r.id]);
            }
        }
        const takeSelfBooked = (t: ConnectorTransaction): number | undefined =>
            cleanIban(t.counterpartyIban) === ownIban ? undefined : selfBooked.get(selfKey(t.bookingDate, t.amount, t.remittance, t.endToEndId))?.shift();
        const correctParty = db.prepare(
            `UPDATE transactions SET fingerprint = ?, counterparty_name = COALESCE(NULLIF(?, ''), counterparty_name), ultimate_party = ?, counterparty_iban = ?,
                counterparty_bic = COALESCE(NULLIF(?, ''), counterparty_bic),
                counterparty_account = COALESCE(NULLIF(?, ''), counterparty_account), counterparty_bank_code = COALESCE(NULLIF(?, ''), counterparty_bank_code),
                customer_reference = COALESCE(NULLIF(?, ''), customer_reference), bank_reference = COALESCE(NULLIF(?, ''), bank_reference),
                is_return = MAX(is_return, ?), return_reason = COALESCE(NULLIF(?, ''), return_reason), raw = ?
             WHERE id = ?`,
        );

        // A fetch from the start: a stored booking takes the connector's mark, its texts and the preset category
        const storedId = db.prepare("SELECT id FROM transactions WHERE account_id = ? AND fingerprint = ?");
        const takeMark = db.prepare(
            `UPDATE transactions SET booking_text = ?, counterparty_name = COALESCE(NULLIF(?, ''), counterparty_name),
                raw = json_set(COALESCE(raw, '{}'), '$.transfer', ?) WHERE id = ?`,
        );
        const marked: number[] = [];

        const bookedFps = fingerprints(booked);
        // Numbered over the whole list as before, so that equal bookings keep their old fingerprint
        const earlierFps = fingerprints(booked.map((t) => (t.replaces ? { ...t, ...t.replaces } : t)));
        booked.forEach((t, i) => {
            const fp = bookedFps[i]!;
            if (existing.has(fp)) {
                if (t.isReturn) markReturn.run(t.returnReason, accountId, fp);
                if (t.counterpartyAccount || t.counterpartyBankCode) fillAccount.run(t.counterpartyAccount, t.counterpartyBankCode, accountId, fp);
                if (t.customerReference || t.bankReference) fillReferences.run(refOf(t.customerReference), refOf(t.bankReference), accountId, fp);
                if (options.refetchAll && t.transfer) {
                    const id = (storedId.get(accountId, fp) as { id: number }).id;
                    takeMark.run(t.bookingText, t.counterpartyName, t.transfer, id);
                    marked.push(id);
                }
                return;
            }
            const earlierFp = earlierFps[i]!;
            if (t.replaces && existing.has(earlierFp)) {
                correctBatch.run(fp, t.remittance, t.bookingText, refOf(t.bankReference), t.isReturn ? 1 : 0, rawOf(t), accountId, earlierFp);
                existing.delete(earlierFp);
                existing.add(fp);
                return;
            }
            const selfId = takeSelfBooked(t);
            if (selfId !== undefined) {
                correctParty.run(fp, t.counterpartyName, t.ultimateParty, t.counterpartyIban, t.counterpartyBic ?? "", t.counterpartyAccount, t.counterpartyBankCode, refOf(t.customerReference), refOf(t.bankReference), t.isReturn ? 1 : 0, t.returnReason, rawOf(t), selfId);
                return;
            }
            const importedId = takeImported(t);
            if (importedId !== undefined) {
                adoptImported.run(fp, t.valueDate, t.currency, t.counterpartyName, t.ultimateParty, t.counterpartyIban, t.remittance, t.endToEndId, t.bookingText, referenceOf(t), t.mandateId ?? "", t.creditorId ?? "", t.counterpartyBic ?? "", t.counterpartyAccount, t.counterpartyBankCode, refOf(t.customerReference), refOf(t.bankReference), t.isReturn ? 1 : 0, t.returnReason, rawOf(t), importedId);
                const carried = successorOf(t);
                if (carried && !hasCategory.get(importedId)) carryCategories(importedId, carried, t.amount);
                if (carried) carryEdits(importedId, carried);
                carryDeleted(importedId, carried);
                return;
            }
            const carried = successorOf(t);
            insert(t, fp, carried);
            if (!carried?.deleted_at) newBooked++;
        });
        const pendingFps = fingerprints(pending);
        pending.forEach((t, i) => insert(t, pendingFps[i]!, successorOf(t, pendingFps[i])));

        // A linked return takes the category of its booking, whatever the rules say. That booking may
        // have come with this fetch, so its category is written first; the texts of a return follow.
        const linkedReturns = linkReturns(db, accountId);
        const linked = new Set(linkedReturns);
        const results = evaluateNew(db, newIds.filter((id) => !returning.has(id) && !deletedIds.has(id)));
        writeRuleCategories(db, results, new Set([...linked, ...transferIds]));
        categorizeTransfers(db, newIds.filter((id) => !linked.has(id) && !deletedIds.has(id)), transferIds);
        recategorizeMarked(db, marked);
        inheritReturnCategories(db, linkedReturns);
        writeRuleTexts(db, results);
        // Transfers from MBM find their booking by the end-to-end ID
        linkBookedTransfers(db, accountId);

        if (balance) {
            if (isPaypalAccount(db, accountId)) deriveFunding(db, accountId, balance.booked, newIds);
            db.prepare(
                `INSERT INTO balances (account_id, amount, currency, booked_at, pending, available, credit_line, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (account_id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, booked_at = excluded.booked_at, pending = excluded.pending, available = excluded.available, credit_line = excluded.credit_line, fetched_at = excluded.fetched_at`,
            ).run(accountId, balance.booked, balance.currency, balance.date, balance.pending, balance.available, balance.creditLine, now);
            alignBankBalance(db, accountId, balance.booked);
        }
        return { newTransactions: newBooked, newIds };
    })();
}

/**
 * New bookings between own accounts that are still without category get the preset one, and so do
 * the moves between own pockets the connector marked (`marked`).
 */
function categorizeTransfers(db: Db, ids: number[], marked: ReadonlySet<number> = new Set()): void {
    if (ids.length === 0) return;
    const transferCat = counterDefaultCategoryId(db);
    if (transferCat === null) return;
    const uncategorized = (id: number) => !db.prepare("SELECT 1 FROM transaction_categories WHERE transaction_id = ?").get(id);
    for (const id of ids) if (marked.has(id) && uncategorized(id)) db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) SELECT id, ?, amount, 'auto', NULL FROM transactions WHERE id = ?").run(transferCat, id);
    const rows = db
        .prepare(`SELECT id, account_id, booking_date, amount, counterparty_iban FROM transactions WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as { id: number; account_id: number; booking_date: string; amount: number; counterparty_iban: string | null }[];
    const insertCat = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, ?, ?)");
    const ownIbans = new Map((db.prepare("SELECT id, iban FROM accounts WHERE iban IS NOT NULL").all() as { id: number; iban: string }[]).map((a) => [a.iban, a.id]));
    for (const r of rows) {
        if (!r.counterparty_iban || !uncategorized(r.id)) continue;
        const other = ownIbans.get(r.counterparty_iban);
        if (other === undefined || other === r.account_id) continue;
        insertCat.run(r.id, transferCat, r.amount, "auto", null);
        // The other side, if it is there already and has no category yet
        const counter = db
            .prepare(
                `SELECT t.id, t.amount FROM transactions t WHERE t.account_id = ? AND COALESCE(t.original_amount, t.amount) = ?
                 AND abs(julianday(COALESCE(t.original_booking_date, t.booking_date)) - julianday(?)) <= 3 AND t.deleted_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM transaction_categories tc WHERE tc.transaction_id = t.id) ORDER BY t.id LIMIT 1`,
            )
            .get(other, -r.amount, r.booking_date) as { id: number; amount: number } | undefined;
        if (counter) insertCat.run(counter.id, transferCat, counter.amount, "auto", null);
    }
}

/**
 * Stored bookings that turned out to be moves between own pockets: the preset category replaces
 * one from rules or set automatically; one the user chose stays.
 */
function recategorizeMarked(db: Db, ids: readonly number[]): void {
    const transferCat = counterDefaultCategoryId(db);
    if (transferCat === null || ids.length === 0) return;
    const manual = db.prepare("SELECT 1 FROM transaction_categories WHERE transaction_id = ? AND source = 'manual'");
    const drop = db.prepare("DELETE FROM transaction_categories WHERE transaction_id = ?");
    const insert = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) SELECT id, ?, amount, 'auto', NULL FROM transactions WHERE id = ?");
    for (const id of ids) {
        if (manual.get(id)) continue;
        drop.run(id);
        insert.run(transferCat, id);
    }
}
