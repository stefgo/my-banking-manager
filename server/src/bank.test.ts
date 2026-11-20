import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmCode, createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { startFakeConnector, type FakeConnector } from "./testing/fakeConnector.js";
import { hashToken } from "./crypto/secrets.js";
import { userKeyOfSession } from "./services/userkey.js";
import { readCredentials, type LoginRow } from "./services/bankaccess.js";

let t: TestApp;
let fc: FakeConnector;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];
let session: string;
let secret: string;

const BLZ = "70054306";
const URL_ = "https://banking.example.invalid/fints30";
const PIN = "geheim123";
const challenge = { decoupled: true, text: "Bitte in der App freigeben.", medium: "Telefon", validUntil: "", methodName: "pushTAN" };
const giro = {
    accountNumber: "1234567", subAccount: "", iban: "DE02700543060001234567", bic: "BYLADEM1WOR", externalId: "DE02700543060001234567",
    name: "Girokonto", owner: "Anna", currency: "EUR", kind: "giro",
    capabilities: { balance: true, transactions: true, cardTransactions: false, transfer: true, instantTransfer: true, standingOrders: false, scheduledTransfers: false },
};
const depot = { ...giro, accountNumber: "999", iban: null, externalId: "999", name: "Depot", kind: "depot" };

beforeEach(async () => {
    fc = await startFakeConnector();
    t = await createTestApp({ connectors: { fints: { socket: fc.socket } } });
    ({ api, session, secret } = await setUpSignedIn(t));
    fc.on("checkBank", () => ({ bankName: "Sparkasse Bad Tölz-Wolfratshausen", bpdVersion: 12, pinTan: true, jobs: ["HKSAL"] }));
    fc.on("tanMethods", () => ({ status: "done", data: { methods: [{ id: "923", name: "pushTAN 2.0", decoupled: true, needsMedium: true }] }, state: "STATE-1" }));
});

afterEach(async () => {
    await t.close();
    await fc.close();
});

async function connectionWithLogin(): Promise<number> {
    const created = await api<{ id: number }>("POST", "/api/bank-connections", { blz: BLZ, fintsUrl: URL_ });
    expect(created.status).toBe(200);
    const login = await api("PUT", `/api/bank-connections/${created.body.id}/login`, { loginName: "anna1234567", pin: PIN });
    expect(login.status).toBe(200);
    await api("PUT", `/api/bank-connections/${created.body.id}/login/tan-method`, { tanMethod: "923", tanMedium: "Telefon" });
    return created.body.id;
}

describe("bank directory and connections", () => {
    it("searches the directory by bank code and name", async () => {
        const byBlz = await api<{ blz: string; name: string; bic: string }[]>("GET", "/api/banks?q=7005430");
        expect(byBlz.body.find((b) => b.blz === BLZ)).toMatchObject({ name: "Sparkasse Bad Tölz-Wolfratshausen", bic: "BYLADEM1WOR" });
        const byName = await api<{ blz: string }[]>("GET", "/api/banks?q=Bad Tölz");
        expect(byName.body.some((b) => b.blz === BLZ)).toBe(true);
    });

    it("checks the bank and returns the existing connection for the same address", async () => {
        const a = await api<{ id: number; name: string; bic: string; myLogin: unknown }>("POST", "/api/bank-connections", { blz: BLZ, fintsUrl: URL_ });
        expect(a.body).toMatchObject({ name: "Sparkasse Bad Tölz-Wolfratshausen", bic: "BYLADEM1WOR", myLogin: null });
        const b = await api<{ id: number }>("POST", "/api/bank-connections", { blz: BLZ, fintsUrl: URL_ });
        expect(b.body.id).toBe(a.body.id);
        expect(fc.received.filter((r) => r.route === "checkBank")[0]?.body).toEqual({ bank: { blz: BLZ, url: URL_ } });
    });

    it("reports an unreachable connector", async () => {
        await fc.close();
        const res = await api<{ error: string }>("POST", "/api/bank-connections", { blz: BLZ, fintsUrl: URL_ });
        expect(res).toMatchObject({ status: 503, body: { error: "connector_unavailable" } });
        fc = await startFakeConnector(); // for afterEach
    });
});

describe("own login", () => {
    it("seals the credentials and keeps the connector state", async () => {
        const id = await connectionWithLogin();
        const row = t.vault.database.prepare("SELECT * FROM bank_logins").get() as Record<string, string>;
        expect(row.sealed_credentials).not.toContain(PIN);
        expect(row.sealed_connector_state).not.toContain("STATE-1");
        expect(row.login_hint).toBe("••••4567");
        const sent = fc.received.find((r) => r.route === "tanMethods")!.body;
        expect(sent.login).toEqual({ userId: "anna1234567", pin: PIN });

        fc.on("accounts", (body) => {
            expect(body.login).toMatchObject({ pin: PIN, state: "STATE-1", tanMethod: "923", tanMedium: "Telefon" });
            return { status: "done", data: { accounts: [giro] }, state: "STATE-2" };
        });
        const res = await api<{ status: string }>("POST", `/api/bank-connections/${id}/login/accounts`);
        expect(res.body.status).toBe("done");
        const list = await api<{ myLogin: { tanMethod: { name: string }; status: string } }[]>("GET", "/api/bank-connections");
        expect(list.body[0]?.myLogin).toMatchObject({ tanMethod: { id: "923", name: "pushTAN 2.0" }, status: "setup" });
    });

    it("never stores a PIN that should not be stored, not even sealed", async () => {
        const created = await api<{ id: number }>("POST", "/api/bank-connections", { blz: BLZ, fintsUrl: URL_ });
        const id = created.body.id;
        const set = await api<{ login: { savePin: boolean } }>("PUT", `/api/bank-connections/${id}/login`, { loginName: "anna1234567", pin: PIN, savePin: false });
        expect(set.body.login.savePin).toBe(false);
        expect(fc.received.find((r) => r.route === "tanMethods")!.body.login.pin).toBe(PIN);
        await api("PUT", `/api/bank-connections/${id}/login/tan-method`, { tanMethod: "923" });

        // Without the PIN in the request the server cannot talk to the bank
        const missing = await api<{ error: string }>("POST", `/api/bank-connections/${id}/login/accounts`);
        expect(missing).toMatchObject({ status: 409, body: { error: "pin_required" } });
        fc.on("accounts", (body) => ({ status: "done", data: { accounts: body.login.pin === PIN ? [giro] : [] }, state: "S" }));
        const withPin = await api<{ data: { accounts: unknown[] } }>("POST", `/api/bank-connections/${id}/login/accounts`, { pin: PIN });
        expect(withPin.body.data.accounts).toHaveLength(1);
        await api("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: giro.externalId }] });

        // No row of any table holds the PIN in clear text …
        const db = t.vault.database;
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
        for (const table of tables) expect(JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())).not.toContain(PIN);
        // … and the sealed credentials, opened with the user key, hold none either
        const token = session.split("=")[1]!;
        const device = db.prepare("SELECT id FROM devices WHERE token_hash = ?").get(hashToken(token)) as { id: number };
        const key = userKeyOfSession(db, device.id, token)!;
        const row = db.prepare("SELECT * FROM bank_logins").get() as LoginRow;
        expect(readCredentials(row, key)).toEqual({ loginName: "anna1234567", pin: null });
    });

    it("needs a new sign-in for sessions without user key", async () => {
        const created = await api<{ id: number }>("POST", "/api/bank-connections", { blz: BLZ, fintsUrl: URL_ });
        t.vault.database.prepare("UPDATE devices SET sealed_user_key = NULL").run();
        const res = await api<{ error: string }>("PUT", `/api/bank-connections/${created.body.id}/login`, { loginName: "anna", pin: PIN });
        expect(res).toMatchObject({ status: 403, body: { error: "relogin_required" } });
    });

    it("marks a wrong PIN", async () => {
        const created = await api<{ id: number }>("POST", "/api/bank-connections", { blz: BLZ, fintsUrl: URL_ });
        fc.on("tanMethods", () => ({ status: 422, json: { error: "pin_wrong", message: "PIN", bankCodes: [{ code: "9942", text: "PIN ungültig." }] } }));
        const res = await api<{ error: string; message: string }>("PUT", `/api/bank-connections/${created.body.id}/login`, { loginName: "anna", pin: "falsch" });
        expect(res.status).toBe(422);
        expect(res.body.message).toContain("9942 PIN ungültig.");
        const list = await api<{ myLogin: { status: string } }[]>("GET", "/api/bank-connections");
        expect(list.body[0]?.myLogin.status).toBe("pin_wrong");
    });
});

describe("taking over accounts", () => {
    it("follows an approval and takes over supported accounts", async () => {
        const id = await connectionWithLogin();
        const opId = "11111111-1111-4111-8111-111111111111";
        fc.on("accounts", () => ({ status: "approval", operationId: opId, challenge }));
        let polls = 0;
        fc.on("operation", (_b, oid) => {
            expect(oid).toBe(opId);
            return ++polls < 2 ? { status: "approval", operationId: opId, challenge } : { status: "done", data: { accounts: [giro, depot] }, state: "STATE-3" };
        });
        const first = await api<{ status: string; operationId: string; challenge: { text: string } }>("POST", `/api/bank-connections/${id}/login/accounts`);
        expect(first.body).toMatchObject({ status: "approval", operationId: opId, challenge: { text: "Bitte in der App freigeben." } });
        expect((await api<{ status: string }>("GET", `/api/bank-operations/${opId}`)).body.status).toBe("approval");
        const done = await api<{ status: string; data: { accounts: { externalId: string; supported: boolean; accountId: null }[] } }>("GET", `/api/bank-operations/${opId}`);
        expect(done.body.data.accounts.map((a) => [a.externalId, a.supported, a.accountId])).toEqual([
            [giro.externalId, true, null],
            ["999", false, null],
        ]);
        expect((await api("GET", `/api/bank-operations/${opId}`)).status).toBe(404);

        const imported = await api<{ created: number[] }>("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: giro.externalId, name: "Giro Anna" }] });
        expect(imported.body.created).toHaveLength(1);
        const accounts = await api<{ id: number; kind: string; name: string; iban: string; connectionId: number; icon: string }[]>("GET", "/api/accounts");
        expect(accounts.body.find((a) => a.id === imported.body.created[0])).toMatchObject({ kind: "giro", name: "Giro Anna", iban: giro.iban, connectionId: id, icon: "landmark" });
        expect((await api("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: "999" }] })).status).toBe(422);
        const again = await api<{ created: number[]; linked: number[] }>("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: giro.externalId }] });
        expect(again.body).toEqual({ created: [], linked: imported.body.created });
        const list = await api<{ myLogin: { status: string }; accountCount: number }[]>("GET", "/api/bank-connections");
        expect(list.body[0]).toMatchObject({ myLogin: { status: "ready" }, accountCount: 1 });
    });

    it("takes over a loan account", async () => {
        const id = await connectionWithLogin();
        const loan = { ...giro, accountNumber: "6001234", iban: "DE02700543060006001234", externalId: "DE02700543060006001234", name: "Darlehen", kind: "loan", capabilities: { ...giro.capabilities, transfer: false, instantTransfer: false } };
        fc.on("accounts", () => ({ status: "done", data: { accounts: [giro, loan, depot] }, state: "S" }));
        const offered = await api<{ data: { accounts: { externalId: string; supported: boolean }[] } }>("POST", `/api/bank-connections/${id}/login/accounts`);
        expect(offered.body.data.accounts.map((a) => a.supported)).toEqual([true, true, false]);
        const { body } = await api<{ created: number[] }>("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: loan.externalId }] });
        const accounts = (await api<{ id: number; kind: string; name: string; icon: string }[]>("GET", "/api/accounts")).body;
        expect(accounts.find((a) => a.id === body.created[0])).toMatchObject({ kind: "loan", name: "Darlehen", icon: "percent" });
    });

    it("detaches one account, ignores it from then on and takes it over again on request", async () => {
        const id = await connectionWithLogin();
        const savings = { ...giro, accountNumber: "7654321", iban: "DE02700543060007654321", externalId: "DE02700543060007654321", name: "Tagesgeld", kind: "savings" };
        const other = { ...giro, accountNumber: "5555555", iban: "DE02700543060005555555", externalId: "DE02700543060005555555", name: "Zweitkonto" };
        fc.on("accounts", () => ({ status: "done", data: { accounts: [giro, savings, other] }, state: "S" }));
        expect((await api("GET", `/api/bank-connections/${id}/login/accounts`)).body).toBeNull();
        await api("POST", `/api/bank-connections/${id}/login/accounts`);
        const { body } = await api<{ created: number[] }>("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: giro.externalId }, { externalId: savings.externalId }], ignore: [other.externalId, giro.externalId] });
        const [giroId, savingsId] = body.created as [number, number];
        expect((await api("POST", `/api/bank-connections/${id}/accounts`, { accounts: [], ignore: ["nope"] })).status).toBe(404);

        expect((await api("POST", `/api/accounts/${giroId}/detach`, { mode: "keep" })).status).toBe(200);
        expect((await api("POST", `/api/accounts/${savingsId}/detach`, { mode: "delete" })).status).toBe(200);
        const accounts = (await api<{ id: number; kind: string; connectionId: number | null }[]>("GET", "/api/accounts")).body;
        expect(accounts.find((a) => a.id === giroId)).toMatchObject({ kind: "offline", connectionId: null });
        expect(accounts.some((a) => a.id === savingsId)).toBe(false);
        expect((await api<{ error: string }>("POST", `/api/accounts/${giroId}/detach`, { mode: "keep" })).body.error).toBe("not_bank_account");
        expect((await api<{ accountCount: number }[]>("GET", "/api/bank-connections")).body[0]?.accountCount).toBe(0);

        type Offered = { externalId: string; accountId: number | null; ignored: boolean };
        const offered = await api<{ data: { accounts: Offered[] } }>("POST", `/api/bank-connections/${id}/login/accounts`);
        expect(offered.body.data.accounts.map((a) => [a.externalId, a.accountId, a.ignored])).toEqual([
            [giro.externalId, null, true],
            [savings.externalId, null, true],
            [other.externalId, null, true],
        ]);
        const again = await api<{ created: number[] }>("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: other.externalId }] });
        expect(again.body.created).toHaveLength(1);
        // The last list with the current state, without asking the bank again
        const asked = fc.received.filter((r) => r.route === "accounts").length;
        const last = await api<{ fetchedAt: string; accounts: (Offered & { linked: boolean })[] }>("GET", `/api/bank-connections/${id}/login/accounts`);
        expect(last.body.accounts.map((a) => [a.externalId, a.accountId, a.linked, a.ignored])).toEqual([
            [giro.externalId, null, false, true],
            [savings.externalId, null, false, true],
            [other.externalId, again.body.created[0], true, false],
        ]);
        expect(last.body.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(fc.received.filter((r) => r.route === "accounts")).toHaveLength(asked);
    });

    it("keeps accounts as offline accounts when the access goes", async () => {
        const id = await connectionWithLogin();
        fc.on("accounts", () => ({ status: "done", data: { accounts: [giro] }, state: "S" }));
        await api("POST", `/api/bank-connections/${id}/login/accounts`);
        const { body } = await api<{ created: number[] }>("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: giro.externalId }] });
        expect((await api("DELETE", `/api/bank-connections/${id}?accounts=keep`)).status).toBe(200);
        const accounts = await api<{ id: number; kind: string; connectionId: null }[]>("GET", "/api/accounts");
        expect(accounts.body.find((a) => a.id === body.created[0])).toMatchObject({ kind: "offline", connectionId: null });
        expect((await api<unknown[]>("GET", "/api/bank-connections")).body).toEqual([]);
    });
});

describe("user key", () => {
    it("survives a password change and is lost when another user sets the password", async () => {
        const id = await connectionWithLogin();
        expect((await api("POST", "/api/auth/password", { current: "sehr-geheimes-passwort", next: "ein-neues-langes-passwort" })).status).toBe(200);
        fc.on("accounts", (body) => ({ status: "done", data: { accounts: body.login.pin === PIN ? [giro] : [] }, state: "S" }));
        const res = await api<{ data: { accounts: unknown[] } }>("POST", `/api/bank-connections/${id}/login/accounts`);
        expect(res.body.data.accounts).toHaveLength(1);

        // A second user sets Anna's password: Anna's bank login needs the PIN again
        const db = t.vault.database;
        const anna = (db.prepare("SELECT id FROM users WHERE name = 'Anna'").get() as { id: number }).id;
        expect((await api("POST", "/api/users", { name: "Bernd", password: "bernds-langes-passwort", code: confirmCode(t, secret) })).status).toBe(200);
        expect((await api("POST", `/api/users/${anna}/password`, { password: "annas-neues-passwort-1", code: confirmCode(t, secret) })).status).toBe(200);
        const row = db.prepare("SELECT status, sealed_credentials FROM bank_logins").get() as { status: string; sealed_credentials: string | null };
        expect(row).toEqual({ status: "credentials_lost", sealed_credentials: null });
        expect((db.prepare("SELECT sealed_user_key FROM users WHERE id = ?").get(anna) as { sealed_user_key: string | null }).sealed_user_key).toBeNull();
    });
});
