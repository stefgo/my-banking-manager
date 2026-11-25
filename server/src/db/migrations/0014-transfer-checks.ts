import type { Migration } from "./index.js";

// The columns of a transfer row fit its kind; so far only the code made sure. Rebuilt with checks
// that state what the code writes since 0010 (no other table points at transfers):
// - "now": a creation, without date, rhythm or previous order;
// - "date": with a date, without rhythm; "standing": with a rhythm, without date;
// - changing or deleting names the bank's order and keeps the order as it was;
// - yes/no columns are 0 or 1.
// Rows that break a check stop the migration with their ids, nothing else.
const CHECKS = `
    (execution <> 'now' OR (action = 'create' AND execution_date IS NULL AND first_date IS NULL AND unit IS NULL
        AND every IS NULL AND execution_day IS NULL AND last_date IS NULL AND previous IS NULL))
    AND (execution <> 'date' OR (execution_date IS NOT NULL AND first_date IS NULL AND unit IS NULL
        AND every IS NULL AND execution_day IS NULL AND last_date IS NULL))
    AND (execution <> 'standing' OR (execution_date IS NULL AND first_date IS NOT NULL AND unit IS NOT NULL
        AND every IS NOT NULL AND execution_day IS NOT NULL))
    AND (action = 'create' OR (bank_order_id IS NOT NULL AND previous IS NOT NULL))
    AND instant IN (0, 1) AND vop_structured IN (0, 1) AND unconfirmed IN (0, 1)`;

export const transferChecks: Migration = {
    name: "0014-transfer-checks",
    up: (db) => {
        const broken = (db.prepare(`SELECT id FROM transfers WHERE NOT (${CHECKS}) ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
        if (broken.length > 0) throw new Error(`Migration 0014-transfer-checks: ${broken.length} transfer rows do not fit their kind (ids ${broken.join(", ")}).`);
        db.exec(`
            CREATE TABLE transfers_new (
                id INTEGER PRIMARY KEY,
                request_id TEXT NOT NULL UNIQUE,         -- from the client: a second request with it is the same transfer
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                login_id INTEGER REFERENCES bank_logins(id) ON DELETE SET NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_by_name TEXT NOT NULL,
                payee_name TEXT NOT NULL,
                payee_iban TEXT NOT NULL,
                payee_bic TEXT,
                amount INTEGER NOT NULL,                  -- cents, more than 0
                remittance TEXT NOT NULL,
                end_to_end_id TEXT NOT NULL UNIQUE,
                instant INTEGER NOT NULL DEFAULT 0,
                execution TEXT NOT NULL DEFAULT 'now' CHECK (execution IN ('now', 'date', 'standing')),
                status TEXT NOT NULL CHECK (status IN ('submitting', 'awaiting_vop_confirm', 'awaiting_tan', 'executed', 'rejected', 'failed', 'cancelled', 'unknown')),
                vop_result TEXT,
                vop_name TEXT,                            -- the name the payee's bank holds (close match)
                vop_reason TEXT,
                vop_text TEXT,                            -- the bank's explanation
                vop_structured INTEGER NOT NULL DEFAULT 0,
                bank_message TEXT,
                bank_reference TEXT,
                unconfirmed INTEGER NOT NULL DEFAULT 0,   -- instant: arrival not confirmed yet
                transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                action TEXT NOT NULL DEFAULT 'create' CHECK (action IN ('create', 'change', 'delete')),
                execution_date TEXT,                      -- execution 'date': the day of execution
                first_date TEXT,                          -- execution 'standing': the rhythm, as in standing_orders
                unit TEXT CHECK (unit IS NULL OR unit IN ('month', 'week')),
                every INTEGER,
                execution_day INTEGER,
                last_date TEXT,
                order_id INTEGER,                         -- row in standing_orders / scheduled_transfers (by execution); no foreign key, a fetch replaces orders
                bank_order_id TEXT,                       -- the bank's identification: given for change/delete, reported for create
                previous TEXT,                            -- JSON: the order before a change or deletion
                CHECK (${CHECKS})
            );
            INSERT INTO transfers_new SELECT * FROM transfers;
            DROP TABLE transfers;
            ALTER TABLE transfers_new RENAME TO transfers;
            CREATE INDEX transfers_account ON transfers(account_id);
            CREATE INDEX transfers_created ON transfers(created_at);
            CREATE INDEX transfers_transaction ON transfers (transaction_id);
        `);
    },
};
