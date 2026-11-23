import { ConnectorTransaction, type Account, type Rule, type RulePreview, type RuleTestResult, type Transaction, type TransactionList } from "@mbm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFetch } from "./services/fetchimport.js";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";

const OWN = "DE02700543060001234567";
const WERKE = "DE89370400440532013000";

const bank = (over: Record<string, unknown> = {}) => ({
    bookingDate: "2026-10-30", valueDate: "2026-10-30", amount: -5000, currency: "EUR", status: "booked", counterpartyName: "PAYPAL EUROPE", ultimateParty: "", counterpartyIban: WERKE, counterpartyBic: null,
    remittance: "Ihr Einkauf bei SPOTIFY", endToEndId: null, mandateId: null, creditorId: null, bookingText: "", bankReference: null, isReturn: false, returnReason: "", ...over,
});

let t: TestApp;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];
let accountId: number;
let cat: number;
let other: number;

const fetched = (txs: unknown[], account = accountId) => applyFetch(t.vault.database, account, ConnectorTransaction.array().parse(txs), null, null);
const list = async () => (await api<TransactionList>("GET", "/api/transactions?range=all")).body.items.sort((a, b) => a.id - b.id);
const one = async () => (await list())[0]!;
const preview = async (mode: "empty" | "all" = "empty", ruleId?: number) => (await api<RulePreview>("GET", `/api/rules/preview?mode=${mode}${ruleId ? `&ruleId=${ruleId}` : ""}`)).body;
const apply = (plan: RulePreview, mode: "empty" | "all", deviations: object[] = [], ruleId?: number) => api<{ changed: number }>("POST", "/api/rules/apply", { mode, planHash: plan.planHash, deviations, ruleId });
const addRule = async (body: object) => (await api<Rule>("POST", "/api/rules", body)).body;
const spotify = { query: "zweck:einkauf", extracts: [{ id: "s", input: { field: "remittance" }, type: "pattern", pattern: "Einkauf bei {h}" }], edits: [{ op: "set", field: "counterparty", value: "{h:titel}" }] };
const bankColumns = () => t.vault.database.prepare("SELECT id, counterparty_name, ultimate_party, counterparty_iban, remittance, amount, booking_date, status, reference FROM transactions ORDER BY id").all();

beforeEach(async () => {
    t = await createTestApp();
    ({ api } = await setUpSignedIn(t));
    const db = t.vault.database;
    accountId = Number(db.prepare("INSERT INTO accounts (kind, name, icon, color, position, created_at, iban) VALUES ('giro', 'Giro', 'landmark', 'blue', 0, '2026-01-01T00:00:00Z', ?)").run(OWN).lastInsertRowid);
    cat = (await api<{ id: number }>("POST", "/api/categories", { name: "Abos", parentId: null, icon: "coffee", color: "orange" })).body.id;
    other = (await api<{ id: number }>("POST", "/api/categories", { name: "Reisen", parentId: null, icon: "coffee", color: "blue" })).body.id;
});
afterEach(async () => {
    await t.close();
});

describe("rules on new bookings", () => {
    it("writes the result next to the bank's values", async () => {
        await addRule({ ...spotify, categoryId: cat });
        fetched([bank()]);
        expect(await one()).toMatchObject({ counterpartyName: "PAYPAL EUROPE", remittance: "Ihr Einkauf bei SPOTIFY", categoryId: cat, edits: { counterparty: { value: "Spotify", source: "rule" }, remittance: null } });
    });

    it("finds shown and original values in the search, while rules read the bank's only", async () => {
        await addRule({ ...spotify, categoryId: cat });
        fetched([bank()]);
        for (const q of ["gegenseite:spotify", "gegenseite:paypal", "spotify"]) expect((await api<TransactionList>("GET", `/api/transactions?range=all&q=${encodeURIComponent(q)}`)).body.count, q).toBe(1);
        expect((await addRule({ query: "gegenseite:spotify", categoryId: other })).hits).toBe(0);
    });

    it("lets a pending booking that comes back keep its values without running new rules", async () => {
        fetched([bank({ status: "pending", valueDate: null })]);
        const pending = await one();
        await api("PUT", `/api/transactions/${pending.id}/edits/counterparty`, { value: "Von Hand" });
        await addRule({ query: "zweck:einkauf", categoryId: cat, edits: [{ op: "set", field: "remittance", value: "Neu" }] });
        fetched([bank({ status: "pending", valueDate: null })]);
        const again = await one();
        expect(again.id).not.toBe(pending.id);
        expect(again).toMatchObject({ categoryId: null, edits: { counterparty: { value: "Von Hand", source: "manual" }, remittance: null } });
    });

    it("fills only empty fields of the booked version of a pending booking", async () => {
        fetched([bank({ status: "pending", valueDate: null })]);
        await api("PUT", `/api/transactions/${(await one()).id}/edits/counterparty`, { value: "Von Hand" });
        await addRule({ ...spotify, edits: [...spotify.edits, { op: "set", field: "remittance", value: "Musik" }], categoryId: cat });
        fetched([bank()]);
        expect(await one()).toMatchObject({ status: "booked", categoryId: cat, edits: { counterparty: { value: "Von Hand", source: "manual" }, remittance: { value: "Musik", source: "rule" } } });
    });

    it("gives a linked return the category of its booking and the texts of the rules", async () => {
        await addRule({ ...spotify, categoryId: cat });
        await addRule({ query: "zweck:storno", categoryId: other });
        fetched([bank({ endToEndId: "E1" }), bank({ bookingDate: "2026-11-02", valueDate: "2026-11-02", amount: 5000, endToEndId: "E1", isReturn: true, returnReason: "AM04" })]);
        const [debit, back] = await list();
        expect(debit).toMatchObject({ categoryId: cat, returnedById: back!.id });
        expect(back).toMatchObject({ returnOfId: debit!.id, categoryId: cat, categorySource: "auto", edits: { counterparty: { value: "Spotify" } } });
    });

    it("keeps the category of a file and adds the texts of the rules on a CSV import", async () => {
        await addRule({ ...spotify, categoryId: cat });
        const content = ["Buchungstag;Betrag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Kategorie", "01.10.2026;-9,99;PAYPAL;Ihr Einkauf bei SPOTIFY;Reisen", "02.10.2026;-9,99;PAYPAL;Ihr Einkauf bei NETFLIX;"].join("\n");
        const shown = (await api<{ rows: { shownName: string | null }[] }>("POST", `/api/accounts/${accountId}/import/preview`, { fileName: "a.csv", content })).body;
        expect(shown.rows.map((r) => r.shownName)).toEqual(["Spotify", "Netflix"]);
        expect((await api("POST", `/api/accounts/${accountId}/import`, { fileName: "a.csv", content })).status).toBe(200);
        const [a, b] = await list();
        expect(a).toMatchObject({ categoryId: other, edits: { counterparty: { value: "Spotify" } } });
        expect(b).toMatchObject({ categoryId: cat, categorySource: "rule", edits: { counterparty: { value: "Netflix" } } });
    });

    it("applies a rule only in its chosen accounts and never widens it", async () => {
        const second = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body.id;
        const rule = await addRule({ query: "zweck:einkauf", categoryId: cat, accountIds: [second] });
        fetched([bank()]);
        expect((await one()).categoryId).toBeNull();
        await api("DELETE", `/api/accounts/${second}`);
        expect((await api<Rule[]>("GET", "/api/rules")).body.find((r) => r.id === rule.id)).toMatchObject({ accountIds: [], hits: 0 });
    });
});

describe("running rules", () => {
    it("changes nothing until a checked plan is taken over", async () => {
        fetched([bank()]);
        const before = bankColumns();
        const rule = await addRule({ ...spotify, categoryId: cat });
        expect(await one()).toMatchObject({ categoryId: null, edits: { counterparty: null } });
        const plan = await preview();
        expect(plan.items[0]!.changes.map((c) => [c.field, c.kind, c.selected])).toEqual([["counterparty", "fill", true], ["category", "fill", true]]);
        expect(await one()).toMatchObject({ categoryId: null });
        expect((await apply(plan, "empty")).body.changed).toBe(1);
        expect(await one()).toMatchObject({ categoryId: cat, edits: { counterparty: { value: "Spotify" } } });
        expect(bankColumns()).toEqual(before);
        // Changing or deleting the rule leaves the booking as it is
        await api("DELETE", `/api/rules/${rule.id}`);
        expect(await one()).toMatchObject({ categoryId: cat, edits: { counterparty: { value: "Spotify" } } });
    });

    it("keeps set values with 'empty' and asks before replacing them with 'all'", async () => {
        fetched([bank()]);
        const tx = await one();
        await api("PUT", "/api/transactions/category", { ids: [tx.id], categoryId: other });
        await api("PUT", `/api/transactions/${tx.id}/edits/counterparty`, { value: "Meins" });
        await addRule({ ...spotify, categoryId: cat });
        expect((await preview("empty")).items).toEqual([]);
        const plan = await preview("all");
        expect(plan.items[0]!.changes.map((c) => [c.field, c.kind, c.selected])).toEqual([["counterparty", "replace", false], ["category", "replace", false]]);
        expect((await apply(plan, "all")).body.changed).toBe(0);
        expect((await apply(plan, "all", [{ key: plan.items[0]!.key, field: "category", selected: true }])).body.changed).toBe(1);
        expect(await one()).toMatchObject({ categoryId: cat, edits: { counterparty: { value: "Meins", source: "manual" } } });
    });

    it("resets texts of rules that no longer hit, but never removes a category", async () => {
        const rule = await addRule({ ...spotify, categoryId: cat });
        fetched([bank()]);
        await api("DELETE", `/api/rules/${rule.id}`);
        const plan = await preview("all");
        expect(plan.items[0]!.changes).toMatchObject([{ field: "counterparty", kind: "reset", after: "PAYPAL EUROPE" }]);
        await apply(plan, "all");
        expect(await one()).toMatchObject({ categoryId: cat, edits: { counterparty: null } });
    });

    it("runs one rule only on the bookings it wins", async () => {
        fetched([bank(), bank({ bookingDate: "2026-10-29", remittance: "Ihr Einkauf bei REWE" })]);
        const top = await addRule({ query: "zweck:rewe", categoryId: other });
        const low = await addRule({ ...spotify, categoryId: cat });
        expect((await api<Rule[]>("GET", "/api/rules")).body.map((r) => [r.hits, r.wins])).toEqual([[1, 1], [2, 1]]);
        const plan = await preview("empty", low.id);
        expect(plan.items.map((i) => i.remittance)).toEqual(["Ihr Einkauf bei SPOTIFY"]);
        expect(plan.items[0]!.ruleId).toBe(low.id);
        expect(top.id).not.toBe(low.id);
    });

    it("accepts a plan when only the same pending bookings came again", async () => {
        fetched([bank({ status: "pending", valueDate: null })]);
        await addRule({ ...spotify, categoryId: cat });
        const plan = await preview();
        fetched([bank({ status: "pending", valueDate: null })]);
        expect((await apply(plan, "empty")).body.changed).toBe(1);
        expect(await one()).toMatchObject({ categoryId: cat, edits: { counterparty: { value: "Spotify" } } });
    });

    it("refuses a stale plan and writes nothing", async () => {
        fetched([bank()]);
        const tx = await one();
        const rule = await addRule({ ...spotify, categoryId: cat });
        const plan = await preview();
        await api("PATCH", `/api/rules/${rule.id}`, { categoryId: other });
        expect((await apply(plan, "empty")).status).toBe(409);
        await api("PATCH", `/api/rules/${rule.id}`, { categoryId: cat });
        await api("PUT", "/api/transactions/category", { ids: [tx.id], categoryId: other });
        expect((await apply(plan, "empty")).status).toBe(409);
        expect(await one()).toMatchObject({ categoryId: other, edits: { counterparty: null } });
    });

    it("keeps the parts of a split booking", async () => {
        fetched([bank()]);
        const tx = await one();
        const db = t.vault.database;
        db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source) VALUES (?, ?, -2000, 'manual'), (?, ?, -3000, 'manual')").run(tx.id, cat, tx.id, other);
        await addRule({ ...spotify, categoryId: cat });
        const plan = await preview("all");
        expect(plan.items[0]).toMatchObject({ split: true });
        expect(plan.items[0]!.changes.map((c) => c.field)).toEqual(["counterparty"]);
    });

    it("logs only counts", async () => {
        fetched([bank()]);
        await addRule({ ...spotify, categoryId: cat });
        await apply(await preview(), "empty");
        const rows = t.vault.database.prepare("SELECT target, details FROM activity_log WHERE action = 'rules_applied'").all() as { target: string | null; details: string }[];
        expect(rows).toEqual([{ target: null, details: "1 Umsätze" }]);
    });
});

describe("trying a draft", () => {
    it("shows hits, misses and the rules above it without writing", async () => {
        fetched([bank(), bank({ bookingDate: "2026-10-29", remittance: "Ihr Einkauf bei REWE" }), bank({ bookingDate: "2026-10-28", remittance: "Einkauf" })]);
        const top = await addRule({ query: "zweck:rewe", categoryId: other });
        const r = (await api<RuleTestResult>("POST", "/api/rules/test", { ...spotify, categoryId: cat })).body;
        expect(r).toMatchObject({ matches: 3, hits: 2, missed: 1, wins: 1, takenBy: [{ ruleId: top.id, count: 1 }] });
        expect(r.samples.find((s) => s.remittance === "Ihr Einkauf bei SPOTIFY")).toMatchObject({ newCounterparty: "Spotify", values: { h: "SPOTIFY" }, hit: true, takenBy: null });
        expect((await list()).every((x) => x.categoryId === null)).toBe(true);
    });
});

describe("own values", () => {
    it("shows the bank's value on purpose and can give the field back to the rules", async () => {
        fetched([bank()]);
        const tx = await one();
        await api("PUT", `/api/transactions/${tx.id}/edits/counterparty`, { value: null });
        await addRule({ ...spotify, categoryId: cat });
        expect((await preview()).items[0]!.changes.map((c) => c.field)).toEqual(["category"]);
        const cleared = (await api<Transaction>("DELETE", `/api/transactions/${tx.id}/edits/counterparty`)).body;
        expect(cleared.edits.counterparty).toBeNull();
        expect((await preview()).items[0]!.changes.map((c) => c.field)).toEqual(["counterparty", "category"]);
    });

    it("drops the adjustment when the text of a booking by hand changes", async () => {
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body.id;
        const tx = (await api<Transaction>("POST", `/api/accounts/${cash}/transactions`, { bookingDate: "2026-10-01", amount: -100, counterpartyName: "Alt", remittance: "Zweck" })).body;
        await api("PUT", `/api/transactions/${tx.id}/edits/counterparty`, { value: "Anders" });
        await api("PUT", `/api/transactions/${tx.id}/edits/remittance`, { value: "Bleibt" });
        const after = (await api<Transaction>("PATCH", `/api/transactions/${tx.id}`, { counterpartyName: "Neu" })).body;
        expect(after.edits).toMatchObject({ counterparty: null, remittance: { value: "Bleibt" } });
    });

    it("keeps a rule with text actions when its category is deleted", async () => {
        const keeps = await addRule({ ...spotify, categoryId: cat });
        const goes = await addRule({ query: "zweck:x", categoryId: cat });
        await api("DELETE", `/api/categories/${cat}`);
        const rules = (await api<Rule[]>("GET", "/api/rules")).body;
        expect(rules.map((r) => [r.id, r.categoryId])).toEqual([[keeps.id, null]]);
        expect(goes.id).not.toBe(keeps.id);
    });
});
