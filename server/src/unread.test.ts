import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account, TransactionList, UnreadCounts } from "@mbm/shared";
import { confirmCode, createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { unreadCounts } from "./services/unread.js";

let t: TestApp;
beforeEach(async () => {
    t = await createTestApp();
});
afterEach(async () => {
    await t.close();
});

const CSV = ["Buchungstag;Betrag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck", "01.10.2026;-950,00;Hausverwaltung;Miete Oktober", "02.10.2026;-12,50;Bäckerei Huber;Brot"].join("\n");

/** Anna signed in, Ben as a second user, an offline account with two imported and one manual booking. */
async function setUp() {
    const { api, secret } = await setUpSignedIn(t);
    const ben = (await api<{ id: number }>("POST", "/api/users", { name: "Ben", password: "noch-ein-passwort", code: confirmCode(t, secret) })).body;
    const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
    const other = (await api<Account>("POST", "/api/accounts", { name: "Sparbuch" })).body;
    const imported = (await api<{ importId: number }>("POST", `/api/accounts/${cash.id}/import`, { fileName: "x.csv", content: CSV })).body;
    await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-10-03", amount: -500, counterpartyName: "Kiosk" });
    await api("POST", `/api/accounts/${other.id}/import`, { fileName: "y.csv", content: CSV });
    const list = async (q = "") => (await api<TransactionList>("GET", `/api/transactions?range=all${q}`)).body;
    const counts = async () => (await api<UnreadCounts>("GET", "/api/transactions/unread")).body;
    return { api, ben, cash, other, importId: imported.importId, list, counts };
}

describe("new bookings", () => {
    it("are new for the other users after an import, never for the importer, never when booked by hand", async () => {
        const { ben, cash, other, list, counts } = await setUp();
        expect(await counts()).toEqual({ accounts: [], total: 0 });
        expect((await list()).items.every((x) => !x.unread)).toBe(true);
        const db = t.vault.database;
        expect(unreadCounts(db, ben.id)).toEqual({ accounts: [{ accountId: cash.id, count: 2 }, { accountId: other.id, count: 2 }], total: 4 });
    });

    it("count per account, show in the list and can be marked as read and as new again", async () => {
        const { api, cash, other, list, counts } = await setUp();
        const db = t.vault.database;
        const anna = (await api<{ id: number }>("GET", "/api/auth/me")).body.id;
        // As if a bank had brought them: new for Anna as well
        db.prepare("INSERT INTO transaction_unread (user_id, transaction_id) SELECT ?, id FROM transactions WHERE source = 'import'").run(anna);
        expect(await counts()).toEqual({ accounts: [{ accountId: cash.id, count: 2 }, { accountId: other.id, count: 2 }], total: 4 });

        const items = (await list(`&scope=account:${cash.id}`)).items;
        const rent = items.find((x) => x.counterpartyName === "Hausverwaltung")!;
        expect(items.filter((x) => x.unread).map((x) => x.counterpartyName).sort()).toEqual(["Bäckerei Huber", "Hausverwaltung"]);
        expect((await list("&q=ist:neu")).count).toBe(4);
        expect((await list("&q=ist:neu miete")).count).toBe(2);

        expect((await api("POST", "/api/transactions/read", { ids: [rent.id] })).body).toEqual({ changed: 1 });
        expect((await api("POST", "/api/transactions/read", { ids: [rent.id] })).body).toEqual({ changed: 0 });
        expect((await counts()).accounts).toEqual([{ accountId: cash.id, count: 1 }, { accountId: other.id, count: 2 }]);
        expect((await list(`&scope=account:${cash.id}`)).items.find((x) => x.id === rent.id)!.unread).toBe(false);

        expect((await api("POST", "/api/transactions/read", { ids: [rent.id], unread: true })).body).toEqual({ changed: 1 });
        expect((await counts()).total).toBe(4);

        expect((await api("POST", "/api/transactions/read", { scope: `account:${other.id}` })).body).toEqual({ changed: 2 });
        expect(await counts()).toEqual({ accounts: [{ accountId: cash.id, count: 2 }], total: 2 });
    });

    it("refuses unclear requests", async () => {
        const { api, cash } = await setUp();
        expect((await api("POST", "/api/transactions/read", {})).status).toBe(400);
        expect((await api("POST", "/api/transactions/read", { ids: [1], scope: "all" })).status).toBe(400);
        expect((await api("POST", "/api/transactions/read", { scope: `account:${cash.id}`, unread: true })).status).toBe(400);
        // Unknown bookings are left alone
        expect((await api("POST", "/api/transactions/read", { ids: [9999], unread: true })).body).toEqual({ changed: 0 });
    });

    it("go with their bookings and with their user", async () => {
        const { api, ben, importId } = await setUp();
        const db = t.vault.database;
        const rows = () => (db.prepare("SELECT count(*) AS n FROM transaction_unread").get() as { n: number }).n;
        expect(rows()).toBe(4);
        await api("DELETE", `/api/imports/${importId}`);
        expect(rows()).toBe(2);
        db.prepare("DELETE FROM users WHERE id = ?").run(ben.id);
        expect(rows()).toBe(0);
    });
});
