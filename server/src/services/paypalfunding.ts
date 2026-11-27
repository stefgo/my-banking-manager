// Where the money of a PayPal payment came from. PayPal reports the payment, not the debit from
// bank account or card that paid for it, nor the credit of "Pay in 30 days". MBM adds these
// bookings itself, worked out from the balance ("balance first", shared/funding.ts):
// - A payment takes what the balance holds; for the rest MBM adds a debit "Abbuchung" from
//   "Bankkonto oder Karte" (PayPal does not say which of the sources it used).
// - A purchase with "Pay in 30 days" (its repayment 25–35 days later, the only one of that amount)
//   gets the credit "Später bezahlen" instead; the repayment is what PayPal fetches from outside.
// - A payout to the bank account never gets one.
// Added bookings point to their payment (funding_of_id), carry the preset category of counter
// bookings (neither income nor expense), are read, and go with their payment.
// The first time, all bookings are worked out, from the smallest start balance that ends at
// PayPal's balance. After that, from 40 days before the oldest new booking: whether a purchase was
// one with "Pay in 30 days" shows only with its repayment. Added bookings that stay the same keep
// their id. Where the bookings do not add up, the rest goes into the opening balance as before.
// What the user changed or deleted counts for nothing here: the bookings are worked out from what
// PayPal sent (original amounts and days, deleted bookings included, none entered by hand). An
// added booking is found by its payment alone; worked out anew, it changes in place: its amount
// unless the user changed that, its day with its payment unless the user gave it its own. A deleted
// one stays deleted.

import { fundingOrder, minimalStart, payLaterPairs, runFunding, type FundingItem } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { counterDefaultCategoryId, followAmount } from "./transactions.js";

/** Days before the oldest new booking that are worked out again (repayment comes after at most 35). */
export const FUNDING_WINDOW_DAYS = 40;

export const FUNDING_TEXTS = {
    funding: { party: "Bankkonto oder Karte", bookingText: "Abbuchung" },
    pay_later: { party: "PayPal Später bezahlen", bookingText: "Später bezahlen" },
} as const;
type Kind = keyof typeof FUNDING_TEXTS;

export function isPaypalAccount(db: Db, accountId: number): boolean {
    return !!db
        .prepare("SELECT 1 FROM accounts a JOIN bank_connections c ON c.id = a.connection_id WHERE a.id = ? AND c.connector = 'enablebanking' AND lower(c.aspsp) = 'paypal'")
        .get(accountId);
}

interface Row {
    id: number;
    /** Day and amount as PayPal sent them (or as MBM worked them out). */
    booking_date: string;
    amount: number;
    /** Day and amount that count: the user may have changed them. */
    counting_date: string;
    counting_amount: number;
    original_amount: number | null;
    deleted_at: string | null;
    source: "bank" | "manual" | "import";
    counterparty_name: string;
    transfer: string | null;
    funding_of_id: number | null;
    derived: Kind | null;
}

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface FundingResult {
    added: number;
    removed: number;
}

/**
 * Brings the added bookings of a PayPal account up to date; `balance` is PayPal's booked balance,
 * `newIds` the bookings this fetch brought. Call before the opening balance is aligned.
 */
export function deriveFunding(db: Db, accountId: number, balance: number, newIds: readonly number[], today = new Date().toISOString().slice(0, 10)): FundingResult {
    // What counts for the balance, as alignBankBalance sees it
    const all = db
        .prepare(
            `SELECT id, COALESCE(original_booking_date, booking_date) AS booking_date, COALESCE(original_amount, amount) AS amount, booking_date AS counting_date, amount AS counting_amount,
                    original_amount, deleted_at, source, counterparty_name, json_extract(raw, '$.transfer') AS transfer, funding_of_id, json_extract(raw, '$.derived') AS derived
             FROM transactions WHERE account_id = ? AND NOT (source = 'bank' AND status = 'pending') ORDER BY COALESCE(original_booking_date, booking_date), id`,
        )
        .all(accountId) as Row[];
    // What PayPal sent: no booking entered by hand, the deleted ones included
    const rows = all.filter((r) => r.source !== "manual");
    // fundingOrder goes by `date`
    const own = rows.filter((r) => r.funding_of_id === null).map((r) => ({ ...r, date: r.booking_date }));
    const added = rows.filter((r) => r.funding_of_id !== null);

    const candidates = own.map((r) => ({ r, amount: r.amount, date: r.booking_date, repayment: r.transfer === "repayment", purchase: r.amount < 0 && r.transfer === null }));
    const onCredit = new Set([...payLaterPairs(candidates).keys()].map((c) => c.r.id));
    const itemOf = (r: Row & { date: string }): FundingItem => ({ amount: r.amount, date: r.booking_date, onCredit: onCredit.has(r.id), noFunding: r.transfer === "payout" });

    // The first time all of it, from the smallest start that ends at the balance; then a window
    let from: string | null = null;
    let start: number;
    if (!added.length) {
        start = minimalStart(fundingOrder(own).map(itemOf), balance) ?? 0;
    } else {
        const newest = new Set(newIds);
        const oldestNew = own.filter((r) => newest.has(r.id)).reduce((min, r) => (r.booking_date < min ? r.booking_date : min), today);
        from = addDays(oldestNew, -FUNDING_WINDOW_DAYS);
        const opening = (db.prepare("SELECT opening_balance AS o FROM accounts WHERE id = ?").get(accountId) as { o: number | null }).o ?? 0;
        // The opening balance holds what the user changed, deleted or entered by hand; PayPal's
        // start does not: the difference between what counts and what PayPal sent goes out again
        const counted = all.reduce((sum, r) => sum + (r.deleted_at ? 0 : r.counting_amount), 0);
        const sent = rows.reduce((sum, r) => sum + r.amount, 0);
        start = opening + counted - sent + rows.filter((r) => r.booking_date < from!).reduce((sum, r) => sum + r.amount, 0);
    }
    const window = fundingOrder(own.filter((r) => from === null || r.booking_date >= from));
    const run = runFunding(window.map(itemOf), start);

    // At most one added booking per payment
    const wanted = new Map<number, { of: Row & { date: string }; kind: Kind; amount: number }>();
    window.forEach((r, i) => {
        const want = onCredit.has(r.id) ? { kind: "pay_later" as const, amount: -r.amount } : run.outside[i]! > 0 ? { kind: "funding" as const, amount: run.outside[i]! } : null;
        if (want) wanted.set(r.id, { of: r, ...want });
    });

    const texts = (w: { of: Row; kind: Kind }) => ({
        ...FUNDING_TEXTS[w.kind],
        purpose: w.of.transfer === "repayment" ? "für Rückzahlung Später bezahlen" : w.of.counterparty_name ? `für Zahlung an ${w.of.counterparty_name}` : "für Zahlung",
    });
    let removed = 0;
    const remove = db.prepare("DELETE FROM transactions WHERE id = ?");
    const update = db.prepare("UPDATE transactions SET amount = ?, booking_date = ?, original_amount = ?, original_booking_date = ? WHERE id = ?");
    const retext = db.prepare("UPDATE transactions SET counterparty_name = ?, remittance = ?, booking_text = ?, raw = json_set(COALESCE(raw, '{}'), '$.derived', ?) WHERE id = ?");
    for (const a of added.filter((x) => from === null || x.booking_date >= from)) {
        const w = wanted.get(a.funding_of_id!);
        if (!w) {
            remove.run(a.id);
            removed++;
            continue;
        }
        wanted.delete(a.funding_of_id!);
        if (a.derived !== w.kind) {
            const t = texts(w);
            retext.run(t.party, t.purpose, t.bookingText, w.kind, a.id);
        }
        // The amount the user changed stays; the day follows the payment unless the user gave it its own
        const amount = a.original_amount !== null && a.counting_amount !== a.original_amount ? a.counting_amount : w.amount;
        const date = a.counting_date === w.of.counting_date ? w.of.counting_date : a.counting_date;
        const same = amount === w.amount && date === w.of.booking_date;
        update.run(amount, date, same ? null : w.amount, same ? null : w.of.booking_date, a.id);
        if (amount !== a.counting_amount) followAmount(db, a.id, amount);
    }

    const insert = db.prepare(
        `INSERT INTO transactions (account_id, booking_date, amount, counterparty_name, remittance, booking_text, status, raw, first_seen_at, source, funding_of_id, original_amount, original_booking_date, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'booked', ?, ?, 'bank', ?, ?, ?, ?)`,
    );
    const category = counterDefaultCategoryId(db);
    const insertCat = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, 'auto', NULL)");
    const now = new Date().toISOString();
    for (const w of wanted.values()) {
        const t = texts(w);
        // On the day of its payment; deleted with it
        const moved = w.of.counting_date !== w.of.booking_date;
        const id = Number(
            insert.run(accountId, w.of.counting_date, w.amount, t.party, t.purpose, t.bookingText, JSON.stringify({ derived: w.kind }), now, w.of.id, moved ? w.amount : null, moved ? w.of.booking_date : null, w.of.deleted_at)
                .lastInsertRowid,
        );
        if (category !== null) insertCat.run(id, category, w.amount);
    }
    return { added: wanted.size, removed };
}
