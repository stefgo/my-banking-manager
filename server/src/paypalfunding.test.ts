// Where the money of PayPal payments came from: the real Enable Banking connector embedded in the
// server, against the simulated Enable Banking with made-up bookings in the form PayPal sends.

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbeddedConnector } from "@mbm/connector-enablebanking/embedded";
import { fakeEnableBanking, PAYPAL, paypalAccount, type FakeAccount, type FakeEnableBanking } from "@mbm/connector-enablebanking/testing";
import type { BankConnection, CategoryList, OfferedAccount, Rule, SyncRun } from "@mbm/shared";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";

type Api = Awaited<ReturnType<typeof setUpSignedIn>>["api"];

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_ID = randomUUID();
const credentials = { applicationId: APP_ID, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const CALLBACK = "http://localhost/bank-callback";

/** The date `n` days before today. */
const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

type Party = { name?: string | null; contact_details?: { email_address?: string | null } | null } | null;
const booking = (ref: string, days: number, amount: string, dir: "DBIT" | "CRDT", sub: string, party: Party, status = "BOOK") => ({
    entry_reference: ref,
    transaction_amount: { currency: "EUR", amount },
    credit_debit_indicator: dir,
    status,
    transaction_date: ago(days),
    [dir === "DBIT" ? "creditor" : "debtor"]: party,
    bank_transaction_code: { code: "PAYMENT", sub_code: sub },
    remittance_information: [],
});
const PP = { name: "PayPal (Europe) S.a r.l. et Cie, S.C.A." };

let t: TestApp;
let eb: FakeEnableBanking;
let api: Api;
let account: FakeAccount;

beforeEach(async () => {
    account = { ...paypalAccount(), transactions: [], balances: [{ balance_amount: { currency: "EUR", amount: "0.00" }, balance_type: "XPCD", reference_date: null }] };
    eb = fakeEnableBanking({ applicationId: APP_ID, publicKey, aspsps: [PAYPAL], accounts: [account], redirectUrls: [CALLBACK] });
    t = await createTestApp({ connectors: { enablebanking: { embedded: true } } }, { loadEmbeddedConnectors: { enablebanking: () => createEmbeddedConnector({}, { client: { fetch: eb.fetch } }) } });
    ({ api } = await setUpSignedIn(t));
});
afterEach(() => t.close());

async function paypal(): Promise<number> {
    const conn = await api<BankConnection>("POST", "/api/psd2/connections", { aspsp: "PayPal", country: "DE" });
    const id = conn.body.id;
    await api("PUT", `/api/bank-connections/${id}/psd2-login`, { credentials });
    await api("POST", `/api/bank-connections/${id}/consent`, { redirectUrl: CALLBACK });
    expect((await api("POST", "/api/psd2/consent", eb.approve())).status).toBe(200);
    const offered = await api<{ data: { accounts: OfferedAccount[] } }>("POST", `/api/bank-connections/${id}/login/accounts`);
    const taken = await api<{ created: number[] }>("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: offered.body.data.accounts[0]!.externalId }] });
    return taken.body.created[0]!;
}

async function sync(): Promise<SyncRun> {
    const started = await api<SyncRun[]>("POST", "/api/sync", {});
    for (let i = 0; i < 200; i++) {
        const run = (await api<SyncRun[]>("GET", "/api/sync")).body.find((r) => r.id === started.body[0]!.id);
        if (run && run.status !== "running") {
            expect(run.status, JSON.stringify(run)).toBe("done");
            return run;
        }
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("run did not finish");
}

interface Row {
    id: number;
    d: string;
    amount: number;
    party: string;
    text: string;
    of: number | null;
    cat: string | null;
    src: string | null;
}
const rows = (accountId: number): Row[] =>
    t.vault.database
        .prepare(
            `SELECT t.id, t.booking_date AS d, t.amount, t.counterparty_name AS party, t.booking_text AS text, t.funding_of_id AS of, c.name AS cat, tc.source AS src
             FROM transactions t LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id LEFT JOIN categories c ON c.id = tc.category_id
             WHERE t.account_id = ? ORDER BY t.booking_date, t.id`,
        )
        .all(accountId) as Row[];
const added = (accountId: number) => rows(accountId).filter((r) => r.of !== null);
const byText = (accountId: number, text: string) => rows(accountId).find((r) => r.text === text)!;

describe("where the money of PayPal payments came from", () => {
    it("adds debits and credits from the balance, marks PayPal's own moves and counts them nowhere", async () => {
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const shopping = cats.find((c) => c.name === "Supermarkt")!;
        // A rule that would take PayPal's own bookings: they keep the preset category all the same
        expect((await api<Rule>("POST", "/api/rules", { query: "gegenseite:paypal", categoryId: shopping.id })).status).toBe(200);
        account.transactions = [
            booking("R10", 20, "50.00", "DBIT", "LOAN", PP), // repayment of B
            booking("R9", 29, "12.00", "DBIT", "MONEY_TRANSFER", {}), // payout to the bank account
            booking("R8", 30, "12.00", "CRDT", "PAYMENT", { name: "Freundin Fiktiv" }),
            booking("R7", 39, "3.00", "DBIT", "PAYMENT", { name: "Bäckerei Probe" }),
            booking("R6", 40, "5.00", "CRDT", "REFUND", { name: "Shop A" }),
            booking("R5", 44, "15.00", "CRDT", "REFUND", { name: "Shop C" }), // gives back the rejected R4
            booking("R4", 45, "15.00", "DBIT", "PAYMENT", { name: "Shop C" }, "RJCT"),
            booking("R3", 50, "50.00", "DBIT", "PAYMENT", { name: "Möbel Muster" }), // B, with Pay in 30 days
            booking("R1", 60, "19.99", "DBIT", "PAYMENT", { name: "Shop A" }), // A, from outside
        ];
        const accountId = await paypal();
        await sync();

        const purchaseA = rows(accountId).find((r) => r.amount === -1999)!;
        const purchaseB = rows(accountId).find((r) => r.amount === -5000 && r.text === "Zahlung")!;
        const repayment = byText(accountId, "Rückzahlung Später bezahlen");
        expect(added(accountId).map(({ d, amount, party, text, of, cat, src }) => ({ d, amount, party, text, of, cat, src }))).toEqual([
            { d: ago(60), amount: 1999, party: "Bankkonto oder Karte", text: "Abbuchung", of: purchaseA.id, cat: "Umbuchung", src: "auto" },
            { d: ago(50), amount: 5000, party: "PayPal Später bezahlen", text: "Später bezahlen", of: purchaseB.id, cat: "Umbuchung", src: "auto" },
            // 15 + 5 − 3 + 12 − 12 = 17 in the balance, the rest of the repayment from outside
            { d: ago(20), amount: 3300, party: "Bankkonto oder Karte", text: "Abbuchung", of: repayment.id, cat: "Umbuchung", src: "auto" },
        ]);
        expect(repayment).toMatchObject({ cat: "Umbuchung", src: "auto", party: PP.name });
        expect(byText(accountId, "Auszahlung auf Bankkonto")).toMatchObject({ party: "Bankkonto", cat: "Umbuchung" });
        expect(byText(accountId, "Erstattung zu abgelehnter Zahlung")).toMatchObject({ amount: 1500, cat: "Umbuchung" });
        // The balance of 0 needs no opening balance any more
        expect(t.vault.database.prepare("SELECT opening_balance AS o FROM accounts WHERE id = ?").get(accountId)).toEqual({ o: 0 });

        // Counted: the purchases, the refund of A and the money received; nothing of the rest
        const cash = await api<{ income: number; expenses: number }>("GET", `/api/stats/cashflow?scope=all&from=${ago(70)}&to=${ago(0)}`);
        expect(cash.body).toMatchObject({ income: 1200 + 500, expenses: -(1999 + 5000 + 300) });

        // Added bookings are read; the payment shows its added booking and the other way round
        const list = await api<{ items: { id: number; fundingOfId: number | null; fundedById: number | null; unread: boolean }[] }>("GET", `/api/transactions?scope=account:${accountId}&range=all&limit=50`);
        const debitA = list.body.items.find((x) => x.fundingOfId === purchaseA.id)!;
        expect(debitA.unread).toBe(false);
        expect(list.body.items.find((x) => x.id === purchaseA.id)!.fundedById).toBe(debitA.id);

        // A rule run over everything proposes nothing for added bookings or PayPal's own moves
        const preview = await api<{ items: { transactionId: number }[] }>("GET", "/api/rules/preview?mode=all");
        expect(preview.status).toBe(200);
        const proposed = new Set(preview.body.items.map((i) => i.transactionId));
        for (const r of [...added(accountId), repayment]) expect(proposed.has(r.id), r.text).toBe(false);
    });

    it("turns the debit of a purchase into Pay in 30 days once its repayment comes, keeping the others", async () => {
        account.transactions = [booking("Q", 28, "10.00", "DBIT", "PAYMENT", { name: "Abo Dienst" }), booking("P", 30, "40.00", "DBIT", "PAYMENT", { name: "Möbel Muster" })];
        const accountId = await paypal();
        await sync();
        const first = added(accountId);
        expect(first.map((r) => [r.amount, r.text])).toEqual([
            [4000, "Abbuchung"],
            [1000, "Abbuchung"],
        ]);

        account.transactions.unshift(booking("L", 0, "40.00", "DBIT", "LOAN", PP));
        await sync();
        const second = added(accountId);
        expect(second.map((r) => [r.d, r.amount, r.text])).toEqual([
            [ago(30), 4000, "Später bezahlen"],
            [ago(28), 1000, "Abbuchung"],
            [ago(0), 4000, "Abbuchung"],
        ]);
        // The debit for Q stays the same booking
        expect(second[1]!.id).toBe(first[1]!.id);
        expect(second[0]!.id).not.toBe(first[0]!.id);
    });

    it("leaves a purchase its debit where two of the same amount fit the repayment (a subscription)", async () => {
        account.transactions = [
            booking("L", 0, "9.99", "DBIT", "LOAN", PP),
            booking("S2", 27, "9.99", "DBIT", "PAYMENT", { name: "Abo" }),
            booking("S1", 31, "9.99", "DBIT", "PAYMENT", { name: "Abo" }),
        ];
        const accountId = await paypal();
        await sync();
        expect(added(accountId).map((r) => r.text)).toEqual(["Abbuchung", "Abbuchung", "Abbuchung"]);
    });

    it("gives bookings stored before the marks existed their marks with one fetch from the start", async () => {
        account.transactions = [booking("L", 10, "40.00", "DBIT", "LOAN", PP), booking("M", 12, "5.00", "DBIT", "MONEY_TRANSFER", {}), booking("P", 40, "40.00", "DBIT", "PAYMENT", { name: "Möbel Muster" })];
        const accountId = await paypal();
        await sync();
        const db = t.vault.database;
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const shopping = cats.find((c) => c.name === "Supermarkt")!;
        // As an earlier version stored them: no marks, the old texts, a rule's or the user's category, nothing added
        db.exec(`UPDATE transactions SET raw = json_remove(raw, '$.transfer'), booking_text = 'Kredit' WHERE booking_text LIKE 'Rückzahlung%'`);
        db.exec(`UPDATE transactions SET raw = json_remove(raw, '$.transfer'), booking_text = 'Geldtransfer', counterparty_name = '' WHERE booking_text LIKE 'Auszahlung%'`);
        db.exec(`DELETE FROM transactions WHERE funding_of_id IS NOT NULL`);
        db.exec(`DELETE FROM transaction_categories`);
        const loanId = (db.prepare("SELECT id FROM transactions WHERE booking_text = 'Kredit'").get() as { id: number }).id;
        const payoutId = (db.prepare("SELECT id FROM transactions WHERE booking_text = 'Geldtransfer'").get() as { id: number }).id;
        db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source) VALUES (?, ?, -4000, 'rule')").run(loanId, shopping.id);
        db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source) VALUES (?, ?, -500, 'manual')").run(payoutId, shopping.id);
        db.prepare("UPDATE accounts SET refetch_all = 1 WHERE id = ?").run(accountId);
        const before = db.prepare("SELECT count(*) AS n FROM transactions WHERE account_id = ?").get(accountId);

        await sync();
        expect(eb.calls.filter((c) => c.path.endsWith("/transactions")).at(-1)!.query).toEqual({ strategy: "longest" });
        expect(db.prepare("SELECT refetch_all AS r FROM accounts WHERE id = ?").get(accountId)).toEqual({ r: 0 });
        const loan = rows(accountId).find((r) => r.id === loanId)!;
        const payout = rows(accountId).find((r) => r.id === payoutId)!;
        // The rule's category gives way, the user's stays
        expect(loan).toMatchObject({ text: "Rückzahlung Später bezahlen", cat: "Umbuchung", src: "auto" });
        expect(payout).toMatchObject({ text: "Auszahlung auf Bankkonto", party: "Bankkonto", cat: "Supermarkt", src: "manual" });
        // Nothing came twice; the purchase got its credit, the repayment its debit
        expect(added(accountId).map((r) => r.text)).toEqual(["Später bezahlen", "Abbuchung"]);
        expect(db.prepare("SELECT count(*) AS n FROM transactions WHERE account_id = ? AND funding_of_id IS NULL").get(accountId)).toEqual(before);

        // The next fetch goes on from the newest booking again
        await sync();
        expect(eb.calls.filter((c) => c.path.endsWith("/transactions")).at(-1)!.query.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("adds nothing to other accounts and nothing without a balance", async () => {
        account.transactions = [booking("A", 5, "19.99", "DBIT", "PAYMENT", { name: "Shop" })];
        account.balances = [];
        const accountId = await paypal();
        await sync();
        expect(added(accountId)).toEqual([]);
    });
});
