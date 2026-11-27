import type { Migration } from "./index.js";

// Bookings of the bank, of a CSV import and those MBM adds for PayPal can be deleted and changed in
// date and amount.
// - deleted_at: a deleted booking stays with its fingerprint, so that no fetch and no import brings
//   it back; lists, figures and the matching of other bookings leave it out. It can be restored.
//   Bookings entered by hand are deleted for good, as before.
// - original_amount / original_booking_date: the value of the bank (or the file) once the user
//   changed it; amount and booking_date always hold the value that counts. Matching with fetches
//   and imports goes by the original value. NULL: unchanged.
export const bookingEdits: Migration = {
    name: "0017-booking-edits",
    up: (db) => {
        db.exec(`
            ALTER TABLE transactions ADD COLUMN deleted_at TEXT;
            ALTER TABLE transactions ADD COLUMN original_amount INTEGER;
            ALTER TABLE transactions ADD COLUMN original_booking_date TEXT;
            CREATE INDEX transactions_deleted ON transactions (account_id, deleted_at);
        `);
    },
};
