import { ConnectorTransaction } from "@mbm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmCode, createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { startFakeConnector, type FakeConnector } from "./testing/fakeConnector.js";
import { applyFetch } from "./services/fetchimport.js";

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
    remittance: "", endToEndId: null, mandateId: null, creditorId: null, bookingText: "", bankReference: null, isReturn: false, returnReason: "", ...over,
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

describe("CSV import into a bank account", () => {
    const HEAD = "Buchungstag;Betrag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Kategorie;Status";
    const OLD = [HEAD, "01.10.2026;-50,00;Hausverwaltung;Miete;;", "02.10.2026;10,00;Erstattung;Rückzahlung;;"].join("\n");
    const bank = (booked: number) => ({ externalId: GIRO.externalId!, booked, currency: "EUR", date: "2026-11-20", pending: null, available: null, creditLine: null });
    const fetched = (txs: unknown[], booked: number | null) => applyFetch(t.vault.database, accountId, ConnectorTransaction.array().parse(txs), booked === null ? null : bank(booked), null);
    const account = async () => (await api<{ id: number; balance: number; transactionCount: number }[]>("GET", "/api/accounts")).body.find((a) => a.id === accountId)!;
    const importCsv = async (content: string) => (await api<{ importId: number; imported: number; invalid: number }>("POST", `/api/accounts/${accountId}/import`, { fileName: "alt.csv", content })).body;
    const rowsOf = (amount: number) => t.vault.database.prepare("SELECT id, source, import_id FROM transactions WHERE account_id = ? AND amount = ?").all(accountId, amount) as { id: number; source: string; import_id: number | null }[];
    const salary = tx({ amount: 20000, counterpartyName: "Muster GmbH", remittance: "Gehalt", ultimateParty: "" });
    const shop = tx({ bookingDate: "2026-11-12", valueDate: "2026-11-12", amount: -700, counterpartyName: "Laden", remittance: "Einkauf von der Bank", ultimateParty: "", endToEndId: "E2E-1" });
    let accountId: number;

    beforeEach(async () => {
        accountId = (await setUpAccess()).ids.giro!;
        fetched([salary], 100000);
    });

    it("keeps today's balance and shows the history right away", async () => {
        await importCsv(OLD);
        expect(await account()).toMatchObject({ balance: 100000, transactionCount: 3 });
        const series = (await api<{ points: { date: string; balance: number }[] }>("GET", `/api/stats/series?scope=account:${accountId}&from=2026-09-30&to=2026-10-05`)).body.points;
        expect(series.find((p) => p.date === "2026-09-30")?.balance).toBe(84000);
        expect(series.find((p) => p.date === "2026-10-05")?.balance).toBe(80000);
        fetched([salary], 100000);
        expect(await account()).toMatchObject({ balance: 100000, transactionCount: 3 });
    });

    it("keeps today's balance when an import is undone", async () => {
        const { importId } = await importCsv(OLD);
        await api("DELETE", `/api/imports/${importId}`);
        expect(await account()).toMatchObject({ balance: 100000, transactionCount: 1 });
    });

    it("counts what a fetch without a balance brought in", async () => {
        fetched([salary, shop], null);
        expect((await account()).balance).toBe(99300);
        await importCsv(OLD);
        expect((await account()).balance).toBe(99300);
    });

    it("takes over an imported booking when the bank delivers it", async () => {
        const food = (await api<{ id: number }>("POST", "/api/categories", { name: "Einkauf", parentId: null, icon: "coffee", color: "orange" })).body.id;
        const { importId } = await importCsv([HEAD, "12.11.2026;-7,00;LADEN;Einkauf;Einkauf;"].join("\n"));
        const [before] = rowsOf(-700);
        const result = fetched([salary, shop], 99300);
        expect(result.newTransactions).toBe(0);
        expect(rowsOf(-700)).toEqual([{ id: before!.id, source: "bank", import_id: null }]);
        const stored = t.vault.database.prepare("SELECT t.remittance, t.end_to_end_id AS e2e, tc.category_id AS category FROM transactions t JOIN transaction_categories tc ON tc.transaction_id = t.id WHERE t.id = ?").get(before!.id);
        expect(stored).toEqual({ remittance: "Einkauf von der Bank", e2e: "E2E-1", category: food });
        expect((await account()).balance).toBe(99300);
        // The booking belongs to the bank now, so undoing the import leaves it
        await api("DELETE", `/api/imports/${importId}`);
        expect(rowsOf(-700)).toHaveLength(1);
        expect((await account()).balance).toBe(99300);
    });

    it("takes over an imported booking that names a batch by its first item", async () => {
        await importCsv([HEAD, "01.10.2026;-30,00;;Rechnung 1;;"].join("\n"));
        fetched([tx({ bookingDate: "2026-10-01", valueDate: "2026-10-01", amount: -3000, remittance: "Sammelbuchung mit 2 Posten", replaces: { counterpartyIban: null, remittance: "Rechnung 1", endToEndId: null } })], null);
        const rows = t.vault.database.prepare("SELECT remittance, source FROM transactions WHERE account_id = ? AND amount = -3000").all(accountId);
        expect(rows).toEqual([{ remittance: "Sammelbuchung mit 2 Posten", source: "bank" }]);
    });

    it("takes over one imported booking per booking of the bank", async () => {
        await importCsv([HEAD, "12.11.2026;-7,00;Laden;Einkauf;;"].join("\n"));
        fetched([salary, shop, { ...shop, endToEndId: "E2E-2" }], 98600);
        expect(rowsOf(-700).map((r) => r.source)).toEqual(["bank", "bank"]);
        expect((await account()).balance).toBe(98600);
    });

    it("leaves pending rows of a file to the bank", async () => {
        const csv = [HEAD, "15.11.2026;-9,90;Kiosk;Snack;;vorgemerkt"].join("\n");
        const preview = (await api<{ counts: { new: number; invalid: number }; rows: { error: string | null }[] }>("POST", `/api/accounts/${accountId}/import/preview`, { fileName: "v.csv", content: csv })).body;
        expect(preview.counts).toMatchObject({ new: 0, invalid: 1 });
        expect(preview.rows[0]?.error).toBe("Vorgemerkte Umsätze kommen bei Bankkonten vom Abruf.");
        expect(await importCsv(csv)).toMatchObject({ imported: 0, invalid: 1 });
        expect(await account()).toMatchObject({ balance: 100000, transactionCount: 1 });
    });

    it("does not let a pending row imported earlier move the balance", async () => {
        t.vault.database
            .prepare("INSERT INTO transactions (account_id, booking_date, amount, status, first_seen_at, source) VALUES (?, '2026-11-15', -990, 'pending', '2026-11-16T00:00:00.000Z', 'import')")
            .run(accountId);
        fetched([salary], 100000);
        expect((await account()).balance).toBe(100000);
    });

    it("adds an import to an account the bank gives no balance for", async () => {
        t.vault.database.prepare("DELETE FROM balances WHERE account_id = ?").run(accountId);
        const before = (await account()).balance;
        await importCsv(OLD);
        expect((await account()).balance).toBe(before - 4000);
    });

    it("still takes pending rows into an offline account and counts every booking", async () => {
        const cash = (await api<{ id: number }>("POST", "/api/accounts", { name: "Bargeld", icon: "banknote", color: "green", groupId: null, openingBalance: 10000 })).body.id;
        const csv = [HEAD, "01.10.2026;-50,00;Laden;Einkauf;;", "02.10.2026;-5,00;Kiosk;Snack;;vorgemerkt"].join("\n");
        const result = (await api<{ imported: number }>("POST", `/api/accounts/${cash}/import`, { fileName: "bar.csv", content: csv })).body;
        expect(result.imported).toBe(2);
        const accounts = (await api<{ id: number; balance: number }[]>("GET", "/api/accounts")).body;
        expect(accounts.find((a) => a.id === cash)?.balance).toBe(4500);
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

    it("adds an account number to a stored booking at the next fetch, without doubling it", async () => {
        const { ids } = await setUpAccess();
        giroTxs = [tx({ amount: -700, remittance: "Barzahlung" })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r[0]?.status === "done");
        giroTxs = [tx({ amount: -700, remittance: "Barzahlung", counterpartyAccount: "1234567", counterpartyBankCode: "12030000" })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r.filter((x) => x.status === "done").length === 2);
        expect(t.vault.database.prepare("SELECT counterparty_account AS a, counterparty_bank_code AS b FROM transactions WHERE account_id = ?").all(ids.giro)).toEqual([{ a: "1234567", b: "12030000" }]);
    });

    it("corrects a batch stored under its first item, once and with its category", async () => {
        const { ids } = await setUpAccess();
        const first = { counterpartyIban: "DE89370400440532013000", remittance: "Rechnung 1", endToEndId: "E-1" };
        giroTxs = [tx({ amount: -3000, counterpartyName: "Anna", mandateId: "M-1", ...first })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r[0]?.status === "done");
        const db = t.vault.database;
        const stored = (db.prepare("SELECT id FROM transactions WHERE account_id = ?").get(ids.giro) as { id: number }).id;
        const category = (await api<{ id: number }>("POST", "/api/categories", { name: "Rechnungen", parentId: null, icon: "tag", color: "blue" })).body.id;
        await api("PUT", "/api/transactions/category", { ids: [stored], categoryId: category });

        giroTxs = [tx({ amount: -3000, remittance: "Sammelbuchung mit 2 Posten", bookingText: "SAMMLER", replaces: first })];
        for (const runs of [2, 3]) {
            await api("POST", "/api/sync", { accountId: ids.giro });
            await waitFor((r) => r.filter((x) => x.status === "done").length === runs);
        }
        const rows = db
            .prepare("SELECT t.id, t.counterparty_name AS name, t.counterparty_iban AS iban, t.remittance, t.mandate_id AS mandate, tc.category_id AS category FROM transactions t LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id WHERE t.account_id = ?")
            .all(ids.giro);
        expect(rows).toEqual([{ id: stored, name: "", iban: null, remittance: "Sammelbuchung mit 2 Posten", mandate: "", category }]);
    });

    it("passes nothing from a pending booking without a name to an unrelated one", async () => {
        const { ids } = await setUpAccess();
        giroTxs = [tx({ amount: -500, status: "pending", remittance: "Automat Hauptstrasse", bookingDate: "2026-11-15", valueDate: null })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r[0]?.status === "done");
        const db = t.vault.database;
        const pendingId = (db.prepare("SELECT id FROM transactions WHERE status = 'pending'").get() as { id: number }).id;
        const category = (await api<{ id: number }>("POST", "/api/categories", { name: "Bargeld", parentId: null, icon: "tag", color: "green" })).body.id;
        await api("PUT", "/api/transactions/category", { ids: [pendingId], categoryId: category });

        giroTxs = [tx({ amount: -500, remittance: "Kontoentgelt", bookingDate: "2026-11-16" })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r.filter((x) => x.status === "done").length === 2);
        const categoryOf = (remittance: string) => (db.prepare("SELECT tc.category_id AS c FROM transactions t LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id WHERE t.account_id = ? AND t.remittance = ?").get(ids.giro, remittance) as { c: number | null }).c;
        expect(categoryOf("Kontoentgelt")).toBeNull();

        // The same payment, with more text once it is booked, does keep its category
        giroTxs = [tx({ amount: -500, status: "pending", remittance: "Automat Hauptstrasse", bookingDate: "2026-11-17", valueDate: null })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r.filter((x) => x.status === "done").length === 3);
        const next = (db.prepare("SELECT id FROM transactions WHERE status = 'pending'").get() as { id: number }).id;
        await api("PUT", "/api/transactions/category", { ids: [next], categoryId: category });
        giroTxs = [tx({ amount: -500, remittance: "Automat Hauptstrasse 12", bookingDate: "2026-11-18" })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r.filter((x) => x.status === "done").length === 4);
        expect(categoryOf("Automat Hauptstrasse 12")).toBe(category);
    });

    it("keeps the ultimate party and the booking text; gegenseite: finds either name, umsatzart: the booking text", async () => {
        const { ids } = await setUpAccess();
        const rule = (await api<{ id: number }>("POST", "/api/categories", { name: "Einkauf", parentId: null, icon: "shopping-cart", color: "blue" })).body.id;
        await api("POST", "/api/rules", { query: "gegenseite:shop", categoryId: rule });
        giroTxs = [...giroTxs, tx({ amount: -2500, counterpartyName: "Landesbank Muster", ultimateParty: "Shop Muster", bookingText: "KARTENZAHLUNG", remittance: "Debitk. 1", bookingDate: "2026-11-13" })];
        await api("POST", "/api/sync", { accountId: ids.giro });
        await waitFor((r) => r[0]?.status === "done");
        type Listed = { id: number; counterpartyName: string; ultimateParty: string; bookingText: string; categoryId: number | null };
        const list = async (q?: string) => (await api<{ items: Listed[] }>("GET", `/api/transactions?scope=all&range=all${q ? `&q=${encodeURIComponent(q)}` : ""}`)).body.items;
        const card = (await list()).find((x) => x.counterpartyName === "Landesbank Muster");
        expect(card).toMatchObject({ ultimateParty: "Shop Muster", bookingText: "KARTENZAHLUNG", categoryId: rule });
        // Bookings without an ultimate party keep it empty
        expect((await list()).find((x) => x.counterpartyName === "Stadtwerke")).toMatchObject({ ultimateParty: "", bookingText: "" });
        for (const q of ["gegenseite:shop", "gegenseite:landesbank", "umsatzart:kartenzahlung", "art:karten*"]) expect((await list(q)).map((x) => x.id), q).toEqual([card!.id]);
        expect(await list("kartenzahlung")).toEqual([]);
        expect((await api<{ hits: number }>("POST", "/api/rules", { query: "umsatzart:kartenzahlung", categoryId: rule })).body.hits).toBe(1);
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
