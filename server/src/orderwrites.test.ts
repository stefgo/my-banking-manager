// Writing orders (M5b part 2) through the server, against the fake connector: creating, changing
// and deleting standing orders and scheduled transfers run as transfers, and a fetch of the
// orders afterwards shows what the bank holds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { startFakeConnector, type FakeConnector } from "./testing/fakeConnector.js";

let t: TestApp;
let fc: FakeConnector;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];

const DAYS = [...Array.from({ length: 30 }, (_, i) => i + 1), 99];
const RULES = {
    scheduled: { minDays: 1, maxDays: 360 },
    scheduledChange: { minDays: 1, maxDays: 360 },
    standing: { minDays: 0, maxDays: 9999, months: [1, 2, 3, 6, 12], monthDays: DAYS, weeks: [], weekDays: [] },
    standingChange: {
        minDays: 0, maxDays: 9999, months: [1, 2, 3, 6, 12], monthDays: DAYS, weeks: [], weekDays: [],
        changeable: { payeeAccount: true, payeeName: true, amount: true, remittance: true, firstDate: true, unit: false, every: true, executionDay: true, lastDate: true },
    },
};
const caps = {
    balance: true, transactions: true, cardTransactions: false, transfer: true, instantTransfer: false, standingOrders: true, scheduledTransfers: true, standingOrdersTan: false, scheduledTransfersTan: false, payeeVerification: true,
    createScheduledTransfer: true, changeScheduledTransfer: true, deleteScheduledTransfer: true, createStandingOrder: true, changeStandingOrder: true, deleteStandingOrder: true, orderRules: RULES,
};
const acc = (iban: string, kind: string, name: string, capabilities: object = caps) => ({ accountNumber: iban.slice(-7), subAccount: "", iban, bic: null, externalId: iban, name, owner: "Anna", currency: "EUR", kind, capabilities });
const GIRO = acc("DE02700543060001234567", "giro", "Girokonto");

const order = (over: Record<string, unknown>) => ({ bankOrderId: null, payeeName: "", payeeIban: "DE89370400440532013000", payeeBic: null, amount: 1000, currency: "EUR", remittance: "", endToEndId: null, canChange: null, canDelete: null, ...over });
const RENT = order({ bankOrderId: "DA-1", payeeName: "Hausverwaltung", amount: 85000, remittance: "Miete", canChange: true, canDelete: true, firstDate: "2024-01-01", unit: "month", every: 1, executionDay: 1, lastDate: null });
const BILL = order({ bankOrderId: "TU-1", payeeName: "Handwerker", amount: 43120, remittance: "Rechnung 4711", canChange: false, executionDate: "2026-12-05" });
const NO_ID = order({ payeeName: "Verein", amount: 1200, firstDate: "2026-01-01", unit: "month", every: 1, executionDay: 15, lastDate: null });

const MATCH = { result: "match", payeeName: null, reason: null, explanation: "", structured: false };
const NONE = { ...MATCH, result: "none" };
const OP = "00000000-0000-4000-8000-0000000000b1";
const decoupled = { decoupled: true, text: "In der App freigeben.", medium: "", validUntil: "", methodName: "pushTAN" };

let standing: unknown[] = [];
let scheduled: unknown[] = [];

type T = {
    id: number; status: string; execution: string; action: string; executionDate: string | null; recurrence: object | null;
    orderId: number | null; bankOrderId: string | null; previous: { amount: number } | null; bankMessage: string | null; endToEndId: string;
};
type OrderView = { id: number; kind: string; payeeName: string; amount: number };

beforeEach(async () => {
    // Only the clock is faked: "today" is Tuesday, 17 November 2026
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 17, 12));
    fc = await startFakeConnector();
    t = await createTestApp({ connectors: { fints: { socket: fc.socket } }, bankPollMs: 20 });
    ({ api } = await setUpSignedIn(t));
    standing = [RENT, NO_ID];
    scheduled = [BILL];
    fc.on("checkBank", () => ({ bankName: "Sparkasse", bpdVersion: 1, pinTan: true, jobs: [] }));
    fc.on("tanMethods", () => ({ status: "done", data: { methods: [{ id: "923", name: "pushTAN", decoupled: true, needsMedium: false }] }, state: "S0" }));
    fc.on("accounts", () => ({ status: "done", data: { accounts: [GIRO] }, state: "S1" }));
    fc.on("standingOrders", () => ({ status: "done", data: { orders: standing }, state: "S4" }));
    fc.on("scheduledTransfers", () => ({ status: "done", data: { orders: scheduled }, state: "S5" }));
});

afterEach(async () => {
    await t.close();
    await fc.close();
    vi.useRealTimers();
});

const calls = (route: string) => fc.received.filter((r) => r.route === route);

async function setUpAccess(): Promise<number> {
    const { body: conn } = await api<{ id: number }>("POST", "/api/bank-connections", { blz: "70054306", fintsUrl: "https://bank.example.invalid/fints" });
    await api("PUT", `/api/bank-connections/${conn.id}/login`, { loginName: "anna1234567", pin: "1234", savePin: true });
    await api("PUT", `/api/bank-connections/${conn.id}/login/tan-method`, { tanMethod: "923" });
    await api("POST", `/api/bank-connections/${conn.id}/login/accounts`);
    const { body } = await api<{ created: number[] }>("POST", `/api/bank-connections/${conn.id}/accounts`, { accounts: [{ externalId: GIRO.externalId }] });
    return body.created[0]!;
}

async function until<X>(get: () => Promise<X>, pred: (x: X) => boolean, what: string): Promise<X> {
    for (let i = 0; i < 300; i++) {
        const x = await get();
        if (pred(x)) return x;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${what}`);
}
const transfer = (id: number) => api<T>("GET", `/api/transfers/${id}`).then((r) => r.body);
const waitFor = (id: number, pred: (x: T) => boolean) => until(() => transfer(id), pred, "transfer");
const ordersNow = () => api<{ orders: OrderView[] }>("GET", "/api/orders").then((r) => r.body.orders);

/** Fetches the orders once, so that MBM knows them, and returns them. */
async function fetchOrders(): Promise<OrderView[]> {
    const before = calls("scheduledTransfers").length;
    await api("POST", "/api/orders/fetch", {});
    await until(async () => calls("scheduledTransfers").length, (n) => n > before, "orders");
    return until(ordersNow, (o) => o.length === standing.length + scheduled.length, "orders stored");
}

const payment = { payeeName: "Erika Mustermann", payeeIban: "DE89 3704 0044 0532 0130 00", amount: 2500, remittance: "Beitrag" };

describe("writing orders", () => {
    it("tells the client what the account may do and the bank's rules", async () => {
        await setUpAccess();
        const { body } = await api<object[]>("GET", "/api/transfers/accounts");
        expect(body[0]).toMatchObject({ transfer: true, scheduled: true, standing: true, orderRules: RULES });
        await fetchOrders();
        const orders = await api<{ accounts: object[] }>("GET", "/api/orders");
        expect(orders.body.accounts[0]).toMatchObject({ createScheduled: true, changeStanding: true, deleteScheduled: true });
    });

    it("submits a scheduled transfer, and fetches the orders afterwards to link it", async () => {
        const giro = await setUpAccess();
        fc.on("createScheduledTransfer", () => ({ status: "approval", operationId: OP, challenge: decoupled, vop: MATCH }));
        fc.on("operation", () => {
            scheduled = [BILL, order({ bankOrderId: "TU-9", payeeName: "Erika Mustermann", amount: 2500, remittance: "Beitrag", executionDate: "2026-11-27" })];
            return { status: "done", data: { bankMessage: "Auftrag zur Ausführung vorgemerkt.", reference: null, bankOrderId: "TU-9", vop: MATCH }, state: "S9" };
        });
        const created = await api<T>("POST", "/api/transfers", { requestId: randomUUID(), accountId: giro, ...payment, execution: { kind: "date", date: "2026-11-27" } });
        expect(created.status).toBe(200);
        expect(created.body).toMatchObject({ execution: "date", action: "create", executionDate: "2026-11-27", recurrence: null });

        const done = await waitFor(created.body.id, (x) => x.status === "executed" && x.orderId !== null);
        expect(done).toMatchObject({ bankOrderId: "TU-9", bankMessage: "Auftrag zur Ausführung vorgemerkt." });
        expect(calls("createScheduledTransfer")[0]!.body.order).toEqual({ payeeName: "Erika Mustermann", payeeIban: "DE89370400440532013000", payeeBic: null, amount: 2500, remittance: "Beitrag", endToEndId: done.endToEndId, executionDate: "2026-11-27" });
        expect(calls("scheduledTransfers")).toHaveLength(1);
        const linked = (await ordersNow()).find((o) => o.id === done.orderId);
        expect(linked).toMatchObject({ kind: "scheduled", payeeName: "Erika Mustermann" });

        const activity = await api<{ action: string; details: string }[]>("GET", "/api/activity?limit=20");
        expect(activity.body.find((a) => a.action === "transfer_executed")?.details).toMatch(/^Terminüberweisung für 27\.11\.2026 an Erika Mustermann, 25,00\s€$/);
    });

    it("refuses what the bank's rules do not allow before anything is stored", async () => {
        const giro = await setUpAccess();
        const today = await api<{ message: string }>("POST", "/api/transfers", { requestId: randomUUID(), accountId: giro, ...payment, execution: { kind: "date", date: "2026-11-17" } });
        expect(today).toMatchObject({ status: 422, body: { error: "order_rules", message: "Ausführung: frühestens am 18.11.2026." } });
        const weekly = await api("POST", "/api/transfers", { requestId: randomUUID(), accountId: giro, ...payment, execution: { kind: "standing", firstDate: "2026-11-23", unit: "week", every: 1, executionDay: 1, lastDate: null } });
        expect(weekly.body).toMatchObject({ message: "Wöchentliche Daueraufträge bietet die Bank nicht an." });
        const instant = await api("POST", "/api/transfers", { requestId: randomUUID(), accountId: giro, ...payment, instant: true, execution: { kind: "date", date: "2026-11-27" } });
        expect(instant.status).toBe(400);
        expect((await api<T[]>("GET", "/api/transfers")).body).toEqual([]);
    });

    it("sets up a standing order with its rhythm", async () => {
        const giro = await setUpAccess();
        fc.on("createStandingOrder", () => ({ status: "done", data: { bankMessage: "Auftrag zur Ausführung vorgemerkt.", reference: null, bankOrderId: "DA-9", vop: MATCH }, state: "S9" }));
        const rhythm = { firstDate: "2026-12-31", unit: "month", every: 3, executionDay: 99, lastDate: null };
        const { body } = await api<T>("POST", "/api/transfers", { requestId: randomUUID(), accountId: giro, ...payment, execution: { kind: "standing", ...rhythm } });
        const done = await waitFor(body.id, (x) => x.status === "executed");
        expect(done).toMatchObject({ execution: "standing", recurrence: rhythm, bankOrderId: "DA-9" });
        expect(calls("createStandingOrder")[0]!.body.order.recurrence).toEqual(rhythm);
    });

    it("changes a standing order with the complete order and what it was before", async () => {
        const giro = await setUpAccess();
        const rent = (await fetchOrders()).find((o) => o.payeeName === "Hausverwaltung")!;
        fc.on("changeStandingOrder", () => ({ status: "approval", operationId: OP, challenge: decoupled, vop: MATCH }));
        fc.on("operation", () => ({ status: "done", data: { bankMessage: "SEPA-Dauerauftrag geändert.", reference: null, bankOrderId: "DA-1", vop: MATCH }, state: "S9" }));
        const rhythm = { firstDate: "2024-01-01", unit: "month", every: 1, executionDay: 1, lastDate: null };
        const res = await api<T>("POST", `/api/orders/standing/${rent.id}/change`, { requestId: randomUUID(), payeeName: "Hausverwaltung", payeeIban: RENT.payeeIban, amount: 90000, remittance: "Miete", execution: { kind: "standing", ...rhythm } });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ accountId: giro, action: "change", orderId: rent.id, bankOrderId: "DA-1", previous: { amount: 85000 } });
        await waitFor(res.body.id, (x) => x.status === "executed");
        expect(calls("changeStandingOrder")[0]!.body).toMatchObject({
            expected: { bankOrderId: "DA-1", payeeName: "Hausverwaltung", payeeIban: RENT.payeeIban, amount: 85000, remittance: "Miete", ...rhythm },
            order: { amount: 90000, recurrence: rhythm },
        });
    });

    it("refuses changes the bank does not allow: the unit, a locked order, an order without identification", async () => {
        await setUpAccess();
        const list = await fetchOrders();
        const rent = list.find((o) => o.payeeName === "Hausverwaltung")!;
        const body = { payeeName: "Hausverwaltung", payeeIban: RENT.payeeIban, amount: 85000, remittance: "Miete" };
        const unit = await api("POST", `/api/orders/standing/${rent.id}/change`, { requestId: randomUUID(), ...body, execution: { kind: "standing", firstDate: "2024-01-01", unit: "week", every: 1, executionDay: 1, lastDate: null } });
        expect(unit.body).toMatchObject({ error: "order_rules", message: "Die Bank erlaubt nicht, Zeiteinheit zu ändern." });
        const bill = list.find((o) => o.payeeName === "Handwerker")!;
        const locked = await api("POST", `/api/orders/scheduled/${bill.id}/change`, { requestId: randomUUID(), ...body, execution: { kind: "date", date: "2026-12-10" } });
        expect(locked).toMatchObject({ status: 422, body: { error: "not_changeable" } });
        const noId = list.find((o) => o.payeeName === "Verein")!;
        expect((await api("POST", `/api/orders/standing/${noId.id}/delete`, { requestId: randomUUID() })).body).toMatchObject({ error: "no_bank_order_id" });
        const kind = await api("POST", `/api/orders/standing/${rent.id}/change`, { requestId: randomUUID(), ...body, execution: { kind: "date", date: "2026-12-10" } });
        expect(kind.body).toMatchObject({ error: "wrong_kind" });
    });

    it("settles a deletion whose answer was lost once the order is gone from the bank's list", async () => {
        await setUpAccess();
        const bill = (await fetchOrders()).find((o) => o.payeeName === "Handwerker")!;
        fc.on("deleteScheduledTransfer", () => {
            scheduled = [];
            return { status: 502, json: { error: "outcome_unknown", message: "lost" } };
        });
        const { body } = await api<T>("POST", `/api/orders/scheduled/${bill.id}/delete`, { requestId: randomUUID() });
        expect(body).toMatchObject({ action: "delete", execution: "date", payeeName: "Handwerker", amount: 43120 });
        const done = await waitFor(body.id, (x) => x.status === "executed");
        expect(done.bankMessage).toBe("Der Auftrag ist nicht mehr im Bestand der Bank: Er wurde gelöscht.");
        expect(calls("deleteScheduledTransfer")[0]!.body.expected).toEqual({ bankOrderId: "TU-1", payeeName: "Handwerker", payeeIban: BILL.payeeIban, amount: 43120, remittance: "Rechnung 4711", executionDate: "2026-12-05" });
        expect(await ordersNow()).toHaveLength(2);
        // A deletion adds no payee
        expect((await api<{ payees: unknown[] }>("GET", "/api/transfers/payees")).body.payees).toHaveLength(0);
    });

    it("settles a new standing order whose answer was lost by its end-to-end ID in the bank's list", async () => {
        const giro = await setUpAccess();
        fc.on("createStandingOrder", (b: { order: { endToEndId: string } }) => {
            standing = [RENT, NO_ID, order({ bankOrderId: "DA-7", payeeName: "Erika Mustermann", amount: 2500, remittance: "Beitrag", endToEndId: b.order.endToEndId, firstDate: "2026-12-01", unit: "month", every: 1, executionDay: 1, lastDate: null })];
            return { status: 502, json: { error: "outcome_unknown", message: "lost" } };
        });
        const { body } = await api<T>("POST", "/api/transfers", { requestId: randomUUID(), accountId: giro, ...payment, execution: { kind: "standing", firstDate: "2026-12-01", unit: "month", every: 1, executionDay: 1, lastDate: null } });
        const done = await waitFor(body.id, (x) => x.status === "executed");
        expect(done).toMatchObject({ bankOrderId: "DA-7", bankMessage: "Der Bestand der Bank zeigt den Auftrag: Er wurde ausgeführt." });
        expect(done.orderId).not.toBeNull();
    });

    it("stays unknown when the bank's list does not show the order, and ends as failed when the order changed meanwhile", async () => {
        const giro = await setUpAccess();
        fc.on("createScheduledTransfer", () => ({ status: 502, json: { error: "outcome_unknown", message: "lost" } }));
        const { body } = await api<T>("POST", "/api/transfers", { requestId: randomUUID(), accountId: giro, ...payment, execution: { kind: "date", date: "2026-11-27" } });
        await waitFor(body.id, (x) => x.status === "unknown");
        await until(async () => calls("scheduledTransfers").length, (n) => n === 1, "fetch after unknown");
        await new Promise((r) => setTimeout(r, 50));
        expect((await transfer(body.id)).status).toBe("unknown");
        expect((await transfer(body.id)).bankMessage).toContain("MBM ruft die Aufträge neu ab");

        const rent = (await ordersNow()).find((o) => o.payeeName === "Hausverwaltung")!;
        fc.on("deleteStandingOrder", () => ({ status: 409, json: { error: "order_changed", message: "Der Auftrag wurde inzwischen bei der Bank geändert oder gelöscht. Bitte die Aufträge neu abrufen. Es wurde nichts gesendet." } }));
        const del = await api<T>("POST", `/api/orders/standing/${rent.id}/delete`, { requestId: randomUUID() });
        const failed = await waitFor(del.body.id, (x) => x.status === "failed");
        expect(failed.bankMessage).toContain("Es wurde nichts gesendet");
        await until(async () => calls("standingOrders").length, (n) => n >= 2, "fetch after order_changed");
    });

    it("does not fetch the orders on its own when the bank wants an approval for that", async () => {
        const giro = await setUpAccess();
        fc.on("accounts", () => ({ status: "done", data: { accounts: [{ ...GIRO, capabilities: { ...caps, scheduledTransfersTan: true } }] }, state: "S1" }));
        // Takes over the new capabilities
        await api("POST", "/api/sync", { accountId: giro });
        await until(async () => calls("accounts").length, (n) => n >= 2, "accounts");
        await new Promise((r) => setTimeout(r, 50));
        const before = calls("scheduledTransfers").length;
        fc.on("createScheduledTransfer", () => ({ status: "done", data: { bankMessage: "Auftrag zur Ausführung vorgemerkt.", reference: null, bankOrderId: "TU-9", vop: NONE }, state: "S9" }));
        const { body } = await api<T>("POST", "/api/transfers", { requestId: randomUUID(), accountId: giro, ...payment, execution: { kind: "date", date: "2026-11-27" } });
        await waitFor(body.id, (x) => x.status === "executed");
        await new Promise((r) => setTimeout(r, 50));
        expect(calls("scheduledTransfers")).toHaveLength(before);
    });
});
