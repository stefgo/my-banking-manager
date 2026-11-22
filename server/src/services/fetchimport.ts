// Takes fetched bookings and the balance of a bank account into the database.
//
// - Booked: a fingerprint (booking date, amount, counterparty IBAN, remittance, end-to-end id,
//   plus a running number for equal bookings on one day) keeps every booking once.
// - Pending: replaced by the bank's current list at every fetch. A category the user gave a
//   pending booking goes over to its successor (the same pending booking again, or the booked one).
// - New bookings without category run through the rules; then transfers between own accounts
//   get the preset category for counter bookings.
// - New bookings are new (unread) for every user; the successor of a pending booking stays read
//   for whoever had read that one.
// - Imported: a booked booking the bank delivers for the first time takes over an equal booking
//   from a CSV import (same comparison as the import), which keeps its id, category and read state.
// - The balance: the account's opening balance is set so that opening balance plus booked
//   bookings equals the bank's booked balance (balance series and totals keep working).

import { createHash } from "node:crypto";
import { duplicateKey, sameCounterparty, type ConnectorBalance, type ConnectorTransaction } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { alignBankBalance } from "./accounts.js";
import { activeRules, firstMatch } from "./rules.js";
import { queryTargets, type QueryRow } from "./querytarget.js";
import { counterDefaultCategoryId } from "./transactions.js";
import { linkBookedTransfers } from "./transfers.js";
import { markNew, markNewFor } from "./unread.js";

const norm = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** The end-to-end reference to show; banks send "NOTPROVIDED" when there is none. */
const referenceOf = (t: ConnectorTransaction): string => {
    const reference = (t.endToEndId ?? "").trim();
    return reference.toUpperCase() === "NOTPROVIDED" ? "" : reference;
};

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
    category_id: number | null;
    category_source: string | null;
    /** Users who had not read it; filled before it is deleted. */
    unreadBy: number[];
}

export interface FetchResult {
    newTransactions: number;
    newIds: number[];
}

export function applyFetch(db: Db, accountId: number, txs: ConnectorTransaction[], balance: ConnectorBalance | null, userId: number | null): FetchResult {
    return db.transaction((): FetchResult => {
        const now = new Date().toISOString();
        const booked = txs.filter((t) => t.status === "booked");
        const pending = txs.filter((t) => t.status === "pending");

        // Pending bookings of the last fetch, with the category a user may have given them
        const oldPending = db
            .prepare(
                `SELECT t.id, t.fingerprint, t.booking_date, t.amount, t.counterparty_name, t.counterparty_iban, tc.category_id, tc.source AS category_source
                 FROM transactions t LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
                 WHERE t.account_id = ? AND t.source = 'bank' AND t.status = 'pending'`,
            )
            .all(accountId) as OldPending[];
        const unreadOf = db.prepare("SELECT user_id FROM transaction_unread WHERE transaction_id = ?");
        for (const p of oldPending) p.unreadBy = (unreadOf.all(p.id) as { user_id: number }[]).map((r) => r.user_id);
        const usedPending = new Set<number>();
        db.prepare("DELETE FROM transactions WHERE account_id = ? AND source = 'bank' AND status = 'pending'").run(accountId);

        const existing = new Set((db.prepare("SELECT fingerprint FROM transactions WHERE account_id = ? AND fingerprint IS NOT NULL").all(accountId) as { fingerprint: string }[]).map((r) => r.fingerprint));
        const insertTx = db.prepare(
            `INSERT INTO transactions (account_id, fingerprint, booking_date, value_date, amount, currency, counterparty_name, ultimate_party, counterparty_iban, remittance, end_to_end_id, booking_text, reference, mandate_id, creditor_id, counterparty_bic, status, raw, first_seen_at, source, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bank', ?)`,
        );
        const rawOf = (t: ConnectorTransaction) => JSON.stringify({ bookingText: t.bookingText, mandateId: t.mandateId, creditorId: t.creditorId, bankReference: t.bankReference, counterpartyBic: t.counterpartyBic });
        const insertCat = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, ?, ?)");

        const newIds: number[] = [];
        let newBooked = 0;
        const insert = (t: ConnectorTransaction, fp: string, carried: OldPending | undefined) => {
            const id = Number(
                insertTx.run(accountId, fp, t.bookingDate, t.valueDate, t.amount, t.currency, t.counterpartyName, t.ultimateParty, t.counterpartyIban, t.remittance, t.endToEndId, t.bookingText, referenceOf(t), t.mandateId ?? "", t.creditorId ?? "", t.counterpartyBic ?? "", t.status, rawOf(t), now, userId)
                    .lastInsertRowid,
            );
            if (carried?.category_id) insertCat.run(id, carried.category_id, t.amount, carried.category_source ?? "manual", null);
            if (carried) markNewFor(db, id, carried.unreadBy);
            else markNew(db, [id]);
            newIds.push(id);
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
                        ((p.counterparty_iban && p.counterparty_iban === t.counterpartyIban) || norm(p.counterparty_name) === norm(t.counterpartyName)),
                );
            if (match) usedPending.add(match.id);
            return match;
        };

        // Bookings from a CSV import, by day and amount; each one stands for one booking of the bank
        const imported = new Map<string, { id: number; iban: string | null; name: string }[]>();
        const importedRows = db
            .prepare("SELECT id, booking_date, amount, counterparty_iban AS iban, counterparty_name AS name FROM transactions WHERE account_id = ? AND source = 'import' ORDER BY id")
            .all(accountId) as { id: number; booking_date: string; amount: number; iban: string | null; name: string }[];
        for (const r of importedRows) {
            const key = duplicateKey(r.booking_date, r.amount);
            imported.set(key, [...(imported.get(key) ?? []), { id: r.id, iban: r.iban, name: r.name }]);
        }
        const takeImported = (t: ConnectorTransaction): number | undefined => {
            const candidates = imported.get(duplicateKey(t.bookingDate, t.amount)) ?? [];
            const at = candidates.findIndex((c) => sameCounterparty(c, { iban: t.counterpartyIban, name: t.counterpartyName }));
            return at < 0 ? undefined : candidates.splice(at, 1)[0]!.id;
        };
        // The bank's details win; where it sends nothing, the file's value stays
        const adoptImported = db.prepare(
            `UPDATE transactions SET fingerprint = ?, value_date = COALESCE(?, value_date), currency = ?,
                counterparty_name = COALESCE(NULLIF(?, ''), counterparty_name), ultimate_party = COALESCE(NULLIF(?, ''), ultimate_party),
                counterparty_iban = COALESCE(?, counterparty_iban), remittance = COALESCE(NULLIF(?, ''), remittance), end_to_end_id = ?,
                booking_text = COALESCE(NULLIF(?, ''), booking_text), reference = COALESCE(NULLIF(?, ''), reference),
                mandate_id = COALESCE(NULLIF(?, ''), mandate_id), creditor_id = COALESCE(NULLIF(?, ''), creditor_id),
                counterparty_bic = COALESCE(NULLIF(?, ''), counterparty_bic), status = 'booked', raw = ?, source = 'bank', import_id = NULL
             WHERE id = ?`,
        );
        const hasCategory = db.prepare("SELECT 1 FROM transaction_categories WHERE transaction_id = ?");

        const bookedFps = fingerprints(booked);
        booked.forEach((t, i) => {
            const fp = bookedFps[i]!;
            if (existing.has(fp)) return;
            const importedId = takeImported(t);
            if (importedId !== undefined) {
                adoptImported.run(fp, t.valueDate, t.currency, t.counterpartyName, t.ultimateParty, t.counterpartyIban, t.remittance, t.endToEndId, t.bookingText, referenceOf(t), t.mandateId ?? "", t.creditorId ?? "", t.counterpartyBic ?? "", rawOf(t), importedId);
                const carried = successorOf(t);
                if (carried?.category_id && !hasCategory.get(importedId)) insertCat.run(importedId, carried.category_id, t.amount, carried.category_source ?? "manual", null);
                return;
            }
            insert(t, fp, successorOf(t));
            newBooked++;
        });
        const pendingFps = fingerprints(pending);
        pending.forEach((t, i) => insert(t, pendingFps[i]!, successorOf(t, pendingFps[i])));

        categorize(db, newIds);
        // Transfers from MBM find their booking by the end-to-end ID
        linkBookedTransfers(db, accountId);

        if (balance) {
            db.prepare(
                `INSERT INTO balances (account_id, amount, currency, booked_at, pending, available, credit_line, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (account_id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, booked_at = excluded.booked_at, pending = excluded.pending, available = excluded.available, credit_line = excluded.credit_line, fetched_at = excluded.fetched_at`,
            ).run(accountId, balance.booked, balance.currency, balance.date, balance.pending, balance.available, balance.creditLine, now);
            alignBankBalance(db, accountId, balance.booked);
        }
        return { newTransactions: newBooked, newIds };
    })();
}

/** Rules for new bookings without category, then transfers between own accounts. */
function categorize(db: Db, ids: number[]): void {
    if (ids.length === 0) return;
    const uncategorized = (id: number) => !db.prepare("SELECT 1 FROM transaction_categories WHERE transaction_id = ?").get(id);
    const rows = db
        .prepare(`SELECT id, account_id, booking_date, amount, counterparty_name, ultimate_party, counterparty_iban, remittance, NULL AS category_id FROM transactions WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as (QueryRow & { id: number })[];
    const rules = activeRules(db);
    const target = queryTargets(db);
    const insertCat = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) {
        if (!uncategorized(r.id)) continue;
        const rule = firstMatch(rules, target(r));
        if (rule) insertCat.run(r.id, rule.categoryId, r.amount, "rule", rule.id);
    }

    const transferCat = counterDefaultCategoryId(db);
    if (transferCat === null) return;
    const ownIbans = new Map((db.prepare("SELECT id, iban FROM accounts WHERE iban IS NOT NULL").all() as { id: number; iban: string }[]).map((a) => [a.iban, a.id]));
    for (const r of rows) {
        if (!r.counterparty_iban || !uncategorized(r.id)) continue;
        const other = ownIbans.get(r.counterparty_iban);
        if (other === undefined || other === r.account_id) continue;
        insertCat.run(r.id, transferCat, r.amount, "auto", null);
        // The other side, if it is there already and has no category yet
        const counter = db
            .prepare(
                `SELECT t.id, t.amount FROM transactions t WHERE t.account_id = ? AND t.amount = ? AND abs(julianday(t.booking_date) - julianday(?)) <= 3
                 AND NOT EXISTS (SELECT 1 FROM transaction_categories tc WHERE tc.transaction_id = t.id) ORDER BY t.id LIMIT 1`,
            )
            .get(other, -r.amount, r.booking_date) as { id: number; amount: number } | undefined;
        if (counter) insertCat.run(counter.id, transferCat, counter.amount, "auto", null);
    }
}
