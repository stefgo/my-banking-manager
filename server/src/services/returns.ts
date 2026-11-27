// Links a return (return debit, cancellation) to the booking it gives back. A linked pair stays in
// the lists and in the balance, but no longer counts in income, expenses and category sums.

import type { Db } from "../db/database.js";

/** SEPA allows refunds of unauthorized debits for 13 months; a little more for late bookings. */
const MAX_DAYS = 400;

interface LinkRow {
    id: number;
    amount: number;
    booking_date: string;
    reference: string;
    mandate_id: string;
    creditor_id: string;
    counterparty_iban: string | null;
}

// Amount and day as the bank sent them: what the user changed does not part a return from its booking
const COLUMNS = "id, COALESCE(original_amount, amount) AS amount, COALESCE(original_booking_date, booking_date) AS booking_date, reference, mandate_id, creditor_id, counterparty_iban";

export const cleanIban = (iban: string | null | undefined): string => (iban ?? "").replace(/\s/g, "").toUpperCase();

const knownRef = (s: string): string => {
    const t = s.trim();
    return t.toUpperCase() === "NOTPROVIDED" ? "" : t;
};

/**
 * Links the open returns of an account and returns their ids. Sure matches go first, so that a
 * weaker one cannot take the booking a stronger one belongs to. Among equal bookings the latest
 * wins. Without a match the return stays open and counts like any booking. Deleted bookings take
 * no part.
 */
export function linkReturns(db: Db, accountId: number): number[] {
    const open = db
        .prepare(`SELECT ${COLUMNS} FROM transactions WHERE account_id = ? AND is_return = 1 AND return_of_id IS NULL AND status = 'booked' AND amount != 0 AND deleted_at IS NULL ORDER BY booking_date, id`)
        .all(accountId) as LinkRow[];
    if (!open.length) return [];
    const own = cleanIban((db.prepare("SELECT iban FROM accounts WHERE id = ?").get(accountId) as { iban: string | null } | undefined)?.iban);
    const originals = db.prepare(
        `SELECT ${COLUMNS} FROM transactions o
         WHERE o.account_id = ? AND COALESCE(o.original_amount, o.amount) = ? AND o.status = 'booked' AND o.is_return = 0 AND o.source != 'manual' AND o.deleted_at IS NULL
           AND COALESCE(o.original_booking_date, o.booking_date) BETWEEN date(?, '-${MAX_DAYS} days') AND ?
           AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.return_of_id = o.id AND r.deleted_at IS NULL)
         ORDER BY COALESCE(o.original_booking_date, o.booking_date) DESC, o.id DESC`,
    );
    const link = db.prepare("UPDATE transactions SET return_of_id = ? WHERE id = ?");
    const matches: ((r: LinkRow, o: LinkRow) => boolean)[] = [
        (r, o) => !!knownRef(r.reference) && knownRef(r.reference) === knownRef(o.reference),
        (r, o) => !!r.mandate_id && !!r.creditor_id && r.mandate_id === o.mandate_id && r.creditor_id === o.creditor_id,
        (r, o) => {
            const iban = cleanIban(r.counterparty_iban);
            return !!iban && iban !== own && iban === cleanIban(o.counterparty_iban);
        },
    ];
    const linked = new Set<number>();
    for (const same of matches) {
        for (const r of open) {
            if (linked.has(r.id)) continue;
            const original = (originals.all(accountId, -r.amount, r.booking_date, r.booking_date) as LinkRow[]).find((o) => same(r, o));
            if (!original) continue;
            link.run(original.id, r.id);
            linked.add(r.id);
        }
    }
    return [...linked];
}

/** Linked returns without a category take the one of their booking, split parts included. */
export function inheritReturnCategories(db: Db, returnIds: readonly number[]): void {
    const inherit = db.prepare(
        `INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id)
         SELECT r.id, c.category_id, -c.amount, 'auto', NULL
         FROM transactions r JOIN transaction_categories c ON c.transaction_id = r.return_of_id
         WHERE r.id = ? AND NOT EXISTS (SELECT 1 FROM transaction_categories x WHERE x.transaction_id = r.id)`,
    );
    for (const id of returnIds) inherit.run(id);
}
