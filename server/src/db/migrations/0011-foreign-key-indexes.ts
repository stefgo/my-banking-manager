import type { Migration } from "./index.js";

// Indexes on foreign key columns. Without one, SQLite scans the whole child table for every
// parent row it deletes: undoing an import of 10,000 bookings took seconds and blocked the server.
// Columns of small tables stay without; the list of them is in migrations.test.ts.
export const foreignKeyIndexes: Migration = {
    name: "0011-foreign-key-indexes",
    up: (db) => {
        db.exec(`
            CREATE INDEX transactions_counter ON transactions (counter_transaction_id);
            CREATE INDEX transfers_transaction ON transfers (transaction_id);
            CREATE INDEX transaction_categories_rule ON transaction_categories (rule_id);
            CREATE INDEX sync_runs_connection ON sync_runs (connection_id);
            CREATE INDEX sync_runs_login ON sync_runs (login_id);
            CREATE INDEX sync_runs_account ON sync_runs (account_id);
            CREATE INDEX imports_account ON imports (account_id);
            CREATE INDEX bank_login_accounts_account ON bank_login_accounts (account_id);
            CREATE INDEX activity_log_device ON activity_log (device_id);
        `);
    },
};
