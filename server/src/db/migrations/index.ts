import type Database from "better-sqlite3-multiple-ciphers";
import { initial } from "./0001-initial.js";
import { unread } from "./0002-unread.js";
import { bookingDetails } from "./0003-booking-details.js";
import { importFormats } from "./0004-import-formats.js";
import { bookingReturns } from "./0005-booking-returns.js";
import { counterpartyAccount } from "./0006-counterparty-account.js";
import { ruleActions } from "./0007-rule-actions.js";
import { bookingReferences } from "./0008-booking-references.js";
import { transactionsFetchedAt } from "./0009-transactions-fetched-at.js";
import { orderWrites } from "./0010-order-writes.js";
import { foreignKeyIndexes } from "./0011-foreign-key-indexes.js";
import { bookingGuards } from "./0012-booking-guards.js";
import { accountKind } from "./0013-account-kind.js";
import { transferChecks } from "./0014-transfer-checks.js";
import { psd2Connections } from "./0015-psd2-connections.js";
import { paypalFunding } from "./0016-paypal-funding.js";
import { bookingEdits } from "./0017-booking-edits.js";
import { psd2AccountConsents } from "./0018-psd2-account-consents.js";

export interface Migration {
    name: string;
    up: (db: Database.Database) => void;
    /**
     * Runs with foreign keys off (a table rebuild: dropping the old table must not cascade).
     * They are checked before the commit, and switched on again afterwards.
     */
    foreignKeysOff?: boolean;
}

// One file per migration. Each runs once, in this order, inside a transaction. Never change one
// that shipped; add the next file and list it here.
export const migrations: Migration[] = [initial, unread, bookingDetails, importFormats, bookingReturns, counterpartyAccount, ruleActions, bookingReferences, transactionsFetchedAt, orderWrites,
    foreignKeyIndexes, bookingGuards, accountKind, transferChecks, psd2Connections, paypalFunding, bookingEdits, psd2AccountConsents];

/** Runs one migration inside a transaction. */
export function applyMigration(db: Database.Database, m: Migration): void {
    // The pragma has no effect inside a transaction, so it is set around it
    const fkWasOn = m.foreignKeysOff ? (db.pragma("foreign_keys", { simple: true }) as number) === 1 : false;
    if (fkWasOn) db.pragma("foreign_keys = OFF");
    try {
        db.transaction(() => {
            m.up(db);
            if (m.foreignKeysOff && (db.pragma("foreign_key_check") as unknown[]).length > 0) {
                throw new Error(`Migration ${m.name} leaves broken foreign keys.`);
            }
        })();
    } finally {
        if (fkWasOn) db.pragma("foreign_keys = ON");
    }
}
