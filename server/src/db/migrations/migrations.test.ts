import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initial } from "./0001-initial.js";
import { unread } from "./0002-unread.js";
import { bookingDetails } from "./0003-booking-details.js";
import { importFormats } from "./0004-import-formats.js";
import { bookingReturns } from "./0005-booking-returns.js";
import { counterpartyAccount } from "./0006-counterparty-account.js";
import { ruleActions } from "./0007-rule-actions.js";
import { bookingReferences } from "./0008-booking-references.js";
import { transactionsFetchedAt } from "./0009-transactions-fetched-at.js";
import { applyMigration } from "./index.js";

const columns = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("0001-initial", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        applyMigration(db, initial);
    });
    afterEach(() => db.close());

    it("keeps one slot for uncategorized bookings and lets it fall back to the top level when its parent goes", () => {
        db.exec("INSERT INTO categories (id, parent_id, name, icon, color, position) VALUES (1, NULL, 'Freizeit', 'tag', 'green', 0)");
        db.exec("INSERT INTO uncategorized_slot (id, parent_id, position) VALUES (1, 1, 0)");
        expect(() => db.exec("INSERT INTO uncategorized_slot (id, parent_id, position) VALUES (2, NULL, NULL)")).toThrow();
        db.exec("DELETE FROM categories WHERE id = 1");
        expect(db.prepare("SELECT parent_id AS parentId FROM uncategorized_slot").get()).toEqual({ parentId: null });
    });

    it("limits overview cards to the 12-column grid and drops them with their user", () => {
        db.exec(`
            INSERT INTO users (id, name, created_at) VALUES (1, 'Anna', '2026-01-01T00:00:00Z');
            INSERT INTO dashboard_cards (id, user_id, position, type, width, title, config) VALUES (1, 1, 0, 'balance', 8, NULL, '{}');
        `);
        expect(db.prepare("SELECT height FROM dashboard_cards WHERE id = 1").get()).toEqual({ height: null });
        expect(() => db.exec("UPDATE dashboard_cards SET width = 13 WHERE id = 1")).toThrow();
        expect(() => db.exec("UPDATE dashboard_cards SET width = 0 WHERE id = 1")).toThrow();
        expect(() => db.exec("UPDATE dashboard_cards SET height = 1 WHERE id = 1")).toThrow();
        db.exec("UPDATE dashboard_cards SET width = 12, height = 6 WHERE id = 1");
        db.exec("DELETE FROM users WHERE id = 1");
        expect(db.prepare("SELECT count(*) AS n FROM dashboard_cards").get()).toEqual({ n: 0 });
    });

    it("stores rules as a query and marks the preset category of counter bookings", () => {
        expect(columns(db, "category_rules")).toContain("query");
        expect(columns(db, "category_rules")).not.toContain("field");
        expect(columns(db, "categories")).toContain("counter_default");
        expect(columns(db, "categories")).not.toContain("system_key");
        db.exec(`
            INSERT INTO categories (id, parent_id, name, icon, color, position) VALUES (1, NULL, 'Umbuchung', 'arrow-left-right', 'neutral', 0);
            INSERT INTO category_rules (query, category_id, position, created_at) VALUES ('gegenseite:rewe', 1, 0, '2026-01-01T00:00:00Z');
        `);
        expect(db.prepare("SELECT counter_default AS preset FROM categories WHERE id = 1").get()).toEqual({ preset: 0 });
        expect(db.prepare("SELECT active FROM category_rules").get()).toEqual({ active: 1 });
    });

    it("drops the ignored accounts with their bank access", () => {
        db.exec(`
            INSERT INTO bank_connections (id, name, bank_name, blz, fints_url, icon, color, created_at) VALUES (1, 'Sparkasse', 'Sparkasse', '70054306', 'https://x.invalid', 'landmark', 'red', '2026-01-01T00:00:00Z');
            INSERT INTO bank_ignored_accounts (connection_id, external_id, created_at) VALUES (1, 'DE02', '2026-01-01T00:00:00Z');
        `);
        expect(() => db.exec("INSERT INTO bank_ignored_accounts (connection_id, external_id, created_at) VALUES (1, 'DE02', '2026-01-02T00:00:00Z')")).toThrow();
        db.exec("DELETE FROM bank_connections WHERE id = 1");
        expect(db.prepare("SELECT count(*) AS n FROM bank_ignored_accounts").get()).toEqual({ n: 0 });
    });

    it("never hands out a booking id again and releases a counter booking with its booking", () => {
        db.exec(`
            INSERT INTO accounts (id, name, kind, icon, color, position, created_at) VALUES (1, 'Giro', 'giro', 'bank', 'blue', 0, '2026-01-01T00:00:00Z');
            INSERT INTO accounts (id, name, kind, icon, color, position, created_at) VALUES (2, 'Bargeld', 'offline', 'banknote', 'green', 1, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, counterparty_name, status, first_seen_at, source, counter_transaction_id)
                VALUES (1, 1, '2026-11-01', -5000, 'Automat', 'booked', '2026-11-01T00:00:00Z', 'bank', NULL),
                       (2, 2, '2026-11-01', 5000, '', 'booked', '2026-11-01T00:00:00Z', 'manual', 1),
                       (3, 1, '2026-11-02', -1200, 'Kino', 'pending', '2026-11-02T00:00:00Z', 'bank', NULL);
            UPDATE transactions SET counter_transaction_id = 2 WHERE id = 1;
        `);
        // The pending booking goes, a new one comes: it gets a fresh id, not 3
        db.exec("DELETE FROM transactions WHERE id = 3");
        const id = Number(db.prepare("INSERT INTO transactions (account_id, booking_date, amount, status, first_seen_at, source) VALUES (1, '2026-11-03', -800, 'booked', '2026-11-03T00:00:00Z', 'bank')").run().lastInsertRowid);
        expect(id).toBe(4);
        db.exec("DELETE FROM transactions WHERE id = 1");
        expect(db.prepare("SELECT counter_transaction_id AS counter FROM transactions WHERE id = 2").get()).toEqual({ counter: null });
    });

    it("allows loan accounts, one account per bank access and external id, and keeps the full card number", () => {
        db.exec(`
            INSERT INTO accounts (id, connection_id, external_id, name, kind, icon, color, position, created_at)
                VALUES (1, 1, 'DE02', 'Giro', 'giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z');
            INSERT INTO accounts (id, name, kind, reference_account_id, icon, color, position, opening_balance, created_at)
                VALUES (2, 'Bargeld', 'offline', 1, 'banknote', 'green', 1, 1500, '2026-01-01T00:00:00Z');
            INSERT INTO accounts (id, name, kind, icon, color, position, created_at) VALUES (3, 'Darlehen', 'loan', 'percent', 'red', 2, '2026-01-01T00:00:00Z');
            INSERT INTO accounts (id, connection_id, external_id, card_number, name, kind, icon, color, position, created_at)
                VALUES (4, 1, '4111000000001234', '4111000000001234', 'Visa', 'credit_card', 'credit-card', 'blue', 3, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, status, first_seen_at, source) VALUES (1, 1, '2026-11-01', -5000, 'booked', '2026-11-01T00:00:00Z', 'bank');
        `);
        expect(columns(db, "accounts")).not.toContain("card_number_masked");
        expect(db.prepare("SELECT info_attributes AS a, info_notes AS n, orders_fetched_at AS o FROM accounts WHERE id = 3").get()).toEqual({ a: "[]", n: "", o: null });
        expect(() => db.exec("INSERT INTO accounts (name, kind, icon, color, position, created_at) VALUES ('Depot', 'depot', 'chart-line', 'red', 4, '2026-01-01T00:00:00Z')")).toThrow();
        expect(() => db.exec("INSERT INTO accounts (connection_id, external_id, name, kind, icon, color, position, created_at) VALUES (1, 'DE02', 'Doppelt', 'giro', 'landmark', 'blue', 5, '2026-01-01T00:00:00Z')")).toThrow();
        // Bookings go with their account, the reference account is released
        db.exec("DELETE FROM accounts WHERE id = 1");
        expect(db.prepare("SELECT count(*) AS n FROM transactions").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT reference_account_id AS ref FROM accounts WHERE id = 2").get()).toEqual({ ref: null });
    });
});

describe("0002-unread", () => {
    it("starts with nothing new and drops marks with their booking or user", () => {
        const db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        applyMigration(db, initial);
        db.exec(`
            INSERT INTO users (id, name, created_at) VALUES (1, 'Anna', '2026-01-01T00:00:00Z'), (2, 'Ben', '2026-01-01T00:00:00Z');
            INSERT INTO accounts (id, kind, name, icon, color, position, created_at) VALUES (1, 'offline', 'Bargeld', 'banknote', 'green', 0, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, status, first_seen_at, source) VALUES (1, 1, '2026-01-02', -100, 'booked', '2026-01-02T00:00:00Z', 'manual');
        `);
        applyMigration(db, unread);
        expect(db.prepare("SELECT count(*) AS n FROM transaction_unread").get()).toEqual({ n: 0 });
        db.exec("INSERT INTO transaction_unread (user_id, transaction_id) VALUES (1, 1), (2, 1)");
        expect(() => db.exec("INSERT INTO transaction_unread (user_id, transaction_id) VALUES (1, 1)")).toThrow();
        db.exec("DELETE FROM users WHERE id = 2");
        expect(db.prepare("SELECT user_id AS userId FROM transaction_unread").all()).toEqual([{ userId: 1 }]);
        db.exec("DELETE FROM transactions WHERE id = 1");
        expect(db.prepare("SELECT count(*) AS n FROM transaction_unread").get()).toEqual({ n: 0 });
        db.close();
    });
});

describe("0003-booking-details", () => {
    it("adds booking text and ultimate party, empty for bookings already there", () => {
        const db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        applyMigration(db, initial);
        applyMigration(db, unread);
        db.exec(`
            INSERT INTO accounts (id, kind, name, icon, color, position, created_at) VALUES (1, 'giro', 'Giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, status, first_seen_at, source, raw) VALUES
                (1, 1, '2026-01-02', -100, 'booked', '2026-01-02T00:00:00Z', 'bank', '{"bookingText":"KARTENZAHLUNG"}');
        `);
        applyMigration(db, bookingDetails);
        expect(db.prepare("SELECT booking_text AS t, ultimate_party AS u FROM transactions").get()).toEqual({ t: "", u: "" });
        db.close();
    });
});

describe("0004-import-formats", () => {
    it("adds the details, taking them from what was kept of a bank fetch only", () => {
        const db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        applyMigration(db, initial);
        applyMigration(db, unread);
        applyMigration(db, bookingDetails);
        db.exec(`
            INSERT INTO accounts (id, kind, name, icon, color, position, created_at) VALUES (1, 'giro', 'Giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, status, first_seen_at, source, end_to_end_id, raw) VALUES
                (1, 1, '2026-01-02', -100, 'booked', '2026-01-02T00:00:00Z', 'bank', 'E2E-1', '{"mandateId":"M1","creditorId":"C1","counterpartyBic":"BYLADEM1001","bankReference":"B1"}'),
                (2, 1, '2026-01-03', -100, 'booked', '2026-01-03T00:00:00Z', 'bank', 'NOTPROVIDED', '{"mandateId":null}'),
                (3, 1, '2026-01-04', -100, 'booked', '2026-01-04T00:00:00Z', 'bank', NULL, 'kein JSON'),
                (4, 1, '2026-01-05', -100, 'booked', '2026-01-05T00:00:00Z', 'import', 'E2E-4', '{"mandateId":"M4"}');
        `);
        applyMigration(db, importFormats);
        const rows = db.prepare("SELECT reference AS r, mandate_id AS m, creditor_id AS c, counterparty_bic AS b FROM transactions ORDER BY id").all();
        expect(rows).toEqual([
            { r: "E2E-1", m: "M1", c: "C1", b: "BYLADEM1001" },
            { r: "", m: "", c: "", b: "" },
            { r: "", m: "", c: "", b: "" },
            { r: "", m: "", c: "", b: "" },
        ]);
        db.exec("INSERT INTO import_formats (name, definition, created_at, updated_at) VALUES ('Format', '{}', 'x', 'x')");
        expect(() => db.exec("INSERT INTO import_formats (name, definition, created_at, updated_at) VALUES ('FORMAT', '{}', 'x', 'x')")).toThrow();
        db.close();
    });
});

describe("0005-booking-returns", () => {
    it("marks stored return debits, links one return per booking and lets go when a booking is deleted", () => {
        const db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        for (const m of [initial, unread, bookingDetails, importFormats]) applyMigration(db, m);
        db.exec(`
            INSERT INTO accounts (id, kind, name, icon, color, position, created_at) VALUES (1, 'giro', 'Giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, status, first_seen_at, source, booking_text) VALUES
                (1, 1, '2026-01-02', -100, 'booked', 'x', 'bank', 'LASTSCHRIFT'),
                (2, 1, '2026-01-03', 100, 'booked', 'x', 'bank', 'RUECKLASTSCHRIFT'),
                (3, 1, '2026-01-04', 100, 'booked', 'x', 'bank', 'Rücklastschrift'),
                (4, 1, '2026-01-05', 100, 'booked', 'x', 'bank', 'RÜCKLASTSCHRIFT');
        `);
        applyMigration(db, bookingReturns);
        expect(db.prepare("SELECT id FROM transactions WHERE is_return = 1 ORDER BY id").all()).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
        db.exec("UPDATE transactions SET return_of_id = 1 WHERE id = 2");
        expect(() => db.exec("UPDATE transactions SET return_of_id = 1 WHERE id = 3")).toThrow();
        db.exec("DELETE FROM transactions WHERE id = 1");
        expect(db.prepare("SELECT return_of_id AS r FROM transactions WHERE id = 2").get()).toEqual({ r: null });
        db.close();
    });
});

describe("0006-counterparty-account", () => {
    it("adds account and bank code, empty for bookings already there", () => {
        const db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        for (const m of [initial, unread, bookingDetails, importFormats, bookingReturns]) applyMigration(db, m);
        db.exec(`
            INSERT INTO accounts (id, kind, name, icon, color, position, created_at) VALUES (1, 'giro', 'Giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, status, first_seen_at, source) VALUES (1, 1, '2026-01-02', -100, 'booked', 'x', 'bank');
        `);
        applyMigration(db, counterpartyAccount);
        expect(db.prepare("SELECT counterparty_account AS a, counterparty_bank_code AS b FROM transactions").get()).toEqual({ a: "", b: "" });
        db.close();
    });
});

describe("0007-rule-actions", () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        for (const m of [initial, unread, bookingDetails, importFormats, bookingReturns, counterpartyAccount]) applyMigration(db, m);
        db.exec(`
            INSERT INTO categories (id, parent_id, name, icon, color, position) VALUES (1, NULL, 'Lebensmittel', 'tag', 'green', 0);
            INSERT INTO accounts (id, name, kind, icon, color, position, created_at) VALUES (1, 'Giro', 'giro', 'bank', 'blue', 0, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, status, first_seen_at, source) VALUES (1, 1, '2026-01-01', -100, 'booked', '2026-01-01T00:00:00Z', 'bank'), (2, 1, '2026-01-02', -200, 'booked', '2026-01-01T00:00:00Z', 'bank');
            INSERT INTO category_rules (id, query, category_id, position, active, created_at) VALUES (7, 'gegenseite:rewe konto:giro', 1, 3, 0, '2026-01-01T00:00:00Z'), (9, 'zweck:miete', 1, 1, 1, '2026-01-02T00:00:00Z');
            INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (1, 1, -100, 'rule', 7);
        `);
        applyMigration(db, ruleActions);
    });
    afterEach(() => db.close());

    it("keeps ids, order, queries and the link of assigned categories", () => {
        expect(db.prepare("SELECT id, query, category_id, position, active, name, extracts, edits, all_accounts FROM rules ORDER BY position").all()).toEqual([
            { id: 9, query: "zweck:miete", category_id: 1, position: 1, active: 1, name: "", extracts: "[]", edits: "[]", all_accounts: 1 },
            { id: 7, query: "gegenseite:rewe konto:giro", category_id: 1, position: 3, active: 0, name: "", extracts: "[]", edits: "[]", all_accounts: 1 },
        ]);
        expect(db.prepare("SELECT rule_id FROM transaction_categories").get()).toEqual({ rule_id: 7 });
        expect((db.pragma("foreign_key_list(transaction_categories)") as { table: string; from: string }[]).find((f) => f.from === "rule_id")?.table).toBe("rules");
        db.exec("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (2, 1, -200, 'rule', 9)");
        expect(db.prepare("SELECT count(*) AS n FROM transaction_edits").get()).toEqual({ n: 0 });
    });

    it("clears the link when a rule goes and keeps a rule whose category goes", () => {
        db.exec("DELETE FROM rules WHERE id = 7");
        expect(db.prepare("SELECT rule_id FROM transaction_categories").get()).toEqual({ rule_id: null });
        db.exec("DELETE FROM categories WHERE id = 1");
        expect(db.prepare("SELECT category_id FROM rules WHERE id = 9").get()).toEqual({ category_id: null });
    });
});

describe("0008-booking-references", () => {
    it("adds customer and bank reference, the bank reference from what was kept of a bank fetch", () => {
        const db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        for (const m of [initial, unread, bookingDetails, importFormats, bookingReturns, counterpartyAccount, ruleActions]) applyMigration(db, m);
        db.exec(`
            INSERT INTO accounts (id, kind, name, icon, color, position, created_at) VALUES (1, 'giro', 'Giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z');
            INSERT INTO transactions (id, account_id, booking_date, amount, status, first_seen_at, source, raw) VALUES
                (1, 1, '2026-01-02', -100, 'booked', 'x', 'bank', '{"bankReference":" B1 "}'),
                (2, 1, '2026-01-03', -100, 'booked', 'x', 'bank', '{"bankReference":null}'),
                (3, 1, '2026-01-04', -100, 'booked', 'x', 'bank', 'kein JSON'),
                (4, 1, '2026-01-05', -100, 'booked', 'x', 'bank', NULL),
                (5, 1, '2026-01-06', -100, 'booked', 'x', 'import', '{"bankReference":"B5"}');
        `);
        applyMigration(db, bookingReferences);
        expect(db.prepare("SELECT customer_reference AS k, bank_reference AS b FROM transactions ORDER BY id").all()).toEqual([
            { k: "", b: "B1" },
            { k: "", b: "" },
            { k: "", b: "" },
            { k: "", b: "" },
            { k: "", b: "" },
        ]);
        db.close();
    });
});

describe("0009-transactions-fetched-at", () => {
    it("adds the time of the last fetch, empty for accounts already there", () => {
        const db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        for (const m of [initial, unread, bookingDetails, importFormats, bookingReturns, counterpartyAccount, ruleActions, bookingReferences]) applyMigration(db, m);
        db.exec("INSERT INTO accounts (id, kind, name, icon, color, position, created_at) VALUES (1, 'giro', 'Giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z')");
        applyMigration(db, transactionsFetchedAt);
        expect(db.prepare("SELECT transactions_fetched_at AS f FROM accounts").get()).toEqual({ f: null });
        db.close();
    });
});
