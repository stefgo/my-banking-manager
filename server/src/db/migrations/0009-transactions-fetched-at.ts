import type { Migration } from "./index.js";

// When the bookings of an account were last fetched; the next fetch starts from there instead of
// from the newest booking, which may lie months back. Not derived for accounts already there: the
// time of a bank access says nothing about a single account, so their first fetch keeps the old rule.
export const transactionsFetchedAt: Migration = {
    name: "0009-transactions-fetched-at",
    up: (db) => {
        db.exec("ALTER TABLE accounts ADD COLUMN transactions_fetched_at TEXT"); // last successful fetch of the bookings; NULL: none yet
    },
};
