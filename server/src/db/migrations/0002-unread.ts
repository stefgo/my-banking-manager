import type { Migration } from "./index.js";

// Bookings a user has not looked at yet. Only unread ones have a row; everything before this
// migration counts as read.
export const unread: Migration = {
    name: "0002-unread",
    up: (db) => {
        db.exec(`
            CREATE TABLE transaction_unread (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, transaction_id)
            ) WITHOUT ROWID;
            CREATE INDEX transaction_unread_tx ON transaction_unread (transaction_id);
        `);
    },
};
