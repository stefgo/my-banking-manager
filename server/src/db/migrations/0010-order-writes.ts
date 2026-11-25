import type { Migration } from "./index.js";

// Writing orders (M5b part 2): a transfer row also stands for a scheduled transfer or a standing
// order that MBM creates, changes or deletes at the bank. The column `execution` exists since
// 0001; `action` says what happens to the order. The orders keep the end-to-end ID the bank
// lists, so that a fetch can tell whether an order whose outcome was unknown arrived.
export const orderWrites: Migration = {
    name: "0010-order-writes",
    up: (db) => {
        db.exec(`
            ALTER TABLE transfers ADD COLUMN action TEXT NOT NULL DEFAULT 'create' CHECK (action IN ('create', 'change', 'delete'));
            ALTER TABLE transfers ADD COLUMN execution_date TEXT;           -- execution 'date': the day of execution
            ALTER TABLE transfers ADD COLUMN first_date TEXT;               -- execution 'standing': the rhythm, as in standing_orders
            ALTER TABLE transfers ADD COLUMN unit TEXT CHECK (unit IS NULL OR unit IN ('month', 'week'));
            ALTER TABLE transfers ADD COLUMN every INTEGER;
            ALTER TABLE transfers ADD COLUMN execution_day INTEGER;
            ALTER TABLE transfers ADD COLUMN last_date TEXT;
            ALTER TABLE transfers ADD COLUMN order_id INTEGER;              -- row in standing_orders / scheduled_transfers (by execution); no foreign key, a fetch replaces orders
            ALTER TABLE transfers ADD COLUMN bank_order_id TEXT;            -- the bank's identification: given for change/delete, reported for create
            ALTER TABLE transfers ADD COLUMN previous TEXT;                 -- JSON: the order before a change or deletion
            ALTER TABLE standing_orders ADD COLUMN end_to_end_id TEXT;
            ALTER TABLE scheduled_transfers ADD COLUMN end_to_end_id TEXT;
        `);
    },
};
