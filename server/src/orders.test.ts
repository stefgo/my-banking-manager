import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { startFakeConnector, type FakeConnector } from "./testing/fakeConnector.js";

let t: TestApp;
let fc: FakeConnector;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];

const caps = { balance: true, transactions: true, cardTransactions: false, transfer: true, instantTransfer: false, standingOrders: true, scheduledTransfers: true, standingOrdersTan: false, scheduledTransfersTan: false };
const acc = (iban: string, kind: string, name: string, capabilities: object = caps) => ({ accountNumber: iban.slice(-7), subAccount: "", iban, bic: null, externalId: iban, name, owner: "Anna", currency: "EUR", kind, capabilities });
const GIRO = acc("DE02700543060001234567", "giro", "Girokonto");
const SAVINGS = acc("DE02700543060009876543", "savings", "Tagesgeld", { ...caps, standingOrders: false, scheduledTransfers: false });

const order = (over: Record<string, unknown>) => ({ bankOrderId: null, payeeName: "", payeeIban: "DE89370400440532013000", payeeBic: null, amount: 1000, currency: "EUR", remittance: "", endToEndId: null, canChange: null, canDelete: null, ...over });
const RENT = order({ bankOrderId: "DA-1", payeeName: "Hausverwaltung", amount: 85000, remittance: "Miete", canChange: true, canDelete: true, firstDate: "2024-01-01", unit: "month", every: 1, executionDay: 1, lastDate: null });
const SAVE = order({ bankOrderId: "DA-2", payeeName: "Anna", payeeIban: SAVINGS.iban, amount: 20000, remittance: "Sparen", firstDate: "2025-01-31", unit: "month", every: 1, executionDay: 99, lastDate: null });
const BILL = order({ bankOrderId: "TU-1", payeeName: "Handwerker", amount: 43120, remittance: "Rechnung 4711", canChange: false, executionDate: "2026-12-05" });

let accountsAtBank = [GIRO, SAVINGS];
let standing: unknown[] = [];
let scheduled: unknown[] = [];

beforeEach(async () => {
    // Only the clock is faked: "today" is Tuesday, 17 November 2026
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 17, 12));
    fc = await startFakeConnector();
    t = await createTestApp({ connectors: { fints: { socket: fc.socket } }, bankPollMs: 20 });
    ({ api } = await setUpSignedIn(t));
    accountsAtBank = [GIRO, SAVINGS];
    standing = [RENT, SAVE];
    scheduled = [BILL];
    fc.on("checkBank", () => ({ bankName: "Sparkasse", bpdVersion: 1, pinTan: true, jobs: [] }));
    fc.on("tanMethods", () => ({ status: "done", data: { methods: [{ id: "923", name: "pushTAN", decoupled: true, needsMedium: false }] }, state: "S0" }));
    fc.on("accounts", () => ({ status: "done", data: { accounts: accountsAtBank }, state: "S1" }));
    fc.on("balances", (b: { accounts: { iban: string }[] }) => ({
        status: "done",
        data: { balances: b.accounts.map((a) => ({ externalId: a.iban, booked: a.iban === GIRO.iban ? 200000 : 50000, currency: "EUR", date: "2026-11-17", pending: null, available: null, creditLine: null })) },
        state: "S2",
    }));
    fc.on("transactions", () => ({ status: "done", data: { transactions: [] }, state: "S3" }));
    fc.on("standingOrders", () => ({ status: "done", data: { orders: standing }, state: "S4" }));
    fc.on("scheduledTransfers", () => ({ status: "done", data: { orders: scheduled }, state: "S5" }));
});

afterEach(async () => {
    await t.close();
    await fc.close();
    vi.useRealTimers();
});

async function setUpAccess(): Promise<{ giro: number; savings: number }> {
    const { body: conn } = await api<{ id: number }>("POST", "/api/bank-connections", { blz: "70054306", fintsUrl: "https://bank.example.invalid/fints" });
    await api("PUT", `/api/bank-connections/${conn.id}/login`, { loginName: "anna1234567", pin: "1234", savePin: true });
    await api("PUT", `/api/bank-connections/${conn.id}/login/tan-method`, { tanMethod: "923" });
    await api("POST", `/api/bank-connections/${conn.id}/login/accounts`);
    const { body } = await api<{ created: number[] }>("POST", `/api/bank-connections/${conn.id}/accounts`, { accounts: [GIRO, SAVINGS].map((a) => ({ externalId: a.externalId })) });
    const [giro, savings] = body.created as [number, number];
    return { giro, savings };
}

type Run = { id: string; status: string; error: string | null; message: string | null; ordersOnly: boolean; ordersMessage: string | null; challenge: { decoupled: boolean } | null };
type OrderRow = { id: number; kind: string; accountId: number; payeeName: string; amount: number; nextDate: string | null; payeeAccountId: number | null };
type Orders = { orders: OrderRow[]; accounts: { accountId: number; needsApproval: boolean; fetchedAt: string | null }[] };

async function waitFor(pred: (runs: Run[]) => boolean): Promise<Run[]> {
    for (let i = 0; i < 200; i++) {
        const { body } = await api<Run[]>("GET", "/api/sync");
        if (pred(body)) return body;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout waiting for sync");
}

async function sync(path = "/api/sync", body: object = {}): Promise<Run> {
    const before = (await api<Run[]>("GET", "/api/sync")).body.filter((r) => r.status === "done" || r.status === "error").length;
    expect((await api("POST", path, body)).status).toBe(200);
    const runs = await waitFor((r) => r.filter((x) => x.status === "done" || x.status === "error").length === before + 1);
    return runs.at(-1)!;
}

describe("orders", () => {
    it("come with a fetch and replace what was there", async () => {
        const ids = await setUpAccess();
        expect((await api<Orders>("GET", "/api/orders")).body).toEqual({ orders: [], accounts: [{ accountId: ids.giro, standingOrders: true, scheduledTransfers: true, needsApproval: false, fetchedAt: null }] });

        expect(await sync()).toMatchObject({ status: "done", ordersOnly: false, ordersMessage: null });
        // Only the account that offers orders is asked
        expect(fc.received.filter((r) => r.route === "standingOrders").map((r) => r.body.account.iban)).toEqual([GIRO.iban]);
        const first = (await api<Orders>("GET", "/api/orders")).body;
        expect(first.orders).toEqual([
            // 30 November 2026 is a Monday: the end of the month
            expect.objectContaining({ kind: "standing", accountId: ids.giro, payeeName: "Anna", amount: 20000, nextDate: "2026-11-30", payeeAccountId: ids.savings, unit: "month", every: 1, executionDay: 99, canChange: null }),
            expect.objectContaining({ kind: "standing", payeeName: "Hausverwaltung", amount: 85000, nextDate: "2026-12-01", payeeAccountId: null, canChange: true, canDelete: true, remittance: "Miete" }),
            // 5 December 2026 is a Saturday
            expect.objectContaining({ kind: "scheduled", payeeName: "Handwerker", executionDate: "2026-12-05", nextDate: "2026-12-07", canChange: false }),
        ]);
        expect(first.accounts[0]!.fetchedAt).not.toBeNull();

        // The bank changed one order, dropped one and has a new one
        standing = [{ ...RENT, amount: 87000 }, order({ bankOrderId: "DA-3", payeeName: "Verein", firstDate: "2026-11-06", unit: "week", every: 2, executionDay: 5, lastDate: null })];
        scheduled = [];
        await sync("/api/sync", { accountId: ids.giro });
        const second = (await api<Orders>("GET", "/api/orders", undefined)).body;
        expect(second.orders.map((o) => [o.payeeName, o.amount, o.nextDate])).toEqual([["Verein", 1000, "2026-11-20"], ["Hausverwaltung", 87000, "2026-12-01"]]);
        // An order the bank still reports keeps its id
        const rentId = (list: Orders) => list.orders.find((o) => o.payeeName === "Hausverwaltung")!.id;
        expect(rentId(second)).toBe(rentId(first));

        // Scope: the savings account has no orders of its own
        expect((await api<Orders>("GET", `/api/orders?scope=account:${ids.savings}`)).body).toEqual({ orders: [], accounts: [] });
    });

    it("keeps the orders and the run when only the orders fail", async () => {
        const ids = await setUpAccess();
        await sync();
        const before = (await api<Orders>("GET", "/api/orders")).body;
        fc.on("standingOrders", () => ({ status: 502, json: { error: "bank_error", message: "Die Bank hat den Auftrag abgelehnt." } }));
        const run = await sync();
        expect(run).toMatchObject({ status: "done", error: null });
        expect(run.ordersMessage).toContain("Die Bank hat den Auftrag abgelehnt.");
        expect((await api<Orders>("GET", "/api/orders")).body).toEqual(before);

        // A run for the orders alone fails
        const only = await sync("/api/orders/fetch", { accountId: ids.giro });
        expect(only).toMatchObject({ status: "error", ordersOnly: true, error: "bank_error" });
    });

    it("leaves orders that need an approval to a run for the orders alone", async () => {
        accountsAtBank = [{ ...GIRO, capabilities: { ...caps, standingOrdersTan: true, scheduledTransfersTan: true } }, SAVINGS];
        const ids = await setUpAccess();
        await sync();
        expect(fc.received.some((r) => r.route === "standingOrders" || r.route === "scheduledTransfers")).toBe(false);
        expect((await api<Orders>("GET", "/api/orders")).body).toEqual({ orders: [], accounts: [{ accountId: ids.giro, standingOrders: true, scheduledTransfers: true, needsApproval: true, fetchedAt: null }] });
        const lastSync = () => (t.vault.database.prepare("SELECT last_sync_at FROM bank_logins").get() as { last_sync_at: string }).last_sync_at;
        const fetchedAt = lastSync();

        // The bank asks for an approval in the app
        let asked = 0;
        fc.on("standingOrders", () => (asked++ === 0 ? { status: "approval", operationId: "11111111-1111-4111-8111-111111111111", challenge: { decoupled: true, text: "In der App freigeben.", medium: "", validUntil: "", methodName: "pushTAN" } } : null));
        fc.on("operation", () => ({ status: "done", data: { orders: standing }, state: "S6" }));
        const calls = fc.received.length;
        vi.setSystemTime(new Date(2026, 10, 17, 12, 1));
        const run = await sync("/api/orders/fetch", {});
        expect(run).toMatchObject({ status: "done", ordersOnly: true });
        const routes = fc.received.slice(calls).map((r) => r.route);
        expect(routes).toContain("operation");
        expect(routes).not.toContain("transactions");
        expect(routes).not.toContain("balances");
        expect((await api<Orders>("GET", "/api/orders")).body.orders).toHaveLength(3);
        expect(lastSync()).toBe(fetchedAt);
        expect((t.vault.database.prepare("SELECT details FROM activity_log ORDER BY id DESC LIMIT 1").get() as { details: string }).details).toBe("Aufträge abgerufen");
    });

    it("lists the coming runs and forecasts the balance", async () => {
        const ids = await setUpAccess();
        await sync();
        const upcoming = (await api<{ items: { date: string; payeeName: string; amount: number; kind: string; payeeAccountId: number | null }[] }>("GET", "/api/orders/upcoming?days=50")).body.items;
        expect(upcoming.map((i) => [i.date, i.payeeName, i.amount])).toEqual([
            ["2026-11-30", "Anna", 20000],
            ["2026-12-01", "Hausverwaltung", 85000],
            ["2026-12-07", "Handwerker", 43120],
            ["2026-12-31", "Anna", 20000],
            ["2027-01-04", "Hausverwaltung", 85000],
        ]);
        expect(upcoming[0]).toMatchObject({ kind: "standing", payeeAccountId: ids.savings });
        expect((await api<{ items: unknown[] }>("GET", "/api/orders/upcoming?days=50&count=2")).body.items).toHaveLength(2);

        type Series = { points: { date: string; balance: number }[]; forecast: { date: string; balance: number }[] };
        const at = (s: Series, date: string) => s.forecast.find((p) => p.date === date)?.balance;
        // All accounts: the transfer to the own savings account changes nothing
        const all = (await api<Series>("GET", "/api/stats/series?days=30&forecastDays=30")).body;
        expect(all.points.at(-1)).toEqual({ date: "2026-11-17", balance: 250000 });
        expect(all.forecast[0]!.date).toBe("2026-11-18");
        expect(all.forecast).toHaveLength(30);
        expect([at(all, "2026-11-30"), at(all, "2026-12-01"), at(all, "2026-12-07"), at(all, "2026-12-17")]).toEqual([250000, 165000, 121880, 121880]);
        // The paying account alone loses the transfer, the savings account gains it
        const giro = (await api<Series>("GET", `/api/stats/series?scope=account:${ids.giro}&days=30&forecastDays=30`)).body;
        expect([at(giro, "2026-11-29"), at(giro, "2026-11-30"), at(giro, "2026-12-07")]).toEqual([200000, 180000, 51880]);
        const savings = (await api<Series>("GET", `/api/stats/series?scope=account:${ids.savings}&days=30&forecastDays=30`)).body;
        expect([at(savings, "2026-11-29"), at(savings, "2026-11-30")]).toEqual([50000, 70000]);

        // No forecast unless asked for, or when the series does not end today
        expect((await api<Series>("GET", "/api/stats/series?days=30")).body.forecast).toEqual([]);
        expect((await api<Series>("GET", "/api/stats/series?from=2026-10-01&to=2026-11-01&forecastDays=30")).body.forecast).toEqual([]);
    });

    it("drops the orders of an account that leaves its bank access", async () => {
        const ids = await setUpAccess();
        await sync();
        expect((await api("POST", `/api/accounts/${ids.giro}/detach`, { mode: "keep" })).status).toBe(200);
        expect((await api<Orders>("GET", "/api/orders")).body).toEqual({ orders: [], accounts: [] });
        expect(t.vault.database.prepare("SELECT orders_fetched_at AS f FROM accounts WHERE id = ?").get(ids.giro)).toEqual({ f: null });
    });
});
