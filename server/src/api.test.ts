import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, AccountGroup, ActivityEntry, Card, Category, CategoryList, ImportPreview, ImportRecord, Rule, RulePreview, Transaction, TransactionList } from "@mbm/shared";
import { ROTATING_COLORS } from "@mbm/shared";
import { loadConfig } from "./config.js";
import { requireUser } from "./services/users.js";
import { confirmCode, createTestApp, nextCode, setUpSignedIn, type TestApp } from "./testing/testApp.js";

let t: TestApp;

beforeEach(async () => {
    t = await createTestApp();
});
afterEach(async () => {
    await t.close();
});

const PASSWORD = "sehr-geheimes-passwort";
const post = (url: string, payload: object, cookie?: string) => t.app.inject({ method: "POST", url, payload, headers: cookie ? { cookie } : {} });
const state = async () => ((await t.app.inject({ url: "/api/status" })).json() as { state: string }).state;

describe("setup, lock and unlock", () => {
    it("starts in setup, then is ready, and keeps nothing readable on disk", async () => {
        expect(await state()).toBe("setup");
        expect((await post("/api/setup", { name: "Anna", password: "zu kurz" })).statusCode).toBe(400);
        const setup = await post("/api/setup", { name: "Anna", password: PASSWORD });
        expect(setup.statusCode).toBe(200);
        expect(setup.json().recoveryKey).toMatch(/^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/);
        expect(setup.json().totp.secret).toMatch(/^[A-Z2-7]+$/);
        expect(await state()).toBe("ready");
        expect((await post("/api/setup", { name: "Ben", password: PASSWORD })).statusCode).toBe(409);

        t.vault.close();
        for (const f of readdirSync(t.dataDir)) {
            const content = readFileSync(path.join(t.dataDir, f));
            expect(content.includes("Anna"), f).toBe(false);
            expect(content.includes("anna"), f).toBe(false);
            expect(content.includes("Lebensmittel"), f).toBe(false);
        }
    });

    it("creates the start trees unless the set-up leaves them out", async () => {
        const { api } = await setUpSignedIn(t);
        expect((await api<CategoryList>("GET", "/api/categories")).body.items.length).toBeGreaterThan(0);
        expect((await api<AccountGroup[]>("GET", "/api/account-groups")).body.length).toBeGreaterThan(0);
    });

    it("leaves out the start categories or account groups on request", async () => {
        const { api } = await setUpSignedIn(t, "Anna", PASSWORD, { defaultCategories: false });
        expect((await api<CategoryList>("GET", "/api/categories")).body.items).toEqual([]);
        expect((await api<AccountGroup[]>("GET", "/api/account-groups")).body.length).toBeGreaterThan(0);
        await t.close();

        t = await createTestApp();
        const other = await setUpSignedIn(t, "Anna", PASSWORD, { defaultAccountGroups: false });
        expect((await other.api<CategoryList>("GET", "/api/categories")).body.items.length).toBeGreaterThan(0);
        expect((await other.api<AccountGroup[]>("GET", "/api/account-groups")).body).toEqual([]);
    });

    it("refuses data while locked and opens with the password of a signed-in session", async () => {
        const { api, session } = await setUpSignedIn(t);
        t.vault.lock();
        expect((await api("GET", "/api/accounts")).status).toBe(423);
        expect((await post("/api/auth/login", { name: "Anna", password: "falsch-falsch-falsch" }, session)).statusCode).toBe(401);
        expect(await state()).toBe("locked");
        // One password, no code: the window was signed in before
        const back = await post("/api/auth/login", { name: "anna", password: PASSWORD }, session);
        expect(back.json()).toMatchObject({ status: "ok", user: { name: "Anna", sessionLocked: false } });
        expect(back.headers["set-cookie"]).toBeUndefined();
        expect((await api("GET", "/api/accounts")).status).toBe(200);
    });

    it("opens a locked session and the locked server with one password", async () => {
        const { api, session } = await setUpSignedIn(t);
        expect((await api("POST", "/api/auth/session/lock")).status).toBe(200);
        t.vault.lock();
        expect((await post("/api/auth/login", { name: "Anna", password: PASSWORD }, session)).json()).toMatchObject({ status: "ok" });
        expect((await api("GET", "/api/auth/me")).body).toMatchObject({ sessionLocked: false });
        expect((await api("GET", "/api/accounts")).status).toBe(200);
    });

    it("keeps the server locked until the second factor is there", async () => {
        const { secret } = await setUpSignedIn(t);
        t.vault.lock();
        const pw = { name: "Anna", password: PASSWORD };
        expect((await post("/api/auth/login", pw)).json()).toEqual({ status: "code_required" });
        expect(await state()).toBe("locked");
        expect((await post("/api/auth/login", { ...pw, code: "000000" })).statusCode).toBe(401);
        expect(await state()).toBe("locked");
        const ok = await post("/api/auth/login", { ...pw, code: nextCode(secret, 1) });
        expect(ok.json()).toMatchObject({ status: "ok", user: { name: "Anna" } });
        expect(await state()).toBe("ready");
    });

    it("does not tell a wrong name from a wrong password while locked", async () => {
        await setUpSignedIn(t);
        t.vault.lock();
        const unknown = await post("/api/auth/login", { name: "Niemand", password: PASSWORD });
        const wrong = await post("/api/auth/login", { name: "Anna", password: "falsch-falsch-falsch" });
        expect(unknown.statusCode).toBe(401);
        expect(unknown.json()).toEqual(wrong.json());
    });

    it("sets a new password with the recovery key", async () => {
        const { api, secret, recoveryKey } = await setUpSignedIn(t);
        t.vault.lock();
        const next = "ein-ganz-neues-passwort";
        expect((await post("/api/recover", { recoveryKey: "AAAA-BBBB", name: "Anna", password: next })).statusCode).toBe(401);
        expect((await post("/api/recover", { recoveryKey, name: "Niemand", password: next })).statusCode).toBe(404);
        expect(await state()).toBe("locked");
        expect((await post("/api/recover", { recoveryKey: recoveryKey.toLowerCase(), name: "Anna", password: next })).statusCode).toBe(200);
        expect(await state()).toBe("ready");
        // The old sessions are gone, the old password opens nothing
        expect((await api("GET", "/api/auth/me")).status).toBe(401);
        expect((await post("/api/auth/login", { name: "Anna", password: PASSWORD })).statusCode).toBe(401);
        const ok = await post("/api/auth/login", { name: "Anna", password: next, code: nextCode(secret, 1) });
        expect(ok.json()).toMatchObject({ status: "ok" });
    });

    it("replaces the recovery key only with the own password", async () => {
        const { api, recoveryKey } = await setUpSignedIn(t);
        expect((await api("POST", "/api/system/recovery-key", { password: "falsch-falsch-falsch" })).status).toBe(401);
        const fresh = await api<{ recoveryKey: string }>("POST", "/api/system/recovery-key", { password: PASSWORD });
        expect(fresh.status).toBe(200);
        t.vault.lock();
        expect((await post("/api/recover", { recoveryKey, name: "Anna", password: "ein-ganz-neues-passwort" })).statusCode).toBe(401);
        expect((await post("/api/recover", { recoveryKey: fresh.body.recoveryKey, name: "Anna", password: "ein-ganz-neues-passwort" })).statusCode).toBe(200);
    });
});

describe("sign-in", () => {
    it("logs a failed sign-in under a known name, but never writes an unknown name into the log", async () => {
        await setUpSignedIn(t);
        expect((await post("/api/auth/login", { name: "anna", password: "falsch-falsch-falsch" })).statusCode).toBe(401);
        expect((await post("/api/auth/login", { name: "<script>Mallory</script>", password: "falsch-falsch-falsch" })).statusCode).toBe(401);
        const rows = t.vault.database.prepare("SELECT user_id, user_name, target, details FROM activity_log WHERE action = 'login_failed' ORDER BY id").all();
        expect(rows).toEqual([
            { user_id: 1, user_name: "Anna", target: "Passwort", details: null },
            { user_id: null, user_name: null, target: "Passwort", details: "unbekannter Name" },
        ]);
        const dump = JSON.stringify(t.vault.database.prepare("SELECT * FROM activity_log").all());
        expect(dump).not.toContain("Mallory");
    });

    it("needs password and TOTP, and a code works only once", async () => {
        const { secret } = await setUpSignedIn(t);
        const pw = { name: "anna", password: PASSWORD };
        expect((await post("/api/auth/login", { ...pw, password: "falsch-falsch" })).statusCode).toBe(401);
        expect((await post("/api/auth/login", pw)).json()).toEqual({ status: "code_required" });
        const code = nextCode(secret, 1);
        const ok = await post("/api/auth/login", { ...pw, code });
        expect(ok.json()).toMatchObject({ status: "ok", user: { name: "Anna" } });
        expect(ok.headers["set-cookie"]).toMatch(/HttpOnly/);
        expect((await post("/api/auth/login", { ...pw, code })).statusCode).toBe(401);
    });

    it("refuses requests without session and ends a revoked session", async () => {
        const { api } = await setUpSignedIn(t);
        expect((await t.app.inject({ url: "/api/accounts" })).statusCode).toBe(401);
        const me = await api<{ deviceId: number }>("GET", "/api/auth/me");
        expect(me.status).toBe(200);
        expect((await api("DELETE", `/api/devices/${me.body.deviceId}`)).status).toBe(200);
        expect((await api("GET", "/api/auth/me")).status).toBe(401);
    });

    it("manages further users without rights", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const created = await api<{ id: number; totpActive: boolean }>("POST", "/api/users", { name: "Ben", password: "noch-ein-passwort", code: confirmCode(t, secret) });
        expect(created.body.totpActive).toBe(false);
        // A name in use is refused before the code is checked
        expect((await api("POST", "/api/users", { name: "ben", password: "noch-ein-passwort", code: "000000" })).status).toBe(409);
        const list = await api<{ name: string }[]>("GET", "/api/users");
        expect(list.body.map((u) => u.name)).toEqual(["Anna", "Ben"]);
        expect((await api("DELETE", `/api/users/${created.body.id}`, { code: confirmCode(t, secret) })).status).toBe(200);
        const me = await api<{ id: number }>("GET", "/api/auth/me");
        expect((await api("DELETE", `/api/users/${me.body.id}`, { code: "000000" })).status).toBe(409);
    });

    it("lets every user open the locked server with their own password", async () => {
        const { api, secret } = await setUpSignedIn(t);
        await api("POST", "/api/users", { name: "Ben", password: "noch-ein-passwort", code: confirmCode(t, secret) });
        t.vault.lock();
        expect((await post("/api/auth/login", { name: "Ben", password: PASSWORD })).statusCode).toBe(401);
        // No second factor yet: the server opens so that Ben can set one up
        expect((await post("/api/auth/login", { name: "Ben", password: "noch-ein-passwort" })).json()).toMatchObject({ status: "totp_setup" });
        expect(await state()).toBe("ready");
    });

    it("closes the way in for a changed password and a removed user", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const ben = (await api<{ id: number }>("POST", "/api/users", { name: "Ben", password: "noch-ein-passwort", code: confirmCode(t, secret) })).body;
        expect((await api("POST", `/api/users/${ben.id}/password`, { password: "bens-neues-passwort", code: confirmCode(t, secret) })).status).toBe(200);
        expect((await api("POST", "/api/auth/password", { current: "falsch-falsch-falsch", next: "annas-neues-passwort" })).status).toBe(401);
        expect((await api("POST", "/api/auth/password", { current: PASSWORD, next: "annas-neues-passwort" })).status).toBe(200);
        t.vault.lock();
        expect((await post("/api/auth/login", { name: "Ben", password: "noch-ein-passwort" })).statusCode).toBe(401);
        expect((await post("/api/auth/login", { name: "Anna", password: PASSWORD })).statusCode).toBe(401);
        expect((await post("/api/auth/login", { name: "Ben", password: "bens-neues-passwort" })).json()).toMatchObject({ status: "totp_setup" });
    });

    it("forgets a removed user's password", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const ben = (await api<{ id: number }>("POST", "/api/users", { name: "Ben", password: "noch-ein-passwort", code: confirmCode(t, secret) })).body;
        expect((await api("DELETE", `/api/users/${ben.id}`, { code: confirmCode(t, secret) })).status).toBe(200);
        t.vault.lock();
        expect((await post("/api/auth/login", { name: "Ben", password: "noch-ein-passwort" })).statusCode).toBe(401);
        expect(await state()).toBe("locked");
    });
});

describe("profile", () => {
    it("starts with the default cards and keeps per-client settings apart", async () => {
        const { api } = await setUpSignedIn(t);
        const p = await api<{ settings: Record<string, unknown>; cards: Card[] }>("GET", "/api/profile?client=web");
        expect(p.body.cards.map((c) => c.type)).toEqual(["balance", "groups", "recent", "cashflow", "upcoming"]);
        expect(p.body.settings).toEqual({ theme: "dark", hideAmountsOnStart: false });
        await api("PUT", "/api/profile/settings/theme?client=web", { value: "light" });
        await api("PUT", "/api/profile/settings/hideAmountsOnStart?client=macos", { value: true });
        expect((await api("PUT", "/api/profile/settings/theme?client=web", { value: "blue" })).status).toBe(400);
        const web = await api<{ settings: Record<string, unknown> }>("GET", "/api/profile?client=web");
        const mac = await api<Record<string, unknown>>("GET", "/api/profile/settings?client=macos");
        expect(web.body.settings).toEqual({ theme: "light", hideAmountsOnStart: false });
        expect(mac.body).toEqual({ theme: "dark", hideAmountsOnStart: true });
    });

    it("no longer keeps what the browser stores itself", async () => {
        const { api } = await setUpSignedIn(t);
        expect((await api("PUT", "/api/profile/settings/sidebarWidth?client=web", { value: 300 })).status).toBe(400);
        expect((await api("PUT", "/api/profile/settings/defaultRange?client=web", { value: "30" })).status).toBe(400);
        expect((await api("PUT", "/api/profile/settings/collapsedGroups?client=web", { value: [1] })).status).toBe(400);
        expect((await api("PUT", "/api/profile/settings/expandedCategories?client=web", { value: [1] })).status).toBe(400);
    });

    it("checks a card's settings against its type", async () => {
        const { api } = await setUpSignedIn(t);
        const card = await api<Card>("POST", "/api/profile/cards", { type: "balance", config: { scope: "group:1", days: 90 } });
        expect(card.body.config).toEqual({ scope: "group:1", days: 90, forecast: true });
        expect((await api("POST", "/api/profile/cards", { type: "balance", config: { days: 45 } })).status).toBe(400);
        expect((await api("PATCH", `/api/profile/cards/${card.body.id}`, { config: { scope: "nonsense" } })).status).toBe(400);
        const reset = await api<Card[]>("POST", "/api/profile/cards/reset");
        expect(reset.body).toHaveLength(5);
    });

    it("sizes cards in a 12-column grid and keeps each type's minimum", async () => {
        const { api } = await setUpSignedIn(t);
        const p = await api<{ cards: Card[] }>("GET", "/api/profile?client=web");
        expect(p.body.cards.map((c) => [c.width, c.height])).toEqual([[8, null], [4, null], [8, null], [4, null], [4, null]]);
        const card = (await api<Card>("POST", "/api/profile/cards", { type: "cashflow" })).body;
        expect([card.width, card.height]).toEqual([4, null]);
        const big = await api<Card>("PATCH", `/api/profile/cards/${card.id}`, { width: 12, height: 6 });
        expect([big.body.width, big.body.height]).toEqual([12, 6]);
        const auto = await api<Card>("PATCH", `/api/profile/cards/${card.id}`, { height: null });
        expect([auto.body.width, auto.body.height]).toEqual([12, null]);
        const balance = (await api<Card>("POST", "/api/profile/cards", { type: "balance", width: 1, height: 2 })).body;
        expect([balance.width, balance.height]).toEqual([4, 5]);
        expect((await api("PATCH", `/api/profile/cards/${card.id}`, { width: 0 })).status).toBe(400);
        expect((await api("PATCH", `/api/profile/cards/${card.id}`, { width: 13 })).status).toBe(400);
        expect((await api("PATCH", `/api/profile/cards/${card.id}`, { height: 1 })).status).toBe(400);
    });
});

describe("offline accounts", () => {
    it("books, reconciles, links counter bookings and moves in the tree", async () => {
        const { api } = await setUpSignedIn(t);
        const groups = await api<AccountGroup[]>("GET", "/api/account-groups");
        const daily = groups.body.find((g) => g.name === "Alltag")!;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld", groupId: daily.id, openingBalance: 6000 })).body;
        const box = (await api<Account>("POST", "/api/accounts", { name: "Spardose" })).body;
        expect(cash.balance).toBe(6000);

        const spent = await api<Transaction>("POST", `/api/accounts/${cash.id}/transactions`, {
            bookingDate: "2026-11-03",
            amount: -1250,
            counterpartyName: "Wochenmarkt",
        });
        expect(spent.status).toBe(200);
        expect(spent.body.source).toBe("manual");
        const after = (await api<Account[]>("GET", "/api/accounts")).body.find((a) => a.id === cash.id)!;
        expect(after.balance).toBe(4750);

        // Counter booking: from cash into the money box, both get the preset category
        const counter = await api<Transaction>("POST", `/api/transactions/${spent.body.id}/counter`, { accountId: box.id });
        expect(counter.body).toMatchObject({ accountId: box.id, amount: 1250, counterTransactionId: spent.body.id });
        const cats = await api<CategoryList>("GET", "/api/categories");
        const transfer = cats.body.items.find((c) => c.counterDefault)!;
        expect(transfer.name).toBe("Umbuchung");
        const list = await api<TransactionList>("GET", "/api/transactions?scope=all&range=all");
        expect(list.body.items.every((x) => x.categoryId === transfer.id)).toBe(true);
        expect((await api("DELETE", `/api/transactions/${spent.body.id}/counter`)).status).toBe(200);
        const unlinked = await api<TransactionList>("GET", "/api/transactions?scope=all&range=all");
        expect(unlinked.body.items).toHaveLength(1);
        expect(unlinked.body.items[0]!.categoryId).toBeNull();

        // Reconcile: counted 40,00 € → difference booking
        const rec = await api<{ difference: number; transactionId: number }>("POST", `/api/accounts/${cash.id}/reconcile`, { date: "2026-11-05", balance: 4000 });
        expect(rec.body.difference).toBe(-750);
        expect((await api<Account[]>("GET", "/api/accounts")).body.find((a) => a.id === cash.id)!.balance).toBe(4000);

        // Tree: move the money box into "Alltag" before the cash account
        await api("POST", "/api/account-tree/move", { kind: "account", id: box.id, parentId: daily.id, index: 0 });
        const accs = (await api<Account[]>("GET", "/api/accounts")).body;
        expect(accs.find((a) => a.id === box.id)).toMatchObject({ groupId: daily.id, position: 0 });
        expect(accs.find((a) => a.id === cash.id)).toMatchObject({ position: 1 });
        // Dissolving a group moves its content up
        await api("DELETE", `/api/account-groups/${daily.id}`);
        expect((await api<Account[]>("GET", "/api/accounts")).body.every((a) => a.groupId === daily.parentId)).toBe(true);
    });

    it("gives a counter booking the chosen category, the preset or none", async () => {
        const { api } = await setUpSignedIn(t);
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const box = (await api<Account>("POST", "/api/accounts", { name: "Spardose" })).body;
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const preset = cats.find((c) => c.counterDefault)!;
        const food = cats.find((c) => c.name === "Lebensmittel")!;
        // A second transfer category, below another one
        const saving = (await api<{ id: number }>("POST", "/api/categories", { parentId: preset.id, name: "Sparen" })).body;
        const book = async (categoryId: number | null) =>
            (await api<Transaction>("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-11-02", amount: -1000, counterpartyName: "Spardose", categoryId })).body;
        const categoryOf = async (id: number) => (await api<TransactionList>("GET", "/api/transactions?scope=all&range=all")).body.items.find((x) => x.id === id)?.categoryId;

        // Chosen category: both get it; unlinking takes it from the booking again
        const a = await book(null);
        const ca = (await api<Transaction>("POST", `/api/transactions/${a.id}/counter`, { accountId: box.id, categoryId: saving.id })).body;
        expect(await categoryOf(a.id)).toBe(saving.id);
        expect(await categoryOf(ca.id)).toBe(saving.id);
        await api("DELETE", `/api/transactions/${a.id}/counter`);
        expect(await categoryOf(a.id)).toBeNull();
        expect(await categoryOf(ca.id)).toBeUndefined();

        // No category: the booking keeps its own, also after unlinking; the counter booking has none
        const b = await book(food.id);
        const cb = (await api<Transaction>("POST", `/api/transactions/${b.id}/counter`, { accountId: box.id, categoryId: null })).body;
        expect(await categoryOf(b.id)).toBe(food.id);
        expect(await categoryOf(cb.id)).toBeNull();
        await api("DELETE", `/api/transactions/${b.id}/counter`);
        expect(await categoryOf(b.id)).toBe(food.id);

        // Recategorised by hand after the counter booking: unlinking leaves it alone
        const c = await book(null);
        await api("POST", `/api/transactions/${c.id}/counter`, { accountId: box.id });
        expect(await categoryOf(c.id)).toBe(preset.id);
        await api("PUT", "/api/transactions/category", { ids: [c.id], categoryId: food.id });
        await api("DELETE", `/api/transactions/${c.id}/counter`);
        expect(await categoryOf(c.id)).toBe(food.id);

        // The preset moves to another category, and only one has it
        expect((await api("PATCH", `/api/categories/${saving.id}`, { counterDefault: true })).status).toBe(200);
        const moved = (await api<CategoryList>("GET", "/api/categories")).body.items.filter((x) => x.counterDefault);
        expect(moved.map((x) => x.id)).toEqual([saving.id]);
        const d = await book(null);
        await api("POST", `/api/transactions/${d.id}/counter`, { accountId: box.id });
        expect(await categoryOf(d.id)).toBe(saving.id);

        // Without a preset a counter booking has no category
        await api("PATCH", `/api/categories/${saving.id}`, { counterDefault: false });
        const e = await book(null);
        const ce = (await api<Transaction>("POST", `/api/transactions/${e.id}/counter`, { accountId: box.id })).body;
        expect(await categoryOf(e.id)).toBeNull();
        expect(await categoryOf(ce.id)).toBeNull();
        expect((await api("POST", `/api/transactions/${(await book(null)).id}/counter`, { accountId: box.id, categoryId: 99999 })).status).toBe(400);
    });

    it("only changes bookings entered by hand", async () => {
        const { api } = await setUpSignedIn(t);
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const csv = "Datum;Betrag;Name\n01.02.2026;-5,00;Kiosk\n";
        await api("POST", `/api/accounts/${cash.id}/import`, { fileName: "a.csv", content: csv });
        const imported = (await api<TransactionList>("GET", "/api/transactions?range=all")).body.items[0]!;
        expect((await api("PATCH", `/api/transactions/${imported.id}`, { amount: -600 })).status).toBe(409);
        expect((await api("DELETE", `/api/transactions/${imported.id}`)).status).toBe(409);
    });
});

describe("own information", () => {
    const info = {
        attributes: [
            { key: " Kundennummer ", value: " 4711 " },
            { key: "Ansprechpartner", value: "" },
        ],
        notes: "Erste Zeile\nZweite Zeile",
    };
    const stored = { attributes: [{ key: "Kundennummer", value: "4711" }, { key: "Ansprechpartner", value: "" }], notes: "Erste Zeile\nZweite Zeile" };
    const none = { attributes: [], notes: "" };

    it("stores, replaces and clears it on accounts, groups and categories", async () => {
        const { api } = await setUpSignedIn(t);
        const group = (await api<AccountGroup>("POST", "/api/account-groups", { name: "Verträge" })).body;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld", groupId: group.id })).body;
        const cat = (await api<Category>("POST", "/api/categories", { name: "Versicherung" })).body;
        expect([group.info, cash.info, cat.info]).toEqual([none, none, none]);

        const targets = [`/api/account-groups/${group.id}`, `/api/accounts/${cash.id}`, `/api/categories/${cat.id}`];
        for (const url of targets) {
            const res = await api<{ info: unknown }>("PATCH", url, { info });
            expect(res.status).toBe(200);
            expect(res.body.info).toEqual(stored);
        }
        // Lists carry it; other changes leave it alone
        await api("PATCH", `/api/accounts/${cash.id}`, { name: "Kasse" });
        expect((await api<AccountGroup[]>("GET", "/api/account-groups")).body.find((g) => g.id === group.id)!.info).toEqual(stored);
        expect((await api<Account[]>("GET", "/api/accounts")).body.find((a) => a.id === cash.id)!.info).toEqual(stored);
        expect((await api<CategoryList>("GET", "/api/categories")).body.items.find((c) => c.id === cat.id)!.info).toEqual(stored);

        // Replacing keeps the new order; an empty one clears it
        const swapped = { attributes: [stored.attributes[1]!, stored.attributes[0]!], notes: "" };
        expect((await api<Account>("PATCH", `/api/accounts/${cash.id}`, { info: swapped })).body.info).toEqual(swapped);
        for (const url of targets) expect((await api<{ info: unknown }>("PATCH", url, { info: none })).body.info).toEqual(none);
    });

    it("rejects duplicate labels, a value without a label and texts over the limits", async () => {
        const { api } = await setUpSignedIn(t);
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const patch = (info: object) => api("PATCH", `/api/accounts/${cash.id}`, { info });
        expect((await patch({ attributes: [{ key: "IBAN", value: "1" }, { key: "iban", value: "2" }], notes: "" })).status).toBe(400);
        expect((await patch({ attributes: [{ key: " ", value: "1" }], notes: "" })).status).toBe(400);
        expect((await patch({ attributes: [{ key: "x".repeat(61), value: "" }], notes: "" })).status).toBe(400);
        expect((await patch({ attributes: [{ key: "Wert", value: "x".repeat(501) }], notes: "" })).status).toBe(400);
        expect((await patch({ attributes: Array.from({ length: 51 }, (_, i) => ({ key: `K${i}`, value: "" })), notes: "" })).status).toBe(400);
        expect((await patch({ attributes: [], notes: "x".repeat(10001) })).status).toBe(400);
        expect((await patch({ attributes: Array.from({ length: 50 }, (_, i) => ({ key: `K${i}`, value: "v" })), notes: "x".repeat(10000) })).status).toBe(200);
    });

    it("goes with what is deleted; accounts of a dissolved group keep theirs", async () => {
        const { api } = await setUpSignedIn(t);
        const group = (await api<AccountGroup>("POST", "/api/account-groups", { name: "Verträge" })).body;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld", groupId: group.id })).body;
        await api("PATCH", `/api/account-groups/${group.id}`, { info });
        await api("PATCH", `/api/accounts/${cash.id}`, { info });
        await api("DELETE", `/api/account-groups/${group.id}`);
        expect((await api<Account[]>("GET", "/api/accounts")).body.find((a) => a.id === cash.id)!.info).toEqual(stored);

        const cat = (await api<Category>("POST", "/api/categories", { name: "Versicherung" })).body;
        await api("PATCH", `/api/categories/${cat.id}`, { info });
        await api("DELETE", `/api/categories/${cat.id}`);
        const again = (await api<Category>("POST", "/api/categories", { name: "Versicherung" })).body;
        expect(again.info).toEqual(none);
    });
});

describe("categories and rules", () => {
    it("assigns by rule when booking and on demand", async () => {
        const { api } = await setUpSignedIn(t);
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const market = cats.find((c) => c.name === "Supermarkt")!;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const before = await api<Transaction>("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-02-01", amount: -1000, counterpartyName: "REWE Markt" });
        expect(before.body.categoryId).toBeNull();
        const rule = await api<Rule>("POST", "/api/rules", { query: "gegenseite:rewe", categoryId: market.id });
        expect(rule.body.hits).toBe(1);
        // A new rule changes no existing booking until the preview is confirmed
        expect((await api<TransactionList>("GET", `/api/transactions?category=${market.id}&range=all`)).body.count).toBe(0);
        const preview = (await api<RulePreview>("GET", `/api/rules/preview?ruleId=${rule.body.id}`)).body;
        expect(preview).toMatchObject({ total: 1, items: [{ transactionId: before.body.id, categoryId: market.id, ruleId: rule.body.id }] });
        expect((await api<{ changed: number }>("POST", "/api/rules/apply", { ids: [before.body.id], ruleId: rule.body.id })).body.changed).toBe(1);
        expect((await api<TransactionList>("GET", `/api/transactions?category=${market.id}&range=all`)).body.count).toBe(1);
        const next = await api<Transaction>("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-02-02", amount: -200, counterpartyName: "Réwe City" });
        expect(next.body).toMatchObject({ categoryId: market.id, categorySource: "rule" });
        // The filter of a top-level category includes its subcategories
        expect((await api<TransactionList>("GET", `/api/transactions?category=${market.parentId}&range=all`)).body.count).toBe(2);
    });

    it("previews rules and applies only the confirmed bookings", async () => {
        const { api } = await setUpSignedIn(t);
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const market = cats.find((c) => c.name === "Supermarkt")!;
        const home = cats.find((c) => c.name === "Wohnen")!;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const book = async (bookingDate: string, counterpartyName: string, remittance = "") =>
            (await api<Transaction>("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate, amount: -500, counterpartyName, remittance })).body.id;
        const a = await book("2026-03-01", "REWE Markt", "Miete Garage");
        const b = await book("2026-03-02", "REWE City");
        const c = await book("2026-03-03", "Bäckerei", "Miete Garage");
        const manual = await book("2026-03-04", "REWE Süd");
        await api("PUT", "/api/transactions/category", { ids: [manual], categoryId: home.id });

        const first = (await api<Rule>("POST", "/api/rules", { query: "gegenseite:rewe", categoryId: market.id })).body;
        const second = (await api<Rule>("POST", "/api/rules", { query: "zweck:miete", categoryId: home.id })).body;

        // All rules: the first matching rule wins, newest first, bookings with a category are left out
        const all = (await api<RulePreview>("GET", "/api/rules/preview")).body;
        expect(all.total).toBe(3);
        expect(all.items.map((m) => [m.transactionId, m.ruleId])).toEqual([[c, second.id], [b, first.id], [a, first.id]]);

        // One rule: it applies whatever its position, also where an earlier rule matches too
        const one = (await api<RulePreview>("GET", `/api/rules/preview?ruleId=${second.id}`)).body;
        expect(one.items.map((m) => [m.transactionId, m.categoryId])).toEqual([[c, home.id], [a, home.id]]);

        // Only the confirmed bookings change; bookings that got a category meanwhile are skipped
        await api("PUT", "/api/transactions/category", { ids: [c], categoryId: market.id });
        expect((await api<{ changed: number }>("POST", "/api/rules/apply", { ids: [a, c, manual], ruleId: second.id })).body.changed).toBe(1);
        const items = (await api<TransactionList>("GET", "/api/transactions?range=all")).body.items;
        const cat = (id: number) => items.find((x) => x.id === id)!;
        expect(cat(a)).toMatchObject({ categoryId: home.id, categorySource: "rule" });
        expect(cat(b).categoryId).toBeNull();
        expect(cat(c)).toMatchObject({ categoryId: market.id, categorySource: "manual" });
        expect(cat(manual).categoryId).toBe(home.id);

        // Without a rule id the order counts again
        expect((await api<{ changed: number }>("POST", "/api/rules/apply", { ids: [b] })).body.changed).toBe(1);
        expect((await api<RulePreview>("GET", "/api/rules/preview")).body.total).toBe(0);
        expect((await api("POST", "/api/rules/apply", {})).status).toBe(400);

        // A rule that is switched off can be neither previewed nor applied on its own
        await api("PATCH", `/api/rules/${first.id}`, { active: false });
        const d = await book("2026-03-05", "REWE West");
        expect((await api("GET", `/api/rules/preview?ruleId=${first.id}`)).status).toBe(400);
        expect((await api("POST", "/api/rules/apply", { ids: [d], ruleId: first.id })).status).toBe(400);
        expect((await api("GET", "/api/rules/preview?ruleId=99999")).status).toBe(404);
    });

    it("nests to any depth but never into its own subtree", async () => {
        const { api } = await setUpSignedIn(t);
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const food = cats.find((c) => c.name === "Lebensmittel")!;
        const home = cats.find((c) => c.name === "Wohnen")!;
        const transfer = cats.find((c) => c.name === "Umbuchung")!;
        type Cat = { id: number; parentId: number | null; color: string | null; icon: string };
        const sub = (await api<Cat>("POST", "/api/categories", { parentId: food.id, name: "Markt" })).body;
        expect(sub).toMatchObject({ color: null, icon: food.icon });
        const deep = (await api<Cat>("POST", "/api/categories", { parentId: sub.id, name: "Bio" })).body;
        const deeper = (await api<Cat>("POST", "/api/categories", { parentId: deep.id, name: "Obst" })).body;
        expect(deeper.parentId).toBe(deep.id);

        // A category with children moves as a whole, also below a subcategory
        expect((await api("POST", "/api/categories/move", { id: home.id, parentId: deep.id, index: 0 })).status).toBe(200);
        const moved = (await api<CategoryList>("GET", "/api/categories")).body.items;
        expect(moved.find((c) => c.id === home.id)!.parentId).toBe(deep.id);
        expect(moved.filter((c) => c.parentId === home.id).length).toBeGreaterThan(0);

        // No circles: neither into itself nor into a descendant
        expect((await api("POST", "/api/categories/move", { id: food.id, parentId: food.id, index: 0 })).status).toBe(400);
        expect((await api("POST", "/api/categories/move", { id: food.id, parentId: deeper.id, index: 0 })).status).toBe(400);
        expect((await api("POST", "/api/categories/move", { id: sub.id, parentId: home.id, index: 0 })).status).toBe(400);

        // The preset category of counter bookings is a category like any other
        expect(transfer.counterDefault).toBe(true);
        expect((await api("POST", "/api/categories", { parentId: transfer.id, name: "Unter Umbuchung" })).status).toBe(200);
        expect((await api("POST", "/api/categories/move", { id: transfer.id, parentId: food.id, index: 0 })).status).toBe(200);
        expect((await api("DELETE", `/api/categories/${transfer.id}`)).status).toBe(200);
        expect((await api<CategoryList>("GET", "/api/categories")).body.items.some((c) => c.counterDefault)).toBe(false);

        // Back to the top: it keeps the colour it showed, inherited from the nearest ancestor
        await api("POST", "/api/categories/move", { id: deeper.id, parentId: null, index: 0 });
        const top = (await api<CategoryList>("GET", "/api/categories")).body.items.find((c) => c.id === deeper.id)!;
        expect(top).toMatchObject({ parentId: null, color: food.color, position: 0 });
    });

    it("deletes a whole subtree and moves its bookings and rules to the parent", async () => {
        const { api } = await setUpSignedIn(t);
        const food = (await api<CategoryList>("GET", "/api/categories")).body.items.find((c) => c.name === "Lebensmittel")!;
        const a = (await api<{ id: number }>("POST", "/api/categories", { parentId: food.id, name: "A" })).body;
        const b = (await api<{ id: number }>("POST", "/api/categories", { parentId: a.id, name: "B" })).body;
        const c = (await api<{ id: number }>("POST", "/api/categories", { parentId: b.id, name: "C" })).body;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const booking = (id: number, name: string) => api<Transaction>("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-02-01", amount: -100, counterpartyName: name, categoryId: id });
        const inA = (await booking(a.id, "X")).body;
        const inC = (await booking(c.id, "Y")).body;
        const rule = (await api<Rule>("POST", "/api/rules", { query: "gegenseite:zzz", categoryId: c.id })).body;

        // The filter of a category includes all levels below it
        expect((await api<TransactionList>("GET", `/api/transactions?category=${food.id}&range=all`)).body.count).toBe(2);
        expect((await api<TransactionList>("GET", `/api/transactions?category=${b.id}&range=all`)).body.count).toBe(1);

        await api("DELETE", `/api/categories/${a.id}?moveTo=${food.id}`);
        const left = (await api<CategoryList>("GET", "/api/categories")).body.items.map((x) => x.id);
        expect(left).not.toContain(a.id);
        expect(left).not.toContain(b.id);
        expect(left).not.toContain(c.id);
        const list = (await api<TransactionList>("GET", "/api/transactions?range=all")).body.items;
        expect(list.find((x) => x.id === inA.id)!.categoryId).toBe(food.id);
        expect(list.find((x) => x.id === inC.id)!.categoryId).toBe(food.id);
        expect((await api<Rule[]>("GET", "/api/rules")).body.find((r) => r.id === rule.id)!.categoryId).toBe(food.id);
    });

    it("leaves every level below an excluded category out of the figures", async () => {
        const { api } = await setUpSignedIn(t);
        const transfer = (await api<CategoryList>("GET", "/api/categories")).body.items.find((c) => c.name === "Umbuchung")!;
        const own = (await api<{ id: number }>("POST", "/api/categories", { parentId: null, name: "Eigene" })).body;
        const sub = (await api<{ id: number }>("POST", "/api/categories", { parentId: own.id, name: "Sparen" })).body;
        const subsub = (await api<{ id: number }>("POST", "/api/categories", { parentId: sub.id, name: "Tagesgeld" })).body;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const post = (amount: number, categoryId: number | null) =>
            api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-02-01", amount, counterpartyName: "X", categoryId });
        await post(-1000, subsub.id);
        await post(-300, null);
        await post(5000, transfer.id);
        const flow = async () => (await api<{ income: number; expenses: number }>("GET", `/api/stats/cashflow?scope=account:${cash.id}&from=2026-02-01&to=2026-02-28`)).body;
        expect(await flow()).toMatchObject({ income: 0, expenses: -1300 });
        await api("PATCH", `/api/categories/${own.id}`, { excludedFromStats: true });
        expect(await flow()).toMatchObject({ income: 0, expenses: -300 });

        // "Ohne Kategorie" below an excluded category is left out as well
        await api("POST", "/api/categories/uncategorized/move", { parentId: sub.id, index: 0 });
        expect(await flow()).toMatchObject({ income: 0, expenses: 0 });
    });

    it("places Ohne Kategorie in the tree, where its bookings belong to the parent", async () => {
        const { api } = await setUpSignedIn(t);
        const list = async () => (await api<CategoryList>("GET", "/api/categories")).body;
        // Children of a parent in display order, "none" for "Ohne Kategorie"
        const rows = async (parentId: number | null) => {
            const l = await list();
            const out: (number | "none")[] = l.items.filter((c) => c.parentId === parentId).map((c) => c.id);
            if (l.none.parentId === parentId) {
                const at = l.none.position === null ? -1 : l.items.filter((c) => c.parentId === parentId).findIndex((c) => c.position >= l.none.position!);
                out.splice(at < 0 ? out.length : at, 0, "none");
            }
            return out;
        };
        const move = (parentId: number | null, index: number) => api("POST", "/api/categories/uncategorized/move", { parentId, index });
        expect((await list()).none).toEqual({ parentId: null, position: null });

        const food = (await list()).items.find((c) => c.name === "Lebensmittel")!;
        const a = (await api<{ id: number }>("POST", "/api/categories", { parentId: food.id, name: "A" })).body;
        const b = (await api<{ id: number }>("POST", "/api/categories", { parentId: food.id, name: "B" })).body;
        const kids = (await rows(food.id)).filter((x) => x !== a.id && x !== b.id);

        // Between A and B; it stays there when categories move, come or go around it
        expect((await move(food.id, kids.length + 1)).status).toBe(200);
        expect(await rows(food.id)).toEqual([...kids, a.id, "none", b.id]);
        await api("POST", "/api/categories/move", { id: b.id, parentId: food.id, index: 0 });
        expect(await rows(food.id)).toEqual([b.id, ...kids, a.id, "none"]);
        const c = (await api<{ id: number }>("POST", "/api/categories", { parentId: food.id, name: "C" })).body;
        expect(await rows(food.id)).toEqual([b.id, ...kids, a.id, c.id, "none"]);
        await api("POST", "/api/categories/move", { id: c.id, parentId: food.id, index: 0 });
        await api("POST", "/api/categories/move", { id: a.id, parentId: null, index: 0 });
        expect(await rows(food.id)).toEqual([c.id, b.id, ...kids, "none"]);
        // Past the end, a category goes before "Ohne Kategorie" that stays last; an exact index after it
        await api("POST", "/api/categories/move", { id: a.id, parentId: food.id, index: 9999 });
        expect(await rows(food.id)).toEqual([c.id, b.id, ...kids, a.id, "none"]);
        await api("POST", "/api/categories/move", { id: a.id, parentId: food.id, index: kids.length + 3 });
        expect(await rows(food.id)).toEqual([c.id, b.id, ...kids, "none", a.id]);
        await api("POST", "/api/categories/move", { id: a.id, parentId: null, index: 0 });
        expect(await rows(food.id)).toEqual([c.id, b.id, ...kids, "none"]);
        expect((await move(9999, 0)).status).toBe(404);

        // Its bookings belong to the parent and every ancestor, not to siblings
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-02-01", amount: -100, counterpartyName: "X", categoryId: null });
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-02-01", amount: -100, counterpartyName: "Y", categoryId: b.id });
        const count = async (cat: number | string) => (await api<TransactionList>("GET", `/api/transactions?category=${cat}&range=all`)).body.count;
        await move(b.id, 0);
        expect(await count(b.id)).toBe(2);
        expect(await count(food.id)).toBe(2);
        expect(await count(c.id)).toBe(0);
        expect(await count("none")).toBe(1);

        // Several categories: any of them matches, overlaps count once
        expect(await count(`${c.id},${b.id}`)).toBe(2);
        expect(await count(`none,${c.id}`)).toBe(1);
        expect(await count(`${food.id},${b.id},none`)).toBe(2);
        for (const bad of ["1,,2", "1,x", ",1", "all,1"]) {
            expect((await api("GET", `/api/transactions?category=${bad}&range=all`)).status).toBe(400);
        }

        // Deleting its parent puts it in the deleted category's place
        await api("DELETE", `/api/categories/${b.id}`);
        expect(await rows(food.id)).toEqual([c.id, "none", ...kids]);
        // B's booking lost its category, so both are without one now, still below "Lebensmittel"
        expect(await count("none")).toBe(2);
        expect(await count(food.id)).toBe(2);
    });
});

describe("rules with the search syntax", () => {
    it("creates, changes and applies rules with queries and refuses invalid ones", async () => {
        const { api } = await setUpSignedIn(t);
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const home = cats.find((c) => c.name === "Wohnen")!;
        const market = cats.find((c) => c.name === "Supermarkt")!;
        const giro = (await api<Account>("POST", "/api/accounts", { name: "Girokonto" })).body;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const book = async (accountId: number, amount: number, counterpartyName: string, remittance = "") =>
            (await api<Transaction>("POST", `/api/accounts/${accountId}/transactions`, { bookingDate: "2026-03-01", amount, counterpartyName, remittance })).body;

        const rent = (await api<Rule>("POST", "/api/rules", { query: 'zweck:miete >800 konto:giro', categoryId: home.id })).body;
        expect(rent).toMatchObject({ query: "zweck:miete >800 konto:giro", hits: 0, active: true });
        // New bookings get the category of the first matching rule
        expect((await book(giro.id, -95000, "Hausverwaltung", "Miete März")).categoryId).toBe(home.id);
        expect((await book(giro.id, -5000, "Garage", "Miete Stellplatz")).categoryId).toBeNull();
        expect((await book(cash.id, -95000, "Bar", "Miete März")).categoryId).toBeNull();

        const shop = (await api<Rule>("POST", "/api/rules", { query: '"bäckerei" ODER (gegenseite:rewe NICHT zweck:pfand)', categoryId: market.id })).body;
        const bakery = await book(cash.id, -300, "Bäckerei Huber");
        expect(bakery.categoryId).toBe(market.id);

        const changed = await api<Rule>("PATCH", `/api/rules/${rent.id}`, { query: "zweck:miete" });
        expect(changed.body).toMatchObject({ query: "zweck:miete", hits: 3 });
        // One rule alone counts the same hits as the whole list
        expect((await api<Rule[]>("GET", "/api/rules")).body.find((r) => r.id === rent.id)!.hits).toBe(3);
        const preview = (await api<RulePreview>("GET", `/api/rules/preview?ruleId=${rent.id}`)).body;
        expect(preview.total).toBe(2);

        for (const query of ["kat:wohnen", "datum:vormonat", "(miete", "", "   "]) {
            const r = await api<{ message: string }>("POST", "/api/rules", { query, categoryId: home.id });
            expect(r.status, query).toBe(400);
        }
        expect((await api("PATCH", `/api/rules/${shop.id}`, { query: "datum>-30t" })).status).toBe(400);
        expect((await api("POST", "/api/rules", { query: "datum>=2026", categoryId: home.id })).status).toBe(200);
    });
});

describe("CSV import", () => {
    const CSV = [
        "Buchungstag;Betrag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Kategorie",
        "01.10.2026;-950,00;Hausverwaltung;Miete Oktober;Wohnen\\Miete",
        "02.10.2026;-12,50;Bäckerei Huber;Brot;",
        "02.10.2026;-12,50;Bäckerei Huber;Brot;",
        "kaputt;1,00;X;;",
    ].join("\n");

    it("previews, imports, skips duplicates and can be undone", async () => {
        const { api } = await setUpSignedIn(t);
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Konto" })).body;
        // One equal booking already exists: only the second baker row is new
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-10-02", amount: -1250, counterpartyName: "BÄCKEREI HUBER", remittance: "Brot, Umsatzart: Lastschrift" });
        const preview = await api<ImportPreview>("POST", `/api/accounts/${cash.id}/import/preview`, { fileName: "x.csv", content: CSV });
        expect(preview.body.counts).toEqual({ new: 2, duplicate: 1, invalid: 1, differs: 0 });
        const rent = (await api<CategoryList>("GET", "/api/categories")).body.items.find((c) => c.name === "Miete")!;
        expect(preview.body.rows[0]!.categoryId).toBe(rent.id);

        const result = await api<{ importId: number; imported: number }>("POST", `/api/accounts/${cash.id}/import`, { fileName: "x.csv", content: CSV });
        expect(result.body).toMatchObject({ imported: 2, skipped: 1, invalid: 1 });
        const again = await api<ImportPreview>("POST", `/api/accounts/${cash.id}/import/preview`, { fileName: "x.csv", content: CSV });
        expect(again.body.counts).toEqual({ new: 0, duplicate: 3, invalid: 1, differs: 0 });

        await api("DELETE", `/api/imports/${result.body.importId}`);
        expect((await api<TransactionList>("GET", "/api/transactions?range=all")).body.count).toBe(1);
        // The record goes with its bookings
        expect((await api<ImportRecord[]>("GET", "/api/imports")).body).toEqual([]);
        const log = (await api<ActivityEntry[]>("GET", "/api/activity")).body;
        expect(log.find((e) => e.action === "import_undone")).toMatchObject({ target: "x.csv", details: "2 Buchungen entfernt" });
    });

    it("removes an import record without bookings", async () => {
        const { api } = await setUpSignedIn(t);
        const acc = (await api<Account>("POST", "/api/accounts", { name: "Konto" })).body;
        await api("POST", `/api/accounts/${acc.id}/import`, { fileName: "a.csv", content: CSV });
        // The same file again brings only duplicates: a record with nothing in it
        const empty = await api<{ importId: number; imported: number }>("POST", `/api/accounts/${acc.id}/import`, { fileName: "b.csv", content: CSV });
        expect(empty.body.imported).toBe(0);
        const before = (await api<ImportRecord[]>("GET", "/api/imports")).body;
        expect(before.find((i) => i.id === empty.body.importId)?.remaining).toBe(0);
        const count = (await api<TransactionList>("GET", "/api/transactions?range=all")).body.count;

        expect((await api("DELETE", `/api/imports/${empty.body.importId}`)).status).toBe(200);
        expect((await api<ImportRecord[]>("GET", "/api/imports")).body.map((i) => i.fileName)).toEqual(["a.csv"]);
        expect((await api<TransactionList>("GET", "/api/transactions?range=all")).body.count).toBe(count);
        const log = (await api<ActivityEntry[]>("GET", "/api/activity")).body;
        expect(log.find((e) => e.action === "import_removed")).toMatchObject({ target: "b.csv", details: null });
        expect(log.some((e) => e.action === "import_undone")).toBe(false);

        expect((await api("DELETE", `/api/imports/${empty.body.importId}`)).status).toBe(404);
    });

    it("applies rules on account, amount and date to the rows of a file", async () => {
        const { api } = await setUpSignedIn(t);
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const market = cats.find((c) => c.name === "Supermarkt")!;
        const acc = (await api<Account>("POST", "/api/accounts", { name: "Girokonto" })).body;
        await api("POST", "/api/rules", { query: "gegenseite:bäckerei <20 konto:giro datum>=2026-10", categoryId: market.id });
        const file = [
            "Buchungstag;Betrag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck",
            "02.10.2026;-12,50;Bäckerei Huber;Brot",
            "03.10.2026;-25,00;Bäckerei Huber;Torte",
            "30.09.2026;-5,00;Bäckerei Huber;Brötchen",
        ].join("\n");
        const preview = (await api<ImportPreview>("POST", `/api/accounts/${acc.id}/import/preview`, { fileName: "x.csv", content: file })).body;
        expect(preview.rows.map((r) => r.categoryId)).toEqual([market.id, null, null]);
    });

    it("creates the missing categories a file names only when asked", async () => {
        const { api } = await setUpSignedIn(t);
        const acc = (await api<Account>("POST", "/api/accounts", { name: "Tagesgeld" })).body;
        const file = [
            "Datum;Kategorie;Name;Betrag",
            "01.10.2026;Alle - Wohnen - Miete;Hausverwaltung;-950,00",
            "02.10.2026;Alle - Interne Umbuchung - Kontoumbuchung;Giro;5000,00",
            "03.10.2026;Alle - Interne Umbuchung - Kontoumbuchung;Giro;100,00",
            "04.10.2026;Kfz-Versicherung;Versicherer;-80,00",
        ].join("\n");
        const categories = async () => (await api<CategoryList>("GET", "/api/categories")).body.items;
        const count = (await categories()).length;
        const rent = (await categories()).find((c) => c.name === "Miete")!;

        const preview = (await api<ImportPreview>("POST", `/api/accounts/${acc.id}/import/preview`, { fileName: "x.csv", content: file })).body;
        expect(preview.rows.map((r) => r.categoryId)).toEqual([rent.id, null, null, null]);
        expect(preview.rows.map((r) => r.newCategory)).toEqual([null, "Interne Umbuchung › Kontoumbuchung", "Interne Umbuchung › Kontoumbuchung", "Kfz-Versicherung"]);
        expect(preview.newCategories).toEqual(["Interne Umbuchung › Kontoumbuchung", "Kfz-Versicherung"]);

        // Without the option nothing is created
        const plain = await api<{ importId: number; createdCategories: number }>("POST", `/api/accounts/${acc.id}/import`, { fileName: "x.csv", content: file });
        expect(plain.body.createdCategories).toBe(0);
        expect((await categories()).length).toBe(count);
        await api("DELETE", `/api/imports/${plain.body.importId}`);

        const result = await api<{ imported: number; createdCategories: number }>("POST", `/api/accounts/${acc.id}/import`, { fileName: "x.csv", content: file, createCategories: true });
        expect(result.body).toMatchObject({ imported: 4, createdCategories: 3 });
        const after = await categories();
        expect(after.length).toBe(count + 3);
        const parent = after.find((c) => c.name === "Interne Umbuchung")!;
        const child = after.find((c) => c.name === "Kontoumbuchung")!;
        const kfz = after.find((c) => c.name === "Kfz-Versicherung")!;
        expect(parent.parentId).toBeNull();
        expect(child.parentId).toBe(parent.id);
        expect(kfz.parentId).toBeNull();
        // New categories take arbitrary colours none of their siblings shows
        const taken = after.filter((c) => c.parentId === null && c.id !== parent.id && c.id !== kfz.id).map((c) => c.color);
        for (const c of [parent, kfz]) {
            expect(ROTATING_COLORS).toContain(c.color);
            expect(taken).not.toContain(c.color);
        }
        expect(parent.color).not.toBe(kfz.color);
        expect(ROTATING_COLORS).toContain(child.color);
        const items = (await api<TransactionList>("GET", "/api/transactions?range=all")).body.items;
        const byName = (n: string) => items.filter((x) => x.counterpartyName === n).map((x) => x.categoryId);
        expect(byName("Giro")).toEqual([child.id, child.id]);
        expect(byName("Versicherer")).toEqual([kfz.id]);
        expect(byName("Hausverwaltung")).toEqual([rent.id]);
    });

    it("finds and creates categories along paths of any depth", async () => {
        const { api } = await setUpSignedIn(t);
        const acc = (await api<Account>("POST", "/api/accounts", { name: "Giro" })).body;
        const home = (await api<CategoryList>("GET", "/api/categories")).body.items.find((c) => c.name === "Wohnen")!;
        const costs = (await api<{ id: number }>("POST", "/api/categories", { parentId: home.id, name: "Nebenkosten" })).body;
        const power = (await api<{ id: number }>("POST", "/api/categories", { parentId: costs.id, name: "Strom" })).body;
        const file = [
            "Datum;Kategorie;Name;Betrag",
            "01.10.2026;Alle\\Wohnen\\Nebenkosten\\Strom;Stadtwerke;-60,00",
            "02.10.2026;Wohnen\\Nebenkosten\\Wasser\\Abwasser;Zweckverband;-20,00",
            "03.10.2026;Nebenkosten\\Gas;Gasversorger;-40,00",
            "04.10.2026;Hobby\\Rad\\Ersatzteile;Radladen;-15,00",
        ].join("\n");
        const preview = (await api<ImportPreview>("POST", `/api/accounts/${acc.id}/import/preview`, { fileName: "x.csv", content: file })).body;
        expect(preview.rows[0]!.categoryId).toBe(power.id);
        expect(preview.newCategories).toEqual(["Wohnen › Nebenkosten › Wasser › Abwasser", "Nebenkosten › Gas", "Hobby › Rad › Ersatzteile"]);

        const result = (await api<{ createdCategories: number }>("POST", `/api/accounts/${acc.id}/import`, { fileName: "x.csv", content: file, createCategories: true })).body;
        // Wasser, Abwasser, Gas, Hobby, Rad, Ersatzteile: existing levels are used again
        expect(result.createdCategories).toBe(6);
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const named = (n: string) => cats.find((c) => c.name === n)!;
        expect(named("Wasser").parentId).toBe(costs.id);
        expect(named("Abwasser").parentId).toBe(named("Wasser").id);
        expect(named("Gas").parentId).toBe(costs.id);
        expect(named("Hobby").parentId).toBeNull();
        expect(named("Rad").parentId).toBe(named("Hobby").id);
        expect(named("Ersatzteile").parentId).toBe(named("Rad").id);
    });

    it("shows differing categories of stored bookings and overwrites them only when asked", async () => {
        const { api } = await setUpSignedIn(t);
        const acc = (await api<Account>("POST", "/api/accounts", { name: "Kasse" })).body;
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const rent = cats.find((c) => c.name === "Miete")!;
        const market = cats.find((c) => c.name === "Supermarkt")!;
        const book = async (date: string, amount: number, name: string, categoryId: number | null) =>
            (await api<Transaction>("POST", `/api/accounts/${acc.id}/transactions`, { bookingDate: date, amount, counterpartyName: name, categoryId })).body.id;
        const same = await book("2026-10-01", -95000, "Hausverwaltung", rent.id);
        const other = await book("2026-10-02", -1250, "Bäckerei", rent.id);
        const none = await book("2026-10-03", -2000, "Markt", null);
        const split = await book("2026-10-04", -3000, "Kaufhaus", market.id);
        const missing = await book("2026-10-05", -500, "Giro", null);
        const plain = await book("2026-10-06", -700, "Kiosk", rent.id);
        // Split bookings have no route yet: two shares straight in the database
        const db = t.vault.database;
        db.prepare("UPDATE transaction_categories SET amount = -1000 WHERE transaction_id = ?").run(split);
        db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source) VALUES (?, ?, -2000, 'manual')").run(split, rent.id);
        const file = [
            "Datum;Kategorie;Name;Betrag",
            "01.10.2026;Wohnen\\Miete;Hausverwaltung;-950,00",
            "02.10.2026;Supermarkt;Bäckerei;-12,50",
            "03.10.2026;Supermarkt;Markt;-20,00",
            "04.10.2026;Supermarkt;Kaufhaus;-30,00",
            "05.10.2026;Tierheim;Giro;-5,00",
            "06.10.2026;;Kiosk;-7,00",
            "07.10.2026;Supermarkt;Neu;-1,00",
        ].join("\n");

        const preview = (await api<ImportPreview>("POST", `/api/accounts/${acc.id}/import/preview`, { fileName: "x.csv", content: file })).body;
        expect(preview.counts).toEqual({ new: 1, duplicate: 6, invalid: 0, differs: 3 });
        expect(preview.rows.map((r) => r.categoryState)).toEqual(["same", "differs", "differs", "split", "differs", null, null]);
        expect(preview.rows.map((r) => r.storedCategoryId)).toEqual([rent.id, rent.id, null, null, null, rent.id, null]);
        expect(preview.rows[1]!.categoryId).toBe(market.id);
        expect(preview.rows[4]).toMatchObject({ categoryId: null, newCategory: "Tierheim" });
        expect(preview.newCategories).toEqual(["Tierheim"]);

        const categoryOf = (id: number) => db.prepare("SELECT category_id AS categoryId, source FROM transaction_categories WHERE transaction_id = ? ORDER BY category_id").all(id);
        const before = [same, other, none, split, missing, plain].map(categoryOf);
        // Without the option nothing stored changes
        const first = (await api<{ importId: number; recategorized: number }>("POST", `/api/accounts/${acc.id}/import`, { fileName: "x.csv", content: file })).body;
        expect(first.recategorized).toBe(0);
        expect([same, other, none, split, missing, plain].map(categoryOf)).toEqual(before);
        await api("DELETE", `/api/imports/${first.importId}`);

        // With it, but without creating categories: the missing one stays
        const second = (await api<{ importId: number; recategorized: number; createdCategories: number }>("POST", `/api/accounts/${acc.id}/import`, { fileName: "x.csv", content: file, overwriteCategories: true })).body;
        expect(second).toMatchObject({ recategorized: 2, createdCategories: 0 });
        expect(categoryOf(other)).toEqual([{ categoryId: market.id, source: "manual" }]);
        expect(categoryOf(none)).toEqual([{ categoryId: market.id, source: "manual" }]);
        expect(categoryOf(split)).toEqual(before[3]);
        expect(categoryOf(missing)).toEqual([]);
        expect(categoryOf(plain)).toEqual(before[5]);
        // Undoing the import leaves the changed categories
        await api("DELETE", `/api/imports/${second.importId}`);
        expect(categoryOf(other)).toEqual([{ categoryId: market.id, source: "manual" }]);

        const third = (await api<{ recategorized: number; createdCategories: number }>("POST", `/api/accounts/${acc.id}/import`, {
            fileName: "x.csv",
            content: file,
            overwriteCategories: true,
            createCategories: true,
        })).body;
        expect(third).toMatchObject({ recategorized: 1, createdCategories: 1 });
        const created = (await api<CategoryList>("GET", "/api/categories")).body.items.find((c) => c.name === "Tierheim")!;
        expect(categoryOf(missing)).toEqual([{ categoryId: created.id, source: "manual" }]);
        const log = (await api<ActivityEntry[]>("GET", "/api/activity")).body;
        expect(log.find((e) => e.action === "import")?.details).toBe("x.csv: 1 neu, 6 schon vorhanden, 1 Kategorien angelegt, 1 Kategorien geändert");
    });

    it("counts imported bookings of any date into the balance, starting from the opening balance", async () => {
        const { api } = await setUpSignedIn(t);
        const acc = (await api<Account>("POST", "/api/accounts", { name: "Giro", openingBalance: 100000 })).body;
        // The bookings in the file are older than the account itself
        await api("POST", `/api/accounts/${acc.id}/import`, { fileName: "x.csv", content: CSV });
        const balance = async () => (await api<Account[]>("GET", "/api/accounts")).body.find((a) => a.id === acc.id)!.balance;
        expect(await balance()).toBe(100000 - 95000 - 1250 - 1250);

        const changed = await api<Account>("PATCH", `/api/accounts/${acc.id}`, { openingBalance: 200000 });
        expect(changed.body.balance).toBe(200000 - 95000 - 1250 - 1250);
        expect(await balance()).toBe(changed.body.balance);
    });
});

describe("transaction search", () => {
    it("combines words, fields, amounts and dates", async () => {
        const { api } = await setUpSignedIn(t);
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const market = cats.find((c) => c.name === "Supermarkt")!;
        const parent = cats.find((c) => c.id === market.parentId)!;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const book = (bookingDate: string, amount: number, counterpartyName: string, remittance = "", categoryId: number | null = null) =>
            api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate, amount, counterpartyName, remittance, categoryId });
        await book("2026-01-10", -1299, "REWE Markt", "Teststraße 12", market.id);
        await book("2026-02-15", -5450, "EDEKA", "Einkauf", market.id);
        await book("2026-03-01", 250000, "Arbeitgeber AG", "Gehalt");
        await book("2025-12-24", -9900, "PayPal", "Geschenk");

        const search = async (q: string) => {
            const r = await api<TransactionList>("GET", `/api/transactions?range=all&q=${encodeURIComponent(q)}`);
            expect(r.status, q).toBe(200);
            return r.body;
        };
        const names = async (q: string) => (await search(q)).items.map((x) => x.counterpartyName).sort();

        expect(await names("rewe ODER edeka")).toEqual(["EDEKA", "REWE Markt"]);
        expect(await names("(rewe ODER edeka) >20")).toEqual(["EDEKA"]);
        expect(await names("test*strasse")).toEqual(["REWE Markt"]);
        expect(await names(`kategorie:"${parent.name}"`)).toEqual(["EDEKA", "REWE Markt"]);
        expect(await names("kat:-")).toEqual(["Arbeitgeber AG", "PayPal"]);
        expect(await names("NICHT kat:-")).toEqual(["EDEKA", "REWE Markt"]);
        expect(await names("<-50")).toEqual(["EDEKA", "PayPal"]);
        expect(await names(">50")).toEqual(["Arbeitgeber AG", "EDEKA", "PayPal"]);
        expect(await names("datum:2026-02")).toEqual(["EDEKA"]);
        expect(await names("datum<2026")).toEqual(["PayPal"]);
        expect(await names("datum>=2026-01 datum<=2026-02 -edeka")).toEqual(["REWE Markt"]);
        const sum = await search("rewe ODER edeka");
        expect(sum).toMatchObject({ count: 2, total: -6749 });

        const bad = await api<{ message: string }>("GET", `/api/transactions?range=all&q=${encodeURIComponent("(rewe")}`);
        expect(bad.status).toBe(400);
        expect(JSON.stringify(bad.body)).toContain("Schließende Klammer fehlt");
    });

    it("searches by account and group, and by dates relative to today", async () => {
        const { api } = await setUpSignedIn(t);
        const groups = await api<AccountGroup[]>("GET", "/api/account-groups");
        const daily = groups.body.find((g) => g.name === "Alltag")!;
        const giro = (await api<Account>("POST", "/api/accounts", { name: "Girokonto", groupId: daily.id })).body;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        const today = new Date();
        const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const daysAgo = (n: number) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
        await api("POST", `/api/accounts/${giro.id}/transactions`, { bookingDate: daysAgo(3), amount: -1000, counterpartyName: "Kino" });
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: daysAgo(400), amount: -500, counterpartyName: "Kiosk" });
        const names = async (q: string) =>
            (await api<TransactionList>("GET", `/api/transactions?range=all&q=${encodeURIComponent(q)}`)).body.items.map((x) => x.counterpartyName).sort();
        expect(await names("konto:giro")).toEqual(["Kino"]);
        expect(await names("konto:alltag")).toEqual(["Kino"]);
        expect(await names("NICHT konto:alltag")).toEqual(["Kiosk"]);
        expect(await names("giro")).toEqual([]);
        expect(await names("datum:-30t")).toEqual(["Kino"]);
        expect(await names("datum<-1j")).toEqual(["Kiosk"]);
        expect(await names("datum:heute")).toEqual([]);
    });

    it("draws the daily balance over a span of days", async () => {
        const { api } = await setUpSignedIn(t);
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld", openingBalance: 10000 })).body;
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: "2026-03-10", amount: -2500, counterpartyName: "A" });
        type Series = { points: { date: string; balance: number }[] };
        const march = (await api<Series>("GET", `/api/stats/series?scope=account:${cash.id}&from=2026-03-01&to=2026-03-31`)).body.points;
        expect(march).toHaveLength(31);
        expect(march[0]).toEqual({ date: "2026-03-01", balance: 10000 });
        expect(march.at(-1)).toEqual({ date: "2026-03-31", balance: 7500 });
        // An open start begins at the first booking
        const open = (await api<Series>("GET", `/api/stats/series?scope=account:${cash.id}&to=2026-03-12`)).body.points;
        expect(open.map((p) => p.date)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
        // At most 730 days
        const long = (await api<Series>("GET", `/api/stats/series?scope=account:${cash.id}&from=2020-01-01&to=2026-03-31`)).body.points;
        expect(long).toHaveLength(730);
        expect((await api<Series>("GET", `/api/stats/series?scope=account:${cash.id}&from=2026-04-01&to=2026-03-31`)).body.points).toEqual([]);
    });
});

describe("figures", () => {
    it("computes the daily balance backwards from today", async () => {
        const { api } = await setUpSignedIn(t);
        const today = new Date();
        const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld", openingBalance: 10000 })).body;
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: iso(yesterday), amount: -2500, counterpartyName: "A" });
        const s = await api<{ points: { date: string; balance: number }[] }>("GET", `/api/stats/series?scope=account:${cash.id}&days=7`);
        expect(s.body.points).toHaveLength(7);
        expect(s.body.points.at(-1)).toEqual({ date: iso(today), balance: 7500 });
        expect(s.body.points.at(-3)!.balance).toBe(10000);
    });

    it("limits the daily balance to a range", async () => {
        const { api } = await setUpSignedIn(t);
        const today = new Date();
        const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const day = (y: number, m: number, d: number) => iso(new Date(today.getFullYear() + y, today.getMonth() + m, d));
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld", openingBalance: 10000 })).body;
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: day(0, -1, 10), amount: -2500, counterpartyName: "A" });
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: day(0, 0, 1), amount: -1000, counterpartyName: "B" });
        await api("POST", `/api/accounts/${cash.id}/transactions`, { bookingDate: day(-1, 0, 1), amount: 500, counterpartyName: "C" });
        type Series = { points: { date: string; balance: number }[] };

        const last = (await api<Series>("GET", `/api/stats/series?scope=account:${cash.id}&range=last`)).body.points;
        expect(last[0]!.date).toBe(day(0, -1, 1));
        expect(last.at(-1)!.date).toBe(day(0, 0, 0));
        expect(last.at(-1)!.balance).toBe(10000 + 500 - 2500);

        const month = (await api<Series>("GET", `/api/stats/series?scope=account:${cash.id}&range=month`)).body.points;
        expect(month[0]).toEqual({ date: day(0, 0, 1), balance: 7000 });
        expect(month.at(-1)!.date).toBe(iso(today));

        const all = (await api<Series>("GET", `/api/stats/series?scope=account:${cash.id}&range=all`)).body.points;
        expect(all[0]).toEqual({ date: day(-1, 0, 1), balance: 10500 });
        expect(all.at(-1)).toEqual({ date: iso(today), balance: 7000 });
    });
});

describe("profile defaults from the configuration", () => {
    it("start each device class with its configured values and style the sign-in screen", async () => {
        await t.close();
        t = await createTestApp({
            profileDefaults: { web: { theme: "light", hideAmountsOnStart: true }, macos: { theme: "system", hideAmountsOnStart: false } },
        });
        expect((await t.app.inject({ url: "/api/status" })).json()).toMatchObject({ webTheme: "light" });
        const { api } = await setUpSignedIn(t);
        const web = await api<{ settings: Record<string, unknown> }>("GET", "/api/profile?client=web");
        const mac = await api<Record<string, unknown>>("GET", "/api/profile/settings?client=macos");
        expect(web.body.settings).toMatchObject({ theme: "light", hideAmountsOnStart: true });
        expect(mac.body).toMatchObject({ theme: "system", hideAmountsOnStart: false });
        await api("PUT", "/api/profile/settings/theme?client=web", { value: "dark" });
        expect((await api<{ settings: Record<string, unknown> }>("GET", "/api/profile?client=web")).body.settings.theme).toBe("dark");
    });
});

describe("races, limits and headers", () => {
    // Lets queued vault work start: it is then deriving a key when the test goes on
    const started = () => new Promise<void>((resolve) => queueMicrotask(resolve));

    it("locks only after a password write under way, and its follow-up steps still find the database open", async () => {
        const { session } = await setUpSignedIn(t);
        const next = "ein-ganz-neues-passwort";
        let followUp = false;
        const write = t.vault.setUserPassword(next, {
            user: (db) => requireUser(db, 1),
            then: (db) => {
                db.prepare("SELECT 1").get();
                followUp = true;
            },
        });
        await started();
        t.vault.lock();
        // The data key must not be wiped while it is being wrapped for the new password
        expect(t.vault.state()).toBe("ready");
        await write;
        expect(followUp).toBe(true);
        expect(t.vault.state()).toBe("locked");
        const back = await post("/api/auth/login", { name: "Anna", password: next }, session);
        expect(back.json()).toMatchObject({ status: "ok" });
        expect((await t.app.inject({ url: "/api/accounts", headers: { cookie: session } })).statusCode).toBe(200);
    });

    it("keeps the recovery key intact when the server locks while a new one is made", async () => {
        await setUpSignedIn(t);
        const making = t.vault.replaceRecoveryKey();
        await started();
        t.vault.lock();
        const recoveryKey = await making;
        expect(t.vault.state()).toBe("locked");
        expect((await post("/api/recover", { recoveryKey, name: "Anna", password: "ein-ganz-neues-passwort" })).statusCode).toBe(200);
    });

    it("lets sign-ins sent at the same time guess no more often than the limit allows", async () => {
        await setUpSignedIn(t);
        const tries = await Promise.all(Array.from({ length: 20 }, () => post("/api/auth/login", { name: "Anna", password: "falsch-falsch-falsch" })));
        const codes = tries.map((r) => r.statusCode);
        expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
        expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(15);
        expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
    });

    it("trusts no X-Forwarded-For by default, so a new address does not reset the throttling", async () => {
        await setUpSignedIn(t);
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) {
            const res = await t.app.inject({
                method: "POST",
                url: "/api/auth/login",
                payload: { name: "Anna", password: "falsch-falsch-falsch" },
                headers: { "x-forwarded-for": `203.0.113.${i}` },
            });
            codes.push(res.statusCode);
        }
        expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it("reads trustProxy from the environment: off, on or a list of addresses", () => {
        const cwd = path.join(t.dataDir, "nowhere");
        expect(loadConfig({}, cwd).trustProxy).toBe(false);
        expect(loadConfig({ MBM_TRUST_PROXY: "true" }, cwd).trustProxy).toBe(true);
        expect(loadConfig({ MBM_TRUST_PROXY: "false" }, cwd).trustProxy).toBe(false);
        expect(loadConfig({ MBM_TRUST_PROXY: "127.0.0.1,172.16.0.0/12" }, cwd).trustProxy).toBe("127.0.0.1,172.16.0.0/12");
    });

    it("does not let a user remove themselves", async () => {
        const { api, secret } = await setUpSignedIn(t);
        await api("POST", "/api/users", { name: "Ben", password: "noch-ein-passwort", code: confirmCode(t, secret) });
        const me = await api<{ id: number }>("GET", "/api/auth/me");
        const res = await api<{ error: string }>("DELETE", `/api/users/${me.body.id}`, { code: confirmCode(t, secret) });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("self");
        expect((await api<{ name: string }[]>("GET", "/api/users")).body.map((u) => u.name)).toEqual(["Anna", "Ben"]);
    });

    it("keeps the category share of an imported booking when its counter booking changes", async () => {
        const { api } = await setUpSignedIn(t);
        const giro = (await api<Account>("POST", "/api/accounts", { name: "Girokonto" })).body;
        const cash = (await api<Account>("POST", "/api/accounts", { name: "Bargeld" })).body;
        await api("POST", `/api/accounts/${giro.id}/import`, { fileName: "a.csv", content: "Datum;Betrag;Name\n01.02.2026;-50,00;Geldautomat\n" });
        const withdrawal = (await api<TransactionList>("GET", `/api/transactions?scope=account:${giro.id}&range=all`)).body.items[0]!;
        const counter = (await api<Transaction>("POST", `/api/transactions/${withdrawal.id}/counter`, { accountId: cash.id })).body;
        expect((await api("PATCH", `/api/transactions/${counter.id}`, { amount: 3000 })).status).toBe(200);
        const shares = t.vault.database.prepare("SELECT amount FROM transaction_categories WHERE transaction_id = ?").all(withdrawal.id) as { amount: number }[];
        expect(shares).toEqual([{ amount: -5000 }]);
    });

    it("refreshes figures and lists when a category moves", async () => {
        const { api } = await setUpSignedIn(t);
        const cats = (await api<CategoryList>("GET", "/api/categories")).body.items;
        const moved = cats.find((c) => c.name === "Supermarkt")!;
        const target = cats.find((c) => c.name === "Wohnen")!;
        const changed = vi.spyOn(t.ctx.events, "changed");
        expect((await api("POST", "/api/categories/move", { id: moved.id, parentId: target.id, index: 0 })).status).toBe(200);
        expect(changed).toHaveBeenCalledWith("categories", "transactions");
    });

    it("forbids the browser to cache API answers", async () => {
        const { api, session } = await setUpSignedIn(t);
        await api("POST", "/api/accounts", { name: "Bargeld" });
        const res = await t.app.inject({ url: "/api/accounts", headers: { cookie: session } });
        expect(res.headers["cache-control"]).toBe("no-store");
        expect((await t.app.inject({ url: "/api/status" })).headers["cache-control"]).toBe("no-store");
    });
});
