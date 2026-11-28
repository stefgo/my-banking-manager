import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { connectorRoutes, type ConnectorRoutes } from "@mbm/shared";
import { fakeEnableBanking, paypalAccount, PAYPAL, secondPaypalAccount, type FakeEnableBanking } from "../testing/index.js";
import { buildApi } from "./server.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = randomUUID();
const credentials = { applicationId: APP_ID, privateKey: PEM };
const bank = { aspsp: "PayPal", country: "DE" };
const NOW = Date.parse("2026-11-26T10:00:00Z");

let eb: FakeEnableBanking;
let api: ReturnType<typeof buildApi>["app"];

async function call<K extends keyof ConnectorRoutes>(name: K, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const def = connectorRoutes[name];
    const res = await api.inject({ method: def.method, url: def.path, ...(body === undefined ? {} : { payload: body as object }) });
    const json = res.json() as Record<string, unknown>;
    if (res.statusCode === 200) {
        const check = def.response.safeParse(json);
        if (!check.success) throw new Error(`Answer of ${name} breaks the contract: ${check.error.message}`);
    }
    return { status: res.statusCode, json };
}

/**
 * Approval and session as the server runs them; answers with the state for later calls. `only`: the
 * accounts approved at the bank, `state`: the approvals so far, which the new one joins.
 */
async function approve(only?: number[], state?: string): Promise<string> {
    await call("psd2Consent", { bank, login: credentials, redirectUrl: "https://localhost/bank-callback", state: "s".repeat(32) });
    const { code } = eb.approve(only);
    const res = await call("psd2Session", { bank, login: { ...credentials, ...(state ? { state } : {}) }, code });
    return res.json.state as string;
}

type StateJson = { v: number; psuHeaders: string[]; sessions: { sessionId: string; validUntil: string; ended?: string; accounts: { externalId: string; uid: string | null }[] }[] };
const sessionsOf = (state: string) => (JSON.parse(state) as StateJson).sessions;

beforeEach(() => {
    eb = fakeEnableBanking({ applicationId: APP_ID, publicKey, now: () => NOW, aspsps: [PAYPAL, { name: "Testbank", country: "DE", beta: true, maximum_consent_validity: 7_776_000, psu_types: ["personal"], required_psu_headers: ["Psu-Ip-Address"] }] });
    api = buildApi({ version: "test", client: { fetch: eb.fetch }, now: () => NOW }).app;
});

describe("info", () => {
    it("names the connector and its PSD2 routes", async () => {
        expect((await call("info", undefined)).json).toEqual({ name: "enablebanking", version: "test", productConfigured: true, capabilities: ["accounts", "balances", "transactions", "psd2"] });
    });
});

describe("psd2Banks", () => {
    it("lists the banks of a country without their logos", async () => {
        const res = await call("psd2Banks", { credentials, country: "DE" });
        expect(res.status).toBe(200);
        expect(res.json.banks).toEqual([
            { name: "PayPal", country: "DE", beta: false, maxConsentDays: 180, psuTypes: ["personal", "business"] },
            { name: "Testbank", country: "DE", beta: true, maxConsentDays: 90, psuTypes: ["personal"] },
        ]);
        expect(JSON.stringify(res.json)).not.toContain("logo");
        expect(eb.calls[0]!.query).toEqual({ country: "DE", service: "AIS" });
    });

    it("reports a refused application as wrong credentials", async () => {
        const res = await call("psd2Banks", { credentials: { ...credentials, applicationId: randomUUID() }, country: "DE" });
        expect(res.status).toBe(422);
        expect(res.json).toMatchObject({ error: "pin_wrong" });
    });

    it("refuses a key that is no RSA key in PEM form", async () => {
        const res = await call("psd2Banks", { credentials: { ...credentials, privateKey: "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(200) + "\n-----END PRIVATE KEY-----" }, country: "DE" });
        expect(res.status).toBe(422);
        expect(res.json).toMatchObject({ error: "pin_wrong", message: expect.stringContaining("PEM") });
        expect(eb.calls).toHaveLength(0);
    });
});

describe("approval", () => {
    it("asks for the longest approval the bank gives, in German, for a person", async () => {
        const res = await call("psd2Consent", { bank, login: credentials, redirectUrl: "https://localhost/bank-callback", state: "s".repeat(32) });
        expect(res.status).toBe(200);
        expect(res.json.url).toMatch(/^https:\/\//);
        const body = eb.lastAuthBody()!;
        expect(body).toMatchObject({ aspsp: { name: "PayPal", country: "DE" }, state: "s".repeat(32), redirect_url: "https://localhost/bank-callback", psu_type: "personal", language: "de" });
        const days = (Date.parse((body.access as { valid_until: string }).valid_until) - NOW) / 86_400_000;
        expect(days).toBeGreaterThan(179.9);
        expect(days).toBeLessThan(180);
    });

    it("says so when the redirect is not registered in the application", async () => {
        const res = await call("psd2Consent", { bank, login: credentials, redirectUrl: "https://mbm.example.org/bank-callback", state: "s".repeat(32) });
        expect(res.status).toBe(422);
        expect(res.json).toMatchObject({ error: "bank_error", message: expect.stringContaining("Rückleitungsadresse"), bankCodes: [{ code: "REDIRECT_URI_NOT_ALLOWED" }] });
    });

    it("refuses a bank Enable Banking does not offer", async () => {
        const res = await call("psd2Consent", { bank: { aspsp: "Nobank", country: "DE" }, login: credentials, redirectUrl: "https://localhost/bank-callback", state: "s".repeat(32) });
        expect(res.status).toBe(422);
        expect(res.json).toMatchObject({ error: "not_supported" });
    });

    it("turns the code into a session whose state holds the accounts", async () => {
        await call("psd2Consent", { bank, login: credentials, redirectUrl: "https://localhost/bank-callback", state: "s".repeat(32) });
        const res = await call("psd2Session", { bank, login: credentials, code: eb.approve().code });
        expect(res.status).toBe(200);
        expect(Date.parse(res.json.validUntil as string)).toBeGreaterThan(NOW);
        const state = JSON.parse(res.json.state as string) as StateJson;
        expect(state.v).toBe(2);
        expect(state.psuHeaders).toEqual([]);
        expect(state.sessions).toHaveLength(1);
        expect(state.sessions[0]!.accounts).toHaveLength(1);
        expect(state.sessions[0]!.accounts[0]).toMatchObject({ externalId: "PAYPALACCOUNT00000000000001", uid: expect.any(String) });
        expect(res.json.accounts).toEqual([expect.objectContaining({ externalId: "PAYPALACCOUNT00000000000001", name: "PayPal", consentUntil: res.json.validUntil })]);
        // The key never ends up in the state.
        expect(res.json.state).not.toContain("PRIVATE KEY");
    });

    it("refuses a code twice", async () => {
        await approve();
        const res = await call("psd2Session", { bank, login: credentials, code: eb.approve().code });
        expect(res.status).toBe(422);
        expect(res.json).toMatchObject({ error: "bank_error", bankCodes: [{ code: "WRONG_AUTHORIZATION_CODE" }] });
    });
});

describe("fetching", () => {
    it("reports the accounts of the approval", async () => {
        const state = await approve();
        const res = await call("psd2Accounts", { bank, login: { ...credentials, state } });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            status: "done",
            data: { accounts: [{ externalId: "PAYPALACCOUNT00000000000001", name: "PayPal", kind: "giro", currency: "EUR", icon: "wallet", capabilities: { balance: true, transactions: true, transfer: false } }] },
        });
    });

    it("fetches balance and bookings of the account", async () => {
        const state = await approve();
        const account = { accountNumber: "PAYPALACCOUNT00000000000001", subAccount: "", iban: null, bic: null };
        const balances = await call("psd2Balances", { bank, login: { ...credentials, state }, accounts: [account] });
        expect(balances.json).toMatchObject({ status: "done", data: { balances: [{ booked: 12345, currency: "EUR", date: "2026-11-26" }] } });

        const txs = await call("psd2Transactions", { bank, login: { ...credentials, state }, account });
        expect(txs.status).toBe(200);
        const data = txs.json.data as { transactions: { amount: number }[]; foreignCurrency: number };
        expect(data.transactions.map((t) => t.amount)).toEqual([-1999, 500]);
        expect(data.foreignCurrency).toBe(1);
        // First fetch: as far back as the bank allows.
        expect(eb.calls.at(-1)!.query).toEqual({ strategy: "longest" });
    });

    it("fetches from a start date and follows all pages", async () => {
        const many = paypalAccount();
        many.transactions = Array.from({ length: 7 }, (_, i) => ({ ...many.transactions[0]!, entry_reference: `REF${i}`, transaction_date: `2026-11-${String(10 + i).padStart(2, "0")}` }));
        eb = fakeEnableBanking({ applicationId: APP_ID, accounts: [many], pageSize: 3, now: () => NOW });
        api = buildApi({ version: "test", client: { fetch: eb.fetch }, now: () => NOW }).app;
        const state = await approve();
        const res = await call("psd2Transactions", { bank, login: { ...credentials, state }, account: { accountNumber: "PAYPALACCOUNT00000000000001" }, from: "2026-11-11" });
        expect((res.json.data as { transactions: unknown[] }).transactions).toHaveLength(6);
        const txCalls = eb.calls.filter((c) => c.path.endsWith("/transactions"));
        // 45 days further back, to see rejected payments that refunds give back; the answer starts at the date asked for
        expect(txCalls.map((c) => c.query)).toEqual([{ date_from: "2026-09-27" }, { date_from: "2026-09-27", continuation_key: "3" }, { date_from: "2026-09-27", continuation_key: "6" }]);
    });

    it("sends the user's browser along when the bank wants none or only those headers", async () => {
        const state = await approve();
        const psu = { ipAddress: "203.0.113.7", userAgent: "Firefox" };
        await call("psd2Balances", { bank, login: { ...credentials, state }, psu, accounts: [{ accountNumber: "PAYPALACCOUNT00000000000001" }] });
        expect(eb.calls.at(-1)!.headers).toMatchObject({ "psu-ip-address": "203.0.113.7", "psu-user-agent": "Firefox" });
        await call("psd2Balances", { bank, login: { ...credentials, state }, accounts: [{ accountNumber: "PAYPALACCOUNT00000000000001" }] });
        expect(eb.calls.at(-1)!.headers["psu-ip-address"]).toBeUndefined();
    });

    it("sends no browser headers when the bank wants some the connector lacks", async () => {
        const state = JSON.parse(await approve()) as StateJson;
        state.psuHeaders = ["Psu-Ip-Address", "Psu-Geo-Location"];
        await call("psd2Balances", { bank, login: { ...credentials, state: JSON.stringify(state) }, psu: { ipAddress: "203.0.113.7", userAgent: "Firefox" }, accounts: [{ accountNumber: "PAYPALACCOUNT00000000000001" }] });
        expect(eb.calls.at(-1)!.headers["psu-ip-address"]).toBeUndefined();
    });

    it("reports an ended approval as consent_expired", async () => {
        const state = await approve();
        eb.setSessionStatus(sessionsOf(state)[0]!.sessionId, "EXPIRED");
        const accounts = await call("psd2Accounts", { bank, login: { ...credentials, state } });
        expect(accounts.status).toBe(422);
        expect(accounts.json).toMatchObject({ error: "consent_expired" });
        const txs = await call("psd2Transactions", { bank, login: { ...credentials, state }, account: { accountNumber: "PAYPALACCOUNT00000000000001" } });
        expect(txs.json).toMatchObject({ error: "consent_expired" });
    });

    it("reports a login without approval as consent_expired without asking Enable Banking", async () => {
        const res = await call("psd2Accounts", { bank, login: credentials });
        expect(res.json).toMatchObject({ error: "consent_expired" });
        expect(eb.calls).toHaveLength(0);
    });

    it("refuses requests that break the contract", async () => {
        const res = await call("psd2Banks", { credentials, country: "Deutschland" });
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ error: "invalid" });
    });
});

describe("psd2CloseSession", () => {
    it("ends the session, and does not mind one that is already over", async () => {
        const state = await approve();
        const sessionId = sessionsOf(state)[0]!.sessionId;
        expect((await call("psd2CloseSession", { login: { ...credentials, state } })).json).toEqual({ ok: true });
        expect(eb.sessionStatus(sessionId)).toBe("CLOSED");
        expect((await call("psd2CloseSession", { login: { ...credentials, state } })).status).toBe(200);
        expect((await call("psd2CloseSession", { login: credentials })).status).toBe(200);
    });
});

describe("several approvals at one bank", () => {
    beforeEach(() => {
        eb = fakeEnableBanking({ applicationId: APP_ID, publicKey, now: () => NOW, accounts: [paypalAccount(), secondPaypalAccount()] });
        api = buildApi({ version: "test", client: { fetch: eb.fetch }, now: () => NOW }).app;
    });
    const first = { accountNumber: "PAYPALACCOUNT00000000000001" };
    const second = { accountNumber: "PAYPALACCOUNT00000000000002" };

    it("adds a second approval to the first, and both accounts are fetched", async () => {
        const one = await approve([0]);
        const both = await approve([1], one);
        const sessions = sessionsOf(both);
        expect(sessions).toHaveLength(2);
        expect(eb.sessionStatus(sessions[0]!.sessionId)).toBe("AUTHORIZED");

        const accounts = await call("psd2Accounts", { bank, login: { ...credentials, state: both } });
        const list = (accounts.json.data as { accounts: { externalId: string; name: string; consentUntil: string }[] }).accounts;
        // Both are named after the bank alone: the holder tells them apart
        expect(list.map((a) => [a.externalId, a.name])).toEqual([
            ["PAYPALACCOUNT00000000000001", "PayPal · Alex Beispiel"],
            ["PAYPALACCOUNT00000000000002", "PayPal · Kim Beispiel"],
        ]);
        expect(list.every((a) => Date.parse(a.consentUntil) > NOW)).toBe(true);

        const balances = await call("psd2Balances", { bank, login: { ...credentials, state: both }, accounts: [first, second] });
        expect((balances.json.data as { balances: { booked: number }[] }).balances.map((b) => b.booked)).toEqual([12345, 5000]);
        expect((await call("psd2Transactions", { bank, login: { ...credentials, state: both }, account: second })).status).toBe(200);
    });

    it("answers with the accounts of the new approval only", async () => {
        const one = await approve([0]);
        await call("psd2Consent", { bank, login: credentials, redirectUrl: "https://localhost/bank-callback", state: "s".repeat(32) });
        const res = await call("psd2Session", { bank, login: { ...credentials, state: one }, code: eb.approve([1]).code });
        expect((res.json.accounts as { externalId: string }[]).map((a) => a.externalId)).toEqual(["PAYPALACCOUNT00000000000002"]);
    });

    it("replaces the approval of an account approved again, and ends it at Enable Banking", async () => {
        const one = await approve([0]);
        const both = await approve([1], one);
        const renewed = await approve([0], both);
        const sessions = sessionsOf(renewed);
        expect(sessions).toHaveLength(2);
        expect(sessions.map((s) => s.accounts.map((a) => a.externalId))).toEqual([["PAYPALACCOUNT00000000000002"], ["PAYPALACCOUNT00000000000001"]]);
        expect(eb.sessionStatus(sessionsOf(one)[0]!.sessionId)).toBe("CLOSED");
    });

    it("keeps fetching the other account when one approval has ended", async () => {
        const both = await approve([1], await approve([0]));
        eb.setSessionStatus(sessionsOf(both)[0]!.sessionId, "REVOKED");
        const accounts = await call("psd2Accounts", { bank, login: { ...credentials, state: both } });
        expect(accounts.status).toBe(200);
        const list = (accounts.json.data as { accounts: { externalId: string; consentUntil: string }[] }).accounts;
        // The account of the ended approval is still reported (not gone at the bank), with its end
        expect(list.map((a) => [a.externalId, Date.parse(a.consentUntil) <= NOW])).toEqual([
            ["PAYPALACCOUNT00000000000001", true],
            ["PAYPALACCOUNT00000000000002", false],
        ]);
        const state = accounts.json.state as string;
        expect(sessionsOf(state)[0]!.ended).toBeDefined();
        const balances = await call("psd2Balances", { bank, login: { ...credentials, state }, accounts: [first, second] });
        expect((balances.json.data as { balances: unknown[] }).balances).toHaveLength(1);
        const txs = await call("psd2Transactions", { bank, login: { ...credentials, state }, account: first });
        expect(txs.json).toMatchObject({ error: "not_supported", message: expect.stringContaining("abgelaufen") });
    });

    it("does not ask about an approval past its end", async () => {
        const one = JSON.parse(await approve([0])) as StateJson;
        one.sessions[0]!.validUntil = new Date(NOW - 1000).toISOString();
        const both = await approve([1], JSON.stringify(one));
        eb.calls.length = 0;
        const accounts = await call("psd2Accounts", { bank, login: { ...credentials, state: both } });
        expect(accounts.status).toBe(200);
        expect(eb.calls.filter((c) => c.path.startsWith("/sessions/"))).toHaveLength(1);
    });

    it("reports consent_expired only when no approval holds", async () => {
        const both = await approve([1], await approve([0]));
        for (const s of sessionsOf(both)) eb.setSessionStatus(s.sessionId, "EXPIRED");
        expect((await call("psd2Accounts", { bank, login: { ...credentials, state: both } })).json).toMatchObject({ error: "consent_expired" });
    });

    it("ends all approvals when closing", async () => {
        const both = await approve([1], await approve([0]));
        expect((await call("psd2CloseSession", { login: { ...credentials, state: both } })).json).toEqual({ ok: true });
        expect(sessionsOf(both).map((s) => eb.sessionStatus(s.sessionId))).toEqual(["CLOSED", "CLOSED"]);
    });

    it("reads the state of a single approval from before", async () => {
        const v2 = JSON.parse(await approve([0])) as StateJson;
        const s = v2.sessions[0]!;
        const v1 = JSON.stringify({ v: 1, sessionId: s.sessionId, validUntil: s.validUntil, psuHeaders: [], accounts: s.accounts });
        const accounts = await call("psd2Accounts", { bank, login: { ...credentials, state: v1 } });
        expect(accounts.status).toBe(200);
        expect(sessionsOf(accounts.json.state as string)).toHaveLength(1);
        expect(sessionsOf(await approve([1], v1))).toHaveLength(2);
    });
});

describe("unreachable Enable Banking", () => {
    it("says so", async () => {
        api = buildApi({ version: "test", client: { fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch } }).app;
        const res = await call("psd2Banks", { credentials, country: "DE" });
        expect(res.status).toBe(502);
        expect(res.json).toMatchObject({ error: "unreachable" });
    });
});
