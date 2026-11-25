import type { Migration } from "./index.js";

// - A fingerprint once per account: the fetch made sure so far, now the schema does as well.
//   Duplicates already stored are not deleted: the oldest booking keeps the fingerprint, every
//   further one gets "<fingerprint>~<id>", so that none comes back with the next fetch.
// - The figures add up the shares in transaction_categories from now on (a split booking counts
//   once per share). A booking with a single share has its full amount there; where the two drifted
//   apart, the booking's amount wins.
export const bookingGuards: Migration = {
    name: "0012-booking-guards",
    up: (db) => {
        db.exec(`
            UPDATE transactions SET fingerprint = fingerprint || '~' || id
            WHERE fingerprint IS NOT NULL AND EXISTS (
                SELECT 1 FROM transactions o
                WHERE o.account_id = transactions.account_id AND o.fingerprint = transactions.fingerprint AND o.id < transactions.id
            );
            CREATE UNIQUE INDEX transactions_fingerprint ON transactions (account_id, fingerprint) WHERE fingerprint IS NOT NULL;

            UPDATE transaction_categories SET amount = (SELECT t.amount FROM transactions t WHERE t.id = transaction_categories.transaction_id)
            WHERE transaction_id IN (SELECT transaction_id FROM transaction_categories GROUP BY transaction_id HAVING count(*) = 1);
        `);
    },
};
