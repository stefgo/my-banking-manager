import type { Migration } from "./index.js";

// The customer reference (KREF) and the bank's own reference of a booking as columns. The bank
// reference was kept in raw before and is taken from there; the customer reference was not kept,
// bookings already stored get it at the next fetch, as long as the bank still delivers them.
export const bookingReferences: Migration = {
    name: "0008-booking-references",
    up: (db) => {
        db.exec(`
            ALTER TABLE transactions ADD COLUMN customer_reference TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN bank_reference TEXT NOT NULL DEFAULT '';

            UPDATE transactions SET
                bank_reference = trim(coalesce(json_extract(raw, '$.bankReference'), ''))
            WHERE source = 'bank' AND json_valid(raw);
        `);
    },
};
