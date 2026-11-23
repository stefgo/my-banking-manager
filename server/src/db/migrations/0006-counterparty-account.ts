import type { Migration } from "./index.js";

// Account and bank code of a counterparty the bank names without an IBAN. Bookings already stored
// get them at the next fetch, as long as the bank still delivers them.
export const counterpartyAccount: Migration = {
    name: "0006-counterparty-account",
    up: (db) => {
        db.exec(`
            ALTER TABLE transactions ADD COLUMN counterparty_account TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN counterparty_bank_code TEXT NOT NULL DEFAULT '';
        `);
    },
};
