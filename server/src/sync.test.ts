import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmCode, createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { startFakeConnector, type FakeConnector } from "./testing/fakeConnector.js";

let t: TestApp;
let fc: FakeConnector;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];
let secret: string;

const caps = { balance: true, transactions: true, cardTransactions: false, transfer: true, instantTransfer: false, standingOrders: false, scheduledTransfers: false };
const acc = (externalId: string, kind: string, name: string, iban: string | null) => ({ accountNumber: kind === "credit_card" ? externalId : externalId.slice(-7), subAccount: "", iban, bic: null, externalId, name, owner: "Anna", currency: "EUR", kind, capabilities: kind === "credit_card" ? { ...caps, transactions: false, cardTransactions: true } : caps });
const GIRO = acc("DE02700543060001234567", "giro", "Girokonto", "DE02700543060001234567");
const SAVINGS = acc("DE02700543060009876543", "savings", "Tagesgeld", "DE02700543060009876543");
const CARD = acc("4111000000001234", "credit_card", "Visa", null);
const NEW = acc("DE02700543060005555555", "giro", "Zweitkonto", "DE02700543060005555555");
const challenge = (decoupled: boolean) => ({ decoupled, text: decoupled ? "In der App freigeben." : "TAN eingeben.", medium: "", validUntil: "", methodName: "pushTAN" });

const tx = (over: Record<string, unknown>) => ({
    bookingDate: "2026-11-10", valueDate: "2026-11-10", amount: -1000, currency: "EUR", status: "booked", counterpartyName: "", counterpartyIban: null, counterpartyBic: null,
    remittance: "", endToEndId: null, mandateId: null, creditorId: null, bookingText: "", bankReference: null, ...over,
});

let accountsAtBank = [GIRO, SAVINGS, CARD, NEW];
let giroTxs: unknown[] = [];

beforeEach(async () => {
    fc = await startFakeConnector();
    t = await createTestApp({ connectors: { fints: { socket: fc.socket } }, bankPollMs: 20 });
    ({ api, secret } = await setUpSignedIn(t));
    accountsAtBank = [GIRO, SAVINGS, CARD, NEW];
    giroTxs = [
        tx({ amount: 250000, counterpartyName: "Muster GmbH", remittance: "Gehalt" }),
        tx({ amount: -8900, counterpartyName: "Stadtwerke", remittance: "Abschlag", bookingDate: "2026-11-11" }),
        tx({ amount: -50000, counterpartyName: "Anna", counterpartyIban: SAVINGS.iban, remittance: "Sparen", bookingDate: "2026-11-12" }),
        tx({ amount: -990, counterpartyName: "Kiosk", status: "pending", bookingDate: "2026-11-15", valueDate: null }),
    ];
    fc.on("checkBank", () => ({ bankName: "Sparkasse", bpdVersion: 1, pinTan: true, jobs: [] }));
    fc.on("tanMethods", () => ({ status: "done", data: { methods: [{ id: "923", name: "pushTAN", decoupled: true, needsMedium: false }] }, state: "S0" }));
    fc.on("accounts", () => ({ status: "done", data: { accounts: accountsAtBank }, state: "S1" }));
    fc.on("balances", (b: { accounts: { iban: string }[] }) => ({
        status: "done",
        data: { balances: b.accounts.map((a) => ({ externalId: a.iban, booked: a.iban === GIRO.iban ? 191100 : 50000, currency: "EUR", date: "2026-11-15", pending: null, available: null, creditLine: null })) },
        state: "S2",
    }));
    fc.on("transactions", (b: { account: { iban: string } }) => ({
        status: "done",
        data: { transactions: b.account.iban === GIRO.iban ? giroTxs : [tx({ amount: 50000, counterpartyName: "Anna", counterpartyIban: GIRO.iban, remittance: "Sparen", bookingDate: "2026-11-12" })] },
        state: "S3",
    }));
    fc.on("cardTransactions", () => ({ status: "done", data: { transactions: [tx({ amount: -4500, counterpartyName: "Buchhandlung" })], balance: { externalId: CARD.externalId, booked: -4500, currency: "EUR", date: "2026-11-15", pending: null, available: null, creditLine: null } }, state: "S4" }));
});

afterEach(async () => {
    await t.close();
    await fc.close();
});

async function setUpAccess(savePin = true): Promise<{ id: number; ids: Record<string, number> }> {
    const { body: conn } = await api<{ id: number }>("POST", "/api/bank-connections", { blz: "70054306", fintsUrl: "https://bank.example.invalid/fints" });
    await api("PUT", `/api/bank-connections/${conn.id}/login`, { loginName: "anna1234567", pin: "1234", savePin });
    await api("PUT", `/api/bank-connections/${conn.id}/login/tan-method`, { tanMethod: "923" });
    await api("POST", `/api/bank-connections/${conn.id}/login/accounts`, savePin ? undefined : { pin: "1234" });
    const { body } = await api<{ created: number[] }>("POST", `/api/bank-connections/${conn.id}/accounts`, { accounts: [GIRO, SAVINGS, CARD].map((a) => ({ externalId: a.externalId })) });
    const [giro, savings, card] = body.created as [number, number, number];
    return { id: conn.id, ids: { giro, savings, card } };
}

type Run = { id: string; status: string; error: string | null; newTransactions: number; newAccounts: string[]; missingAccounts: number[]; challenge: { decoupled: boolean } | null };

async function waitFor(pred: (runs: Run[]) => boolean): Promise<Run[]> {
    for (let i = 0; i < 200; i++) {
        const { body } = await api<Run[]>("GET", "/api/sync");
        if (pred(body)) return body;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout waiting for sync");
}

const txsOf = (accountId: number) =>
    t.vault.database
        .prepare("SELECT t.amount, t.status, t.counterparty_name AS name, c.name AS category FROM transactions t LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id LEFT JOIN categories c ON c.id = tc.category_id WHERE t.account_id = ? ORDER BY t.booking_date, t.id")
        .all(accountId) as { amount: number; status: string; name: string; category: string | null }[];

describe("taking over accounts", () => {
    it("keeps the card number of a credit card", async () => {
        const { ids } = await setUpAccess();
        const { body } = await api<{ id: number; iban: string | null; cardNumber: string | null }[]>("GET", "/api/accounts");
        expect(body.find((a) => a.id === ids.card)).toMatchObject({ iban: null, cardNumber: "4111000000001234" });
        expect(body.find((a) => a.id === ids.giro)).toMatchObject({ cardNumber: null });
    });
});

describe("fetching", () => {
    it("fetches balances and bookings, applies rules and finds transfers", async () => {
        const { ids } = await setUpAccess();
        const db = t.vault.database;
        const energy = (await api<{ id: number }>("POST", "/api/categories", { name: "Energie", parentId: null, icon: "zap", color: "amber" })).body.id;
        await api("POST", "/api/rules", { query: "Stadtwerke", categoryId: energy });
        const transfer = (await api<{ id: number }>("POST", "/api/categories", { name: "Umbuchung", parentId: null, icon: "repeat", color: "neutral" })).body.id;
        db.prepare("UPDATE categories SET counter_default = 1 WHERE id = ?").run(transfer);

        const started = await api<Run[]>("POST", "/api/sync", {});
        expect(started.status).toBe(200);
        expect(started.body).toHaveLength(1);
        const [run] = await waitFor((r) => r[0]?.status === "done");
        expect(run).toMatchObject({ newTransactions: 5, newAccounts: ["Zweitkonto"], missingAccounts: [], error: null });

        expect(txsOf(ids.giro!)).toEqual([
            { amount: 250000, status: "booked", name: "Muster GmbH", category: null },
            { amount: -8900, status: "booked", name: "Stadtwerke", category: "Energie" },
            { amount: -50000, status: "booked", name: "Anna", category: "Umbuchung" },
            { amount: -990, status: "pending", name: "Kiosk", category: null },
        ]);
        expect(txsOf(ids.savings!)[0]).toMatchObject({ amount: 50000, category: "Umbuchung" });
        expect(txsOf(ids.card!)).toEqual([{ amount: -4500, status: "booked", name: "Buchhandlung", category: null }]);

        const accounts = (await api<{ id: number; balance: number; pendingSum: number }[]>("GET", "/api/accounts")).body;
        // Booked balance of the bank plus the pending booking
        expect(accounts.find((a) => a.id === ids.giro)).toMatchObject({ balance: 191100 - 990, pendingSum: -990 });
        expect(accounts.find((a) => a.id === ids.card)).toMatchObject({ balance: -4500 });
        const login = db.prepare("SELECT status, last_sync_at FROM bank_logins").get() as { status: string; last_sync_at: string | null };
        expect(login.status).toBe("ready");
        expect(login.last_sync_at).not.toBeNull();
        expect(db.prepare("SELECT result, new_transactions FROM sync_runs").get()).toEqual({ result: "ok", new_transactions: 5 });
    });

    it("keeps bookings once, replaces pending ones and carries their category over", async () => {
        const { ids } = await setUpAccess();
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r[0]?.status === "done");
        const food = (await api<{ id: number }>("POST", "/api/categories", { name: "Snacks", parentId: null, icon: "coffee", color: "orange" })).body.id;
        const pendingId = (t.vault.database.prepare("SELECT id FROM transactions WHERE status = 'pending'").get() as { id: number }).id;
        await api("PUT", "/api/transactions/category", { ids: [pendingId], categoryId: food });

        // The pending booking is booked now, a day later
        giroTxs = [...giroTxs.slice(0, 3), tx({ amount: -990, counterpartyName: "Kiosk", bookingDate: "2026-11-16" })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        const runs = await waitFor((r) => r.filter((x) => x.status === "done").length === 2);
        expect(runs.map((r) => r.newTransactions).sort()).toEqual([1, 3]);
        const giro = txsOf(ids.giro!);
        expect(giro).toHaveLength(4);
        expect(giro.at(-1)).toEqual({ amount: -990, status: "booked", name: "Kiosk", category: "Snacks" });
        // The id of the replaced pending booking is not handed out again: a client holding it
        // would otherwise meet another booking under it
        const booked = t.vault.database.prepare("SELECT id FROM transactions WHERE account_id = ? AND counterparty_name = 'Kiosk'").get(ids.giro) as { id: number };
        expect(booked.id).toBeGreaterThan(pendingId);
    });

    it("marks fetched bookings as new for every user; a booked one stays read where its pending one was read", async () => {
        const ben = (await api<{ id: number }>("POST", "/api/users", { name: "Ben", password: "noch-ein-passwort", code: confirmCode(t, secret) })).body.id;
        const { ids } = await setUpAccess();
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r[0]?.status === "done");
        const db = t.vault.database;
        const unreadOf = (user: number) =>
            (db.prepare("SELECT t.counterparty_name AS name, t.status FROM transaction_unread u JOIN transactions t ON t.id = u.transaction_id WHERE u.user_id = ? ORDER BY t.id").all(user) as { name: string; status: string }[]).map((r) => `${r.name}:${r.status}`);
        expect(unreadOf(ben)).toEqual(["Muster GmbH:booked", "Stadtwerke:booked", "Anna:booked", "Kiosk:pending"]);
        expect((await api<{ total: number }>("GET", "/api/transactions/unread")).body.total).toBe(4);

        // Anna reads the pending booking; at the next fetch it is booked
        const pendingId = (db.prepare("SELECT id FROM transactions WHERE status = 'pending'").get() as { id: number }).id;
        await api("POST", "/api/transactions/read", { ids: [pendingId] });
        giroTxs = [...giroTxs.slice(0, 3), tx({ amount: -990, counterpartyName: "Kiosk", bookingDate: "2026-11-16" }), tx({ amount: -300, counterpartyName: "Bäcker", bookingDate: "2026-11-16" })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r.filter((x) => x.status === "done").length === 2);
        const anna = (await api<{ id: number }>("GET", "/api/auth/me")).body.id;
        expect(unreadOf(anna)).toEqual(["Muster GmbH:booked", "Stadtwerke:booked", "Anna:booked", "Bäcker:booked"]);
        expect(unreadOf(ben)).toEqual(["Muster GmbH:booked", "Stadtwerke:booked", "Anna:booked", "Kiosk:booked", "Bäcker:booked"]);
    });

    it("stops reporting accounts as new once they are ignored or detached", async () => {
        const { id, ids } = await setUpAccess();
        await api("POST", "/api/sync", {});
        expect((await waitFor((r) => r[0]?.status === "done"))[0]?.newAccounts).toEqual(["Zweitkonto"]);

        // Left out when offered again, and the savings account detached but kept
        await api("POST", `/api/bank-connections/${id}/login/accounts`);
        expect((await api("POST", `/api/bank-connections/${id}/accounts`, { accounts: [], ignore: [NEW.externalId] })).status).toBe(200);
        expect((await api("POST", `/api/accounts/${ids.savings}/detach`, { mode: "keep" })).status).toBe(200);
        const savings = (await api<{ id: number; kind: string; balance: number }[]>("GET", "/api/accounts")).body.find((a) => a.id === ids.savings);
        // The last bank balance stays
        expect(savings).toMatchObject({ kind: "offline", balance: 50000 });

        fc.received.length = 0;
        const [second] = (await api<Run[]>("POST", "/api/sync", {})).body;
        const run = (await waitFor((r) => r.some((x) => x.id === second?.id && x.status === "done"))).find((x) => x.id === second?.id);
        expect(run).toMatchObject({ newAccounts: [], missingAccounts: [] });
        expect(fc.received.filter((r) => r.route === "transactions").map((r) => r.body.account.iban)).toEqual([GIRO.iban]);
    });

    it("reports accounts the bank no longer lists", async () => {
        const { ids } = await setUpAccess();
        accountsAtBank = [GIRO, CARD];
        await api("POST", "/api/sync", {});
        const [run] = await waitFor((r) => r[0]?.status === "done");
        expect(run?.missingAccounts).toEqual([ids.savings]);
        expect(fc.received.filter((r) => r.route === "transactions").map((r) => r.body.account.iban)).toEqual([GIRO.iban]);
    });

    it("waits for a decoupled approval and for a TAN", async () => {
        const { ids } = await setUpAccess();
        const op = "22222222-2222-4222-8222-222222222222";
        let polls = 0;
        fc.on("transactions", () => ({ status: "approval", operationId: op, challenge: challenge(true) }));
        fc.on("operation", () => (++polls < 3 ? { status: "approval", operationId: op, challenge: challenge(true) } : { status: "done", data: { transactions: giroTxs }, state: "S5" }));
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r[0]?.status === "approval" && r[0].challenge?.decoupled === true);
        expect(t.ctx.sync.active()).toBe(true);
        await waitFor((r) => r[0]?.status === "done");
        expect(polls).toBe(3);
        expect(t.ctx.sync.active()).toBe(false);

        const tanOp = "33333333-3333-4333-8333-333333333333";
        fc.on("transactions", () => ({ status: "approval", operationId: tanOp, challenge: challenge(false) }));
        fc.on("operationTan", (b: { tan: string }, id) => (b.tan === "123456" && id === tanOp ? { status: "done", data: { transactions: [] }, state: "S6" } : { status: 422, json: { error: "bank_error", message: "TAN falsch" } }));
        await api("POST", "/api/sync", { accountId: ids.giro });
        const [waiting] = await waitFor((r) => r.some((x) => x.status === "approval" && x.challenge?.decoupled === false)).then((r) => r.filter((x) => x.status === "approval"));
        const after = await api<Run>("POST", `/api/sync/${waiting!.id}/tan`, { tan: "123456" });
        expect(after.status).toBe(200);
        await waitFor((r) => r.filter((x) => x.status === "done").length === 2);
    });

    it("fetches the bank accounts of an account group with its subgroups", async () => {
        const { ids } = await setUpAccess();
        const group = (await api<{ id: number }>("POST", "/api/account-groups", { name: "Sparen" })).body.id;
        const sub = (await api<{ id: number }>("POST", "/api/account-groups", { name: "Karten", parentId: group })).body.id;
        const empty = (await api<{ id: number }>("POST", "/api/account-groups", { name: "Bar" })).body.id;
        await api("POST", "/api/accounts", { name: "Bargeld", icon: "banknote", color: "green", groupId: empty, openingBalance: 0 });
        const move = t.vault.database.prepare("UPDATE accounts SET group_id = ? WHERE id = ?");
        move.run(group, ids.savings);
        move.run(sub, ids.card);

        const started = await api<(Run & { accountIds: number[] })[]>("POST", "/api/sync", { groupId: group });
        expect(started.body.map((r) => r.accountIds)).toEqual([[ids.savings, ids.card].sort((a, b) => a! - b!)]);
        await waitFor((r) => r[0]?.status === "done");
        expect(txsOf(ids.giro!)).toEqual([]);
        expect(txsOf(ids.savings!)).toHaveLength(1);

        // Only offline accounts: nothing to fetch; an unknown group is refused
        expect((await api<Run[]>("POST", "/api/sync", { groupId: empty })).body).toEqual([]);
        expect((await api("POST", "/api/sync", { groupId: 9999 })).status).toBe(404);
    });

    it("needs the PIN of a login that does not store it, and refuses accounts without own login", async () => {
        const { id, ids } = await setUpAccess(false);
        await api("POST", "/api/sync", { accountId: ids.giro });
        const [failed] = await waitFor((r) => r[0]?.status === "error");
        expect(failed?.error).toBe("pin_required");
        await api("POST", "/api/sync", { accountId: ids.giro, pins: { [String(id)]: "1234" } });
        await waitFor((r) => r.some((x) => x.status === "done"));
        expect(fc.received.filter((r) => r.route === "transactions").at(-1)?.body.login.pin).toBe("1234");

        const offline = (await api<{ id: number }>("POST", "/api/accounts", { name: "Bargeld", icon: "banknote", color: "green", groupId: null, openingBalance: 0 })).body.id;
        expect((await api<{ error: string }>("POST", "/api/sync", { accountId: offline })).body.error).toBe("not_bank_account");
        t.vault.database.prepare("DELETE FROM bank_logins").run();
        expect((await api<{ error: string; message: string }>("POST", "/api/sync", { accountId: ids.giro })).body).toMatchObject({ error: "no_own_login", message: "Keine eigene Anmeldung bei Sparkasse Bad Tölz-Wolfratshausen." });
    });
});
