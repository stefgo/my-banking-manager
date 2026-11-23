import type { Migration } from "./index.js";

// Rules become more than a category: a name, chosen accounts, extracts and text actions. What they
// change in a booking lies next to it in transaction_edits, the bank's columns stay as they are.
// The table is renamed first so that transaction_categories.rule_id follows it, then rebuilt
// because category_id becomes optional. No booking and no query changes here.
export const ruleActions: Migration = {
    name: "0007-rule-actions",
    foreignKeysOff: true,
    up: (db) => {
        db.exec(`
            ALTER TABLE category_rules RENAME TO rules;

            CREATE TABLE rules_new (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                query TEXT NOT NULL,
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                extracts TEXT NOT NULL DEFAULT '[]',
                edits TEXT NOT NULL DEFAULT '[]',
                all_accounts INTEGER NOT NULL DEFAULT 1,
                position INTEGER NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            INSERT INTO rules_new (id, query, category_id, position, active, created_at)
                SELECT id, query, category_id, position, active, created_at FROM rules;
            DROP TABLE rules;
            ALTER TABLE rules_new RENAME TO rules;

            CREATE TABLE rule_accounts (
                rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                PRIMARY KEY (rule_id, account_id)
            );
            CREATE INDEX rule_accounts_account ON rule_accounts (account_id);

            CREATE TABLE transaction_edits (
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                field TEXT NOT NULL CHECK (field IN ('counterparty', 'remittance')),
                value TEXT,
                source TEXT NOT NULL CHECK (source IN ('rule', 'manual')),
                PRIMARY KEY (transaction_id, field)
            );
        `);
    },
};
