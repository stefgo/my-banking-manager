// What each user has not looked at yet. A booking from the bank is new for every user, one from a
// CSV file for everyone but the user who imported it; bookings by hand are never new. Only unread
// bookings have a row in `transaction_unread`. A deleted booking is never new: it is not counted,
// and it cannot be marked as new.

import type { AccountScope, UnreadCounts } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { accountsInScope } from "./accounts.js";

/** Marks bookings as new for every user, or for every user but `exceptUserId`. */
export function markNew(db: Db, txIds: number[], exceptUserId: number | null = null): void {
    if (!txIds.length) return;
    const users = (db.prepare("SELECT id FROM users").all() as { id: number }[]).map((u) => u.id).filter((id) => id !== exceptUserId);
    const insert = db.prepare("INSERT OR IGNORE INTO transaction_unread (user_id, transaction_id) VALUES (?, ?)");
    for (const tx of txIds) for (const user of users) insert.run(user, tx);
}

/** Marks a booking as new for exactly these users (the successor of a pending booking). */
export function markNewFor(db: Db, txId: number, userIds: number[]): void {
    const insert = db.prepare("INSERT OR IGNORE INTO transaction_unread (user_id, transaction_id) VALUES (?, ?)");
    for (const user of userIds) insert.run(user, txId);
}

/** New bookings of a user per account, and all together; deleted ones do not count. */
export function unreadCounts(db: Db, userId: number): UnreadCounts {
    const accounts = db
        .prepare(
            `SELECT t.account_id AS accountId, count(*) AS count
             FROM transaction_unread u JOIN transactions t ON t.id = u.transaction_id
             WHERE u.user_id = ? AND t.deleted_at IS NULL GROUP BY t.account_id ORDER BY t.account_id`,
        )
        .all(userId) as { accountId: number; count: number }[];
    return { accounts, total: accounts.reduce((s, a) => s + a.count, 0) };
}

/** Marks bookings as read or unread for a user; returns how many changed. */
export function setUnread(db: Db, userId: number, ids: number[], unread: boolean): number {
    const del = db.prepare("DELETE FROM transaction_unread WHERE user_id = ? AND transaction_id = ?");
    const ins = db.prepare("INSERT OR IGNORE INTO transaction_unread (user_id, transaction_id) SELECT ?, id FROM transactions WHERE id = ? AND deleted_at IS NULL");
    let changed = 0;
    for (const id of ids) changed += (unread ? ins.run(userId, id) : del.run(userId, id)).changes;
    return changed;
}

/** Marks all bookings of the accounts in `scope` as read for a user; returns how many changed. */
export function markScopeRead(db: Db, userId: number, scope: AccountScope): number {
    const accounts = accountsInScope(db, scope);
    if (!accounts.length) return 0;
    return db
        .prepare(
            `DELETE FROM transaction_unread WHERE user_id = ?
             AND transaction_id IN (SELECT id FROM transactions WHERE account_id IN (${accounts.map(() => "?").join(",")}))`,
        )
        .run(userId, ...accounts).changes;
}
