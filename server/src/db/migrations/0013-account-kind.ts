import type { Migration } from "./index.js";

// The kind of an account says what it is, no longer where it comes from: "offline" goes, an account
// without a bank access is an offline account. Accounts created by hand get the new kind "other";
// an account detached from its bank access keeps its kind (before, it became "offline"). Those
// already detached: with a card number a credit card, otherwise "other".
// The bank access becomes a foreign key: it cannot go while accounts still hang on it (the service
// detaches or deletes them first). An account has an external id exactly when it has a bank access.
// The table is rebuilt for that; the columns keep their order.
export const accountKind: Migration = {
    name: "0013-account-kind",
    foreignKeysOff: true,
    up: (db) => {
        db.exec(`
            -- An account whose bank access is gone, or that has only half of the link, is offline
            UPDATE accounts SET connection_id = NULL, external_id = NULL
            WHERE connection_id IS NULL OR external_id IS NULL
               OR connection_id NOT IN (SELECT id FROM bank_connections);

            CREATE TABLE accounts_new (
                id INTEGER PRIMARY KEY,
                connection_id INTEGER REFERENCES bank_connections(id),  -- bank access; empty for offline accounts
                external_id TEXT,
                iban TEXT,
                bic TEXT,
                card_number TEXT,               -- credit cards: full card number, shown instead of the IBAN
                name TEXT NOT NULL,
                currency TEXT NOT NULL DEFAULT 'EUR',
                kind TEXT NOT NULL CHECK (kind IN ('giro', 'savings', 'credit_card', 'loan', 'other')),
                reference_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
                group_id INTEGER REFERENCES account_groups(id) ON DELETE SET NULL,
                icon TEXT NOT NULL,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
                opening_balance INTEGER,
                created_at TEXT NOT NULL,
                info_attributes TEXT NOT NULL DEFAULT '[]',  -- JSON: [{ key, value }]
                info_notes TEXT NOT NULL DEFAULT '',
                orders_fetched_at TEXT,         -- last successful fetch of the account's orders; NULL: never
                transactions_fetched_at TEXT,   -- last successful fetch of the bookings; NULL: none yet
                CHECK ((connection_id IS NULL) = (external_id IS NULL))
            );
            INSERT INTO accounts_new
                SELECT id, connection_id, external_id, iban, bic, card_number, name, currency,
                       CASE WHEN kind <> 'offline' THEN kind WHEN card_number IS NOT NULL THEN 'credit_card' ELSE 'other' END,
                       reference_account_id, group_id, icon, color, position, hidden, opening_balance, created_at,
                       info_attributes, info_notes, orders_fetched_at, transactions_fetched_at
                FROM accounts;
            DROP TABLE accounts;
            ALTER TABLE accounts_new RENAME TO accounts;
            CREATE UNIQUE INDEX accounts_external ON accounts (connection_id, external_id) WHERE connection_id IS NOT NULL;
        `);
    },
};
