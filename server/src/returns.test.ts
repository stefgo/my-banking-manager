import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { applyFetch } from "./services/fetchimport.js";
import { linkBookedTransfers } from "./services/transfers.js";

const OWN = "DE02700543060001234567";
const WERKE = "DE89370400440532013000";

interface Tx {
    id: number;
    amount: number;
    counterpartyIban: string | null;
    categoryId: number | null;
    isReturn: boolean;
    returnReason: string;
    returnOfId: number | null;
    returnedById: number | null;
}

const booking = (over: Record<string, unknown>) => ({
    bookingDate: "2026-10-30", valueDate: "2026-10-30", amount: -5000, currency: "EUR", status: "booked", counterpartyName: "Stadtwerke", ultimateParty: "", counterpartyIban: WERKE, counterpartyBic: null,
    remittance: "Strom", endToEndId: null, mandateId: null, creditorId: null, bookingText: "", bankReference: null, isReturn: false, returnReason: "", ...over,
});
const giveBack = (over: Record<string, unknown> = {}) => booking({ bookingDate: "2026-11-02", amount: 5000, bookingText: "RUECKLASTSCHRIFT", isReturn: true, returnReason: "AM04", ...over });

let t: TestApp;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];
let accountId: number;

const fetched = (txs: unknown[], booked: number | null = null) =>
    applyFetch(t.vault.database, accountId, txs as never, booked === null ? null : { externalId: OWN, booked, currency: "EUR", date: "2026-11-20", pending: null, available: null, creditLine: null }, null);
const list = async () => (await api<{ items: Tx[] }>("GET", "/api/transactions?range=all")).body.items.sort((a, b) => a.id - b.id);
const flow = async (from: string, to: string) => (await api<{ income: number; expenses: number; count: number }>("GET", `/api/stats/cashflow?scope=account:${accountId}&from=${from}&to=${to}`)).body;

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

describe("returned bookings", () => {
    it.each([
        ["the reference", { endToEndId: "E2E-1", counterpartyIban: "DE11111111111111111111" }, { endToEndId: "E2E-1", counterpartyIban: "DE22222222222222222222" }],
        ["mandate and creditor", { mandateId: "M-1", creditorId: "C-1", counterpartyIban: "DE11111111111111111111" }, { mandateId: "M-1", creditorId: "C-1", counterpartyIban: "DE22222222222222222222" }],
        ["the counterparty's IBAN", {}, {}],
    ])("links a return by %s and gives it the category", async (_name, first, second) => {
        const category = (await api<{ id: number }>("POST", "/api/categories", { name: "Strom", parentId: null, icon: "coffee", color: "orange" })).body.id;
        fetched([booking(first)]);
        const [debit] = await list();
        await api("PUT", "/api/transactions/category", { ids: [debit!.id], categoryId: category });
        fetched([booking(first), giveBack(second)]);
        const [a, b] = await list();
        expect(a).toMatchObject({ returnedById: b!.id, isReturn: false });
        expect(b).toMatchObject({ returnOfId: a!.id, isReturn: true, returnReason: "AM04", categoryId: category });
    });

    it("links nothing without a sure match and keeps counting the booking", async () => {
        fetched([booking({}), giveBack({ counterpartyIban: "DE22222222222222222222" })]);
        expect((await list()).map((x) => x.returnOfId)).toEqual([null, null]);
        expect(await flow("2026-10-01", "2026-11-30")).toMatchObject({ income: 5000, expenses: -5000, count: 2 });
    });

    it("gives a return the latest of two equal bookings, and the other one still counts", async () => {
        const older = booking({ bookingDate: "2026-09-30", valueDate: "2026-09-30" });
        fetched([older, booking({}), giveBack()]);
        const [first, second, back] = await list();
        expect(back!.returnOfId).toBe(second!.id);
        expect(first!.returnedById).toBeNull();
        expect(await flow("2026-09-01", "2026-11-30")).toMatchObject({ income: 0, expenses: -5000, count: 1 });
    });

    it("lets a sure match win over a weaker one of an earlier return", async () => {
        const a = booking({ bookingDate: "2026-10-01", valueDate: "2026-10-01", endToEndId: "E2E-A" });
        const b = booking({ bookingDate: "2026-10-30", endToEndId: "E2E-B" });
        fetched([a, b, giveBack({ bookingDate: "2026-11-02", endToEndId: "OTHER" }), giveBack({ bookingDate: "2026-11-03", valueDate: "2026-11-03", endToEndId: "E2E-B" })]);
        const [first, second, weak, sure] = await list();
        expect(sure!.returnOfId).toBe(second!.id);
        expect(weak!.returnOfId).toBe(first!.id);
    });

    it("leaves a pair out of income, expenses and category sums across months, not out of the balance", async () => {
        const category = (await api<{ id: number }>("POST", "/api/categories", { name: "Strom", parentId: null, icon: "coffee", color: "orange" })).body.id;
        fetched([booking({})], 95000);
        const [debit] = await list();
        await api("PUT", "/api/transactions/category", { ids: [debit!.id], categoryId: category });
        expect(await flow("2026-10-01", "2026-10-31")).toMatchObject({ expenses: -5000 });
        fetched([booking({}), giveBack()], 100000);
        expect(await flow("2026-10-01", "2026-10-31")).toMatchObject({ income: 0, expenses: 0, count: 0 });
        expect(await flow("2026-11-01", "2026-11-30")).toMatchObject({ income: 0, expenses: 0, count: 0 });
        const sums = (await api<{ sums: { categoryId: number | null }[] }>("GET", `/api/stats/categories?scope=account:${accountId}&from=2026-10-01&to=2026-11-30`)).body.sums;
        expect(sums.find((s) => s.categoryId === category)).toBeUndefined();
        const account = (await api<{ id: number; balance: number; transactionCount: number }[]>("GET", "/api/accounts")).body.find((a) => a.id === accountId);
        expect(account).toMatchObject({ balance: 100000, transactionCount: 2 });
    });

    it("counts a new debit after the return like any other", async () => {
        fetched([booking({}), giveBack(), booking({ bookingDate: "2026-11-10", valueDate: "2026-11-10" })]);
        expect(await flow("2026-10-01", "2026-11-30")).toMatchObject({ income: 0, expenses: -5000, count: 1 });
    });

    it("adds nothing on the next fetch", async () => {
        const txs = [booking({}), giveBack()];
        fetched(txs);
        const before = await list();
        fetched(txs);
        expect(await list()).toEqual(before);
    });

    it("corrects a return stored with this account as counterparty instead of adding it again", async () => {
        const category = (await api<{ id: number }>("POST", "/api/categories", { name: "Strom", parentId: null, icon: "coffee", color: "orange" })).body.id;
        fetched([booking({ endToEndId: "E2E-1" }), giveBack({ endToEndId: "E2E-1", counterpartyName: "Konto Inhaber", counterpartyIban: OWN, isReturn: false, returnReason: "", bookingText: "GUTSCHRIFT" })]);
        const [, stored] = await list();
        await api("PUT", "/api/transactions/category", { ids: [stored!.id], categoryId: category });
        fetched([booking({ endToEndId: "E2E-1" }), giveBack({ endToEndId: "E2E-1" })]);
        const items = await list();
        expect(items).toHaveLength(2);
        expect(items[1]).toMatchObject({ id: stored!.id, counterpartyIban: WERKE, isReturn: true, returnReason: "AM04", returnOfId: items[0]!.id, categoryId: category });
    });

    it("marks a booking stored before as a return when the bank says so", async () => {
        fetched([booking({}), giveBack({ isReturn: false, returnReason: "", bookingText: "GUTSCHRIFT" })]);
        expect((await list())[1]).toMatchObject({ isReturn: false, returnOfId: null });
        fetched([booking({}), giveBack({ bookingText: "GUTSCHRIFT" })]);
        const [a, b] = await list();
        expect(b).toMatchObject({ isReturn: true, returnReason: "AM04", returnOfId: a!.id });
    });

    it("does not confirm a transfer by its return", () => {
        const db = t.vault.database;
        db.prepare(
            "INSERT INTO transfers (request_id, account_id, created_by, created_by_name, payee_name, payee_iban, amount, remittance, end_to_end_id, status, created_at, updated_at) VALUES ('r', ?, 1, 'Anna', 'X', ?, 5000, '', 'MBM-1', 'unknown', 'x', 'x')",
        ).run(accountId, WERKE);
        fetched([giveBack({ endToEndId: "MBM-1" })]);
        expect(linkBookedTransfers(db, accountId)).toBe(0);
        expect(db.prepare("SELECT status, transaction_id AS tx FROM transfers").get()).toEqual({ status: "unknown", tx: null });
        fetched([giveBack({ endToEndId: "MBM-1" }), booking({ endToEndId: "MBM-1" })]);
        expect(db.prepare("SELECT status FROM transfers").get()).toEqual({ status: "executed" });
    });

    it("recognizes and links a return from a CSV file", async () => {
        const content = [
            "Buchungstag;Buchungstext;Beguenstigter/Zahlungspflichtiger;IBAN;Verwendungszweck;Betrag",
            `30.10.2026;LASTSCHRIFT;Stadtwerke;${WERKE};Strom;-50,00`,
            `02.11.2026;Rücklastschrift;Stadtwerke;${WERKE};Strom;50,00`,
        ].join("\n");
        await api("POST", `/api/accounts/${accountId}/import`, { fileName: "x.csv", content });
        const [a, b] = await list();
        expect(b).toMatchObject({ isReturn: true, returnOfId: a!.id });
    });
});
