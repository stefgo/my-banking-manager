import type { Migration } from "./index.js";

// Own import formats, and the details of a booking as columns. Bookings from the bank take them
// from what was kept of the fetch. The reference is separate from end_to_end_id on purpose: only
// the bank's end-to-end ID links a booking to a transfer, a value from a file never does.
export const importFormats: Migration = {
    name: "0004-import-formats",
    up: (db) => {
        db.exec(`
            CREATE TABLE import_formats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                definition TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            ALTER TABLE transactions ADD COLUMN reference TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN mandate_id TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN creditor_id TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN counterparty_bic TEXT NOT NULL DEFAULT '';

            UPDATE transactions SET
                reference = CASE WHEN upper(trim(coalesce(end_to_end_id, ''))) = 'NOTPROVIDED' THEN '' ELSE trim(coalesce(end_to_end_id, '')) END,
                mandate_id = CASE WHEN json_valid(raw) THEN coalesce(json_extract(raw, '$.mandateId'), '') ELSE '' END,
                creditor_id = CASE WHEN json_valid(raw) THEN coalesce(json_extract(raw, '$.creditorId'), '') ELSE '' END,
                counterparty_bic = CASE WHEN json_valid(raw) THEN coalesce(json_extract(raw, '$.counterpartyBic'), '') ELSE '' END
            WHERE source = 'bank';
        `);
    },
};
