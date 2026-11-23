import type { Migration } from "./index.js";

// Returns (return debits, cancellations) and the booking each one gives back. Bookings already
// stored are recognized by their booking text; a fetch or an import links them later.
export const bookingReturns: Migration = {
    name: "0005-booking-returns",
    up: (db) => {
        db.exec(`
            ALTER TABLE transactions ADD COLUMN is_return INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE transactions ADD COLUMN return_reason TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN return_of_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL;
            CREATE UNIQUE INDEX transactions_return_of ON transactions (return_of_id) WHERE return_of_id IS NOT NULL;
            -- LIKE ignores case for ASCII only, so the umlaut comes in both forms
            UPDATE transactions SET is_return = 1
            WHERE booking_text LIKE '%ruecklastschrift%' OR booking_text LIKE '%rücklastschrift%' OR booking_text LIKE '%rÜcklastschrift%';
        `);
    },
};
