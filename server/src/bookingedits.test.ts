// Bookings by hand on a bank account, deleting any booking, changing amount and date: the balance
// stays the bank's and the fetch neither brings back nor doubles a booking.

import { ConnectorTransaction, formatSignedCents, type Account, type ImportRecord, type Transaction, type TransactionList } from "@mbm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFetch } from "./services/fetchimport.js";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";

const OWN = "DE02700543060001234567";
const WERKE = "DE89370400440532013000";

const booking = (over: Record<string, unknown> = {}) => ({
    bookingDate: "2026-10-30", valueDate: "2026-10-30", amount: -5000, currency: "EUR", status: "booked", counterpartyName: "Stadtwerke", ultimateParty: "", counterpartyIban: WERKE, counterpartyBic: null,
    remittance: "Strom", endToEndId: null, mandateId: null, creditorId: null, bookingText: "", bankReference: null, isReturn: false, returnReason: "", ...over,
});
const coffee = (over: Record<string, unknown> = {}) => booking({ bookingDate: "2026-11-02", valueDate: "2026-11-02", amount: -350, counterpartyName: "Café Probe", counterpartyIban: null, remittance: "Kaffee", ...over });

let t: TestApp;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];
let accountId: number;

/** A fetch with these bookings and, unless null, PayPal-like booked balance. */
const fetched = (txs: unknown[], booked: number | null) =>
    applyFetch(t.vault.database, accountId, ConnectorTransaction.array().parse(txs), booked === null ? null : { externalId: OWN, booked, currency: "EUR", date: "2026-11-20", pending: null, available: null, creditLine: null }, null);
const list = async (query = "") => (await api<TransactionList>("GET", `/api/transactions?range=all${query}`)).body.items.sort((a, b) => a.id - b.id);
const balance = async () => (await api<Account[]>("GET", "/api/accounts")).body.find((a) => a.id === accountId)!.balance;
const balanceAt = async (date: string) =>
    (await api<{ points: { date: string; balance: number }[] }>("GET", `/api/stats/series?scope=account:${accountId}&from=${date}&to=${date}`)).body.points.find((p) => p.date === date)?.balance;
const rowCount = () => (t.vault.database.prepare("SELECT count(*) AS n FROM transactions WHERE account_id = ?").get(accountId) as { n: number }).n;

beforeEach(async () => {
    t = await createTestApp();
    ({ api } = await setUpSignedIn(t));
    accountId = Number(
        t.vault.database.prepare("INSERT INTO accounts (kind, name, icon, color, position, created_at, iban) VALUES ('giro', 'Giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z', ?)").run(OWN).lastInsertRowid,
    );
});

afterEach(async () => {
    await t.close();
});

describe("bookings by hand on a bank account", () => {
    it("keeps the bank's balance and is taken over by the bank's booking", async () => {
        fetched([booking()], 100_000);
        expect(await balance()).toBe(100_000);
        const made = await api<Transaction>("POST", `/api/accounts/${accountId}/transactions`, { bookingDate: "2026-11-02", amount: -350, counterpartyName: "Café Probe", remittance: "Kaffee" });
        expect(made.status).toBe(200);
        // The balance stays the bank's, the history before the booking moves
        expect(await balance()).toBe(100_000);

        fetched([booking(), coffee()], 100_000);
        const items = await list();
        expect(items.map((x) => [x.id, x.source, x.amount])).toEqual([
            [items[0]!.id, "bank", -5000],
            [made.body.id, "bank", -350],
        ]);
        expect(await balance()).toBe(100_000);
    });

    it("is changed and deleted for good", async () => {
        fetched([booking()], 100_000);
        const made = (await api<Transaction>("POST", `/api/accounts/${accountId}/transactions`, { bookingDate: "2026-11-02", amount: -350, counterpartyName: "Café Probe" })).body;
        expect((await api<Transaction>("PATCH", `/api/transactions/${made.id}`, { amount: -400, remittance: "Kuchen" })).body).toMatchObject({ amount: -400, remittance: "Kuchen", original: null });
        expect(await balance()).toBe(100_000);
        expect((await api("DELETE", `/api/transactions/${made.id}`)).status).toBe(200);
        expect(rowCount()).toBe(1);
        expect(await balance()).toBe(100_000);
    });

    it("is booked with an amount other than 0 and may be changed to 0", async () => {
        const url = `/api/accounts/${accountId}/transactions`;
        expect((await api("POST", url, { bookingDate: "2026-11-02", amount: 0, counterpartyName: "Null" })).status).toBe(400);
        const made = (await api<Transaction>("POST", url, { bookingDate: "2026-11-02", amount: -350, counterpartyName: "Café Probe" })).body;
        expect((await api<Transaction>("PATCH", `/api/transactions/${made.id}`, { amount: 0 })).body).toMatchObject({ amount: 0 });
    });
});

describe("deleting bookings of the bank", () => {
    it("keeps a deleted booking from coming back and brings it back on restore", async () => {
        fetched([booking(), coffee()], 100_000);
        const [, cup] = await list();
        expect((await api("DELETE", `/api/transactions/${cup!.id}`)).status).toBe(200);
        expect((await list()).map((x) => x.id)).not.toContain(cup!.id);
        expect(await balance()).toBe(100_000);
        expect((await list("&deleted=true")).map((x) => x.id)).toEqual([cup!.id]);
        // Deleted twice is refused, changed while deleted too
        expect((await api("DELETE", `/api/transactions/${cup!.id}`)).status).toBe(409);
        expect((await api("PATCH", `/api/transactions/${cup!.id}`, { amount: -1 })).status).toBe(409);

        // The next fetch, and one from the start, bring it as before: it stays deleted
        fetched([booking(), coffee()], 100_000);
        fetched([booking(), coffee()], 100_000);
        expect(rowCount()).toBe(2);
        expect((await list()).length).toBe(1);
        expect(await balance()).toBe(100_000);

        const restored = (await api<Transaction>("POST", `/api/transactions/${cup!.id}/restore`)).body;
        expect(restored).toMatchObject({ id: cup!.id, deletedAt: null });
        expect((await list()).length).toBe(2);
        expect(await balance()).toBe(100_000);
        expect((await api("POST", `/api/transactions/${cup!.id}/restore`)).status).toBe(409);
    });

    it("leaves a deleted booking out of figures and the activity log keeps it", async () => {
        fetched([booking(), coffee()], 100_000);
        const [, cup] = await list();
        await api("DELETE", `/api/transactions/${cup!.id}`);
        const flow = (await api<{ expenses: number; count: number }>("GET", `/api/stats/cashflow?scope=account:${accountId}&from=2026-10-01&to=2026-11-30`)).body;
        expect(flow).toMatchObject({ expenses: -5000, count: 1 });
        const log = (await api<{ action: string; target: string; details: string }[]>("GET", "/api/activity")).body;
        expect(log.find((e) => e.action === "transaction_deleted")).toMatchObject({ target: "Giro", details: `02.11.2026, ${formatSignedCents(-350)}` });
    });

    it("keeps a deleted pending booking deleted once it is booked", async () => {
        fetched([booking(), coffee({ status: "pending" })], 100_000);
        const [, pending] = await list();
        expect(pending!.status).toBe("pending");
        await api("DELETE", `/api/transactions/${pending!.id}`);
        // Pending again, then booked: deleted both times, never new
        fetched([booking(), coffee({ status: "pending" })], 100_000);
        expect((await list()).length).toBe(1);
        const result = fetched([booking(), coffee()], 99_650);
        expect(result.newTransactions).toBe(0);
        expect((await list()).length).toBe(1);
        const deleted = await list("&deleted=true");
        expect(deleted.map((x) => x.status)).toEqual(["booked"]);
        expect(deleted[0]!.unread).toBe(false);
        expect(await balance()).toBe(99_650);
    });
});

describe("changing amount and date of a booking of the bank", () => {
    it("keeps the bank's values, the balance and the booking at the next fetch", async () => {
        fetched([booking(), coffee()], 100_000);
        const before = await balanceAt("2026-10-31");
        const [, cup] = await list();
        const changed = (await api<Transaction>("PATCH", `/api/transactions/${cup!.id}`, { amount: -500, bookingDate: "2026-11-05" })).body;
        expect(changed).toMatchObject({ amount: -500, bookingDate: "2026-11-05", original: { amount: -350, bookingDate: "2026-11-02" } });
        // The balance stays the bank's: the history before the booking moves by the difference
        expect(await balance()).toBe(100_000);
        expect(await balanceAt("2026-10-31")).toBe(before! + 150);

        fetched([booking(), coffee()], 100_000);
        expect(rowCount()).toBe(2);
        expect((await list())[1]).toMatchObject({ amount: -500, bookingDate: "2026-11-05" });
        expect(await balance()).toBe(100_000);

        // The bank's values again: unchanged
        expect((await api<Transaction>("PATCH", `/api/transactions/${cup!.id}`, { amount: -350, bookingDate: "2026-11-02" })).body.original).toBeNull();
        expect(await balanceAt("2026-10-31")).toBe(before);
    });

    it("may set the amount to 0", async () => {
        fetched([booking(), coffee()], 100_000);
        const [, cup] = await list();
        const changed = (await api<Transaction>("PATCH", `/api/transactions/${cup!.id}`, { amount: 0 })).body;
        expect(changed).toMatchObject({ amount: 0, original: { amount: -350, bookingDate: "2026-11-02" } });
        expect(await balance()).toBe(100_000);
    });

    it("refuses other fields and pending bookings", async () => {
        fetched([booking(), coffee({ status: "pending" })], 100_000);
        const [bill, pending] = await list();
        expect((await api("PATCH", `/api/transactions/${bill!.id}`, { counterpartyName: "Andere" })).status).toBe(400);
        expect((await api("PATCH", `/api/transactions/${bill!.id}`, { categoryId: null })).status).toBe(400);
        expect((await api("PATCH", `/api/transactions/${pending!.id}`, { amount: -1 })).status).toBe(409);
    });

    it("still links a return and finds the booking in an import", async () => {
        fetched([booking()], 100_000);
        const [bill] = await list();
        await api("PATCH", `/api/transactions/${bill!.id}`, { amount: -4000, bookingDate: "2026-10-28" });
        fetched([booking(), booking({ bookingDate: "2026-11-03", amount: 5000, bookingText: "RUECKLASTSCHRIFT", isReturn: true, returnReason: "AM04" })], 105_000);
        const [debit, back] = await list();
        expect(back!.returnOfId).toBe(debit!.id);

        const csv = "Datum;Betrag;Name;IBAN\n30.10.2026;-50,00;Stadtwerke;" + WERKE + "\n";
        const preview = await api<{ rows: { state: string }[] }>("POST", `/api/accounts/${accountId}/import/preview`, { fileName: "a.csv", content: csv });
        expect(preview.body.rows.map((r) => r.state)).toEqual(["duplicate"]);
    });
});

describe("deleting bookings from an import for good", () => {
    const CSV = "Datum;Betrag;Name\n01.02.2026;-5,00;Kiosk\n05.02.2026;5,00;Kiosk\n";
    const importFile = async () => (await api<{ importId: number; imported: number }>("POST", `/api/accounts/${accountId}/import`, { fileName: "a.csv", content: CSV })).body;
    const purge = (id: number) => api<{ error: string }>("DELETE", `/api/transactions/${id}/purge`);
    const record = async (id: number) => (await api<ImportRecord[]>("GET", "/api/imports")).body.find((i) => i.id === id)!;

    it("removes a deleted booking with all it holds; the same file brings it back", async () => {
        const { importId } = await importFile();
        const [paid, refund] = await list();
        await api("PUT", `/api/transactions/${paid!.id}/edits/remittance`, { value: "Zeitung" });
        // The second row gives the first back
        t.vault.database.prepare("UPDATE transactions SET return_of_id = ? WHERE id = ?").run(paid!.id, refund!.id);
        await api("DELETE", `/api/transactions/${paid!.id}`);
        expect(await record(importId)).toMatchObject({ remaining: 1, deleted: 1 });
        const before = await balance();

        expect((await purge(paid!.id)).status).toBe(200);
        expect(rowCount()).toBe(1);
        expect(t.vault.database.prepare("SELECT count(*) AS n FROM transaction_edits WHERE transaction_id = ?").get(paid!.id)).toEqual({ n: 0 });
        expect(t.vault.database.prepare("SELECT return_of_id FROM transactions WHERE id = ?").get(refund!.id)).toEqual({ return_of_id: null });
        expect(await balance()).toBe(before);
        expect(await record(importId)).toMatchObject({ remaining: 1, deleted: 0 });
        expect((await list("&deleted=true")).length).toBe(0);
        const log = (await api<{ action: string; target: string; details: string }[]>("GET", "/api/activity")).body;
        expect(log.find((e) => e.action === "transaction_purged")).toMatchObject({ target: "Giro", details: `01.02.2026, ${formatSignedCents(-500)}` });

        // Nothing stands for its row any more
        expect((await importFile()).imported).toBe(1);
        expect((await purge(paid!.id)).status).toBe(404);
    });

    it("refuses a booking that is not deleted and one of the bank", async () => {
        await importFile();
        const [paid] = await list();
        const refused = await purge(paid!.id);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toBe("not_deleted");

        fetched([coffee()], null);
        const cup = (await list()).find((x) => x.source === "bank")!;
        await api("DELETE", `/api/transactions/${cup.id}`);
        const bank = await purge(cup.id);
        expect(bank.status).toBe(409);
        expect(bank.body.error).toBe("not_purgeable");
        expect(rowCount()).toBe(3);
    });

    it("in a PayPal account, refuses a payment only while its added booking is not deleted", async () => {
        await importFile();
        const [paid] = await list();
        const db = t.vault.database;
        const conn = db
            .prepare("INSERT INTO bank_connections (name, connector, bank_name, blz, fints_url, icon, color, created_at, aspsp, country) VALUES ('PayPal', 'enablebanking', 'PayPal', '', '', 'wallet', 'blue', '2026-01-01T00:00:00Z', 'PayPal', 'DE')")
            .run().lastInsertRowid;
        db.prepare("UPDATE accounts SET connection_id = ?, external_id = ? WHERE id = ?").run(conn, OWN, accountId);
        const added = Number(
            db
                .prepare("INSERT INTO transactions (account_id, booking_date, amount, counterparty_name, status, raw, first_seen_at, source, funding_of_id) VALUES (?, '2026-02-01', 500, 'Bankkonto oder Karte', 'booked', '{\"derived\":\"funding\"}', '2026-02-01T00:00:00Z', 'bank', ?)")
                .run(accountId, paid!.id).lastInsertRowid,
        );

        // Deleted with its payment: both go for good
        await api("DELETE", `/api/transactions/${paid!.id}`);
        const deleted = (await list("&deleted=true")).find((x) => x.id === paid!.id)!;
        expect(deleted.fundedById).toBeNull();

        // Brought back on its own, the added booking stays and keeps the payment
        await api("POST", `/api/transactions/${added}/restore`);
        const refused = await purge(paid!.id);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toBe("not_purgeable");

        await api("DELETE", `/api/transactions/${added}`);
        expect((await purge(paid!.id)).status).toBe(200);
        expect(rowCount()).toBe(1);
    });
});
