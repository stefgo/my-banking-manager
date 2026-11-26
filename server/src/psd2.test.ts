// Bank accesses over PSD2: the real Enable Banking connector embedded in the server, against the
// simulated Enable Banking (made-up data in the form PayPal sends), never the real service.

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbeddedConnector } from "@mbm/connector-enablebanking/embedded";
import { fakeEnableBanking, PAYPAL, type FakeEnableBanking } from "@mbm/connector-enablebanking/testing";
import type { BankConnection, OfferedAccount, SyncRun } from "@mbm/shared";
import { confirmCode, createTestApp, setUpSignedIn, signInCreatedUser, type TestApp } from "./testing/testApp.js";

type Api = Awaited<ReturnType<typeof setUpSignedIn>>["api"];

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_ID = randomUUID();
const credentials = { applicationId: APP_ID, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const CALLBACK = "http://localhost/bank-callback";

let t: TestApp;
let eb: FakeEnableBanking;
let api: Api;
let secret: string;

beforeEach(async () => {
    eb = fakeEnableBanking({ applicationId: APP_ID, publicKey, aspsps: [PAYPAL], redirectUrls: [CALLBACK, "https://localhost/bank-callback"] });
    t = await createTestApp({ connectors: { enablebanking: { embedded: true } } }, { loadEmbeddedConnectors: { enablebanking: () => createEmbeddedConnector({}, { client: { fetch: eb.fetch } }) } });
    ({ api, secret } = await setUpSignedIn(t));
});
afterEach(() => t.close());

/** PayPal access with the own login, approved; answers with the connection id. */
async function approvedAccess(who: Api = api): Promise<number> {
    const conn = await who<BankConnection>("POST", "/api/psd2/connections", { aspsp: "PayPal", country: "DE" });
    expect(conn.status, JSON.stringify(conn.body)).toBe(200);
    const id = conn.body.id;
    expect((await who("PUT", `/api/bank-connections/${id}/psd2-login`, { credentials })).status).toBe(200);
    const started = await who<{ url: string }>("POST", `/api/bank-connections/${id}/consent`, { redirectUrl: CALLBACK });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const done = await who<BankConnection>("POST", "/api/psd2/consent", eb.approve());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return id;
}

async function takeOver(id: number): Promise<number> {
    const offered = await api<{ status: string; data: { accounts: OfferedAccount[] } }>("POST", `/api/bank-connections/${id}/login/accounts`);
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    const taken = await api<{ created: number[] }>("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: offered.body.data.accounts[0]!.externalId }] });
    expect(taken.status).toBe(200);
    return taken.body.created[0]!;
}

/** The session id at Enable Banking, from the first session lookup (taking over or listing accounts). */
const sessionId = (): string => eb.calls.find((c) => c.method === "GET" && /^\/sessions\/[^/]+$/.test(c.path))!.path.split("/")[2]!;

async function syncDone(body: object = {}): Promise<SyncRun> {
    const started = await api<SyncRun[]>("POST", "/api/sync", body);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    for (let i = 0; i < 200; i++) {
        const { body: runs } = await api<SyncRun[]>("GET", "/api/sync");
        const run = runs.find((r) => r.id === started.body[0]!.id);
        if (run && run.status !== "running") return run;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("run did not finish");
}

describe("PSD2 bank access", () => {
    it("lists the banks with typed-in credentials and with those of an own access", async () => {
        const typed = await api<{ banks: { name: string; maxConsentDays: number }[] }>("POST", "/api/psd2/banks", { country: "DE", credentials });
        expect(typed.status).toBe(200);
        expect(typed.body.banks).toEqual([expect.objectContaining({ name: "PayPal", maxConsentDays: 180 })]);
        const id = await approvedAccess();
        const reused = await api("POST", "/api/psd2/banks", { country: "DE", fromConnection: id });
        expect(reused.status).toBe(200);
    });

    it("says so when Enable Banking refuses the application", async () => {
        const res = await api<{ error: string; message: string }>("POST", "/api/psd2/banks", { country: "DE", credentials: { ...credentials, applicationId: randomUUID() } });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ error: "pin_wrong", message: expect.stringContaining("Application-ID") });
    });

    it("creates one access per bank and keeps FinTS steps away from it", async () => {
        const a = await api<BankConnection>("POST", "/api/psd2/connections", { aspsp: "PayPal", country: "DE" });
        const b = await api<BankConnection>("POST", "/api/psd2/connections", { aspsp: "PayPal", country: "DE" });
        expect(b.body.id).toBe(a.body.id);
        expect(a.body).toMatchObject({ kind: "psd2", psd2: { aspsp: "PayPal", country: "DE" }, name: "PayPal", icon: "wallet", blz: "", fintsUrl: "", myLogin: null });
        expect((await api("PUT", `/api/bank-connections/${a.body.id}/login`, { loginName: "x", pin: "1" })).status).toBe(409);
        expect((await api("PUT", `/api/bank-connections/${a.body.id}/login/tan-method`, { tanMethod: "942" })).status).toBe(409);
    });

    it("sets the application, keeps the key sealed and shows only a hint", async () => {
        const conn = await api<BankConnection>("POST", "/api/psd2/connections", { aspsp: "PayPal", country: "DE" });
        const login = await api<{ loginHint: string; status: string; consentUntil: string | null }>("PUT", `/api/bank-connections/${conn.body.id}/psd2-login`, { credentials });
        expect(login.status).toBe(200);
        expect(login.body).toMatchObject({ loginHint: `App ••••${APP_ID.slice(-4)}`, status: "setup", consentUntil: null });
        const row = t.vault.database.prepare("SELECT sealed_credentials AS c FROM bank_logins").get() as { c: string };
        expect(row.c).not.toContain("PRIVATE KEY");
        expect(row.c).not.toContain(APP_ID);
    });

    it("approves at the bank once, only for the user who started it", async () => {
        const conn = await api<BankConnection>("POST", "/api/psd2/connections", { aspsp: "PayPal", country: "DE" });
        const id = conn.body.id;
        await api("PUT", `/api/bank-connections/${id}/psd2-login`, { credentials });
        // Back only to MBM itself or to localhost
        expect((await api<{ error: string }>("POST", `/api/bank-connections/${id}/consent`, { redirectUrl: "https://evil.example/bank-callback" })).body).toMatchObject({ error: "redirect_not_allowed" });
        expect((await api("POST", `/api/bank-connections/${id}/consent`, { redirectUrl: "http://localhost/other" })).status).toBe(422);
        expect((await api("POST", `/api/bank-connections/${id}/consent`, { redirectUrl: "https://localhost/bank-callback" })).status).toBe(200);
        expect((await api("POST", `/api/bank-connections/${id}/consent`, { redirectUrl: CALLBACK })).status).toBe(200);
        const back = eb.approve();

        const created = await api("POST", "/api/users", { name: "Ben", password: "bens-langes-passwort", code: confirmCode(t, secret) });
        expect(created.status).toBe(200);
        const ben = await signInCreatedUser(t, "Ben", "bens-langes-passwort");
        expect((await ben.api("POST", "/api/psd2/consent", back)).status).toBe(404);

        const done = await api<BankConnection>("POST", "/api/psd2/consent", back);
        expect(done.status).toBe(200);
        expect(Date.parse(done.body.myLogin!.consentUntil!)).toBeGreaterThan(Date.now() + 179 * 86_400_000);
        expect((await api("POST", "/api/psd2/consent", back)).status).toBe(404);
        // The first approval started was replaced by the second one
        expect((await api("POST", "/api/psd2/consent", { state: "x".repeat(32), code: "c" })).status).toBe(404);
    });

    it("takes over the PayPal account and fetches balance and bookings with the user's browser", async () => {
        const id = await approvedAccess();
        const accountId = await takeOver(id);
        const account = t.vault.database.prepare("SELECT kind, currency, icon, iban, name FROM accounts WHERE id = ?").get(accountId);
        expect(account).toEqual({ kind: "giro", currency: "EUR", icon: "wallet", iban: null, name: "PayPal" });

        const run = await syncDone();
        expect(run).toMatchObject({ status: "done", newTransactions: 2, foreignCurrency: 1, error: null });
        const txs = t.vault.database.prepare("SELECT amount, booking_date AS d FROM transactions WHERE account_id = ? ORDER BY booking_date").all(accountId);
        expect(txs).toEqual([{ amount: 500, d: "2026-11-18" }, { amount: -1999, d: "2026-11-20" }]);
        expect(t.vault.database.prepare("SELECT amount FROM balances WHERE account_id = ?").get(accountId)).toEqual({ amount: 12345 });
        const fetches = eb.calls.filter((c) => c.path.endsWith("/transactions"));
        expect(fetches[0]!.query).toEqual({ strategy: "longest" });
        expect(fetches[0]!.headers["psu-ip-address"]).toBe("127.0.0.1");
        expect(fetches[0]!.headers["psu-user-agent"]).toBeTruthy();

        // The next fetch starts shortly before the newest booking
        await syncDone();
        expect(eb.calls.filter((c) => c.path.endsWith("/transactions")).at(-1)!.query.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("marks the login when the approval has ended at the bank", async () => {
        const id = await approvedAccess();
        await takeOver(id);
        eb.setSessionStatus(sessionId(), "REVOKED");
        const run = await syncDone({ connectionId: id });
        expect(run).toMatchObject({ status: "error", error: "consent_expired" });
        const conns = await api<BankConnection[]>("GET", "/api/bank-connections");
        expect(conns.body[0]!.myLogin).toMatchObject({ status: "consent_needed" });

        // Approved again: ready, the account stays linked
        await api("POST", `/api/bank-connections/${id}/consent`, { redirectUrl: CALLBACK });
        const again = await api<BankConnection>("POST", "/api/psd2/consent", eb.approve());
        expect(again.body.myLogin).toMatchObject({ status: "ready" });
        expect((await syncDone({ connectionId: id })).status).toBe("done");
    });

    it("does not ask Enable Banking once the approval is past its end", async () => {
        const id = await approvedAccess();
        await takeOver(id);
        t.vault.database.prepare("UPDATE bank_logins SET consent_until = '2020-01-01T00:00:00.000Z'").run();
        const before = eb.calls.length;
        const run = await syncDone({ connectionId: id });
        expect(run).toMatchObject({ status: "error", error: "consent_expired" });
        expect(eb.calls.length).toBe(before);
    });

    it("fetches PSD2 logins along with all others, but not before the first approval", async () => {
        const conn = await api<BankConnection>("POST", "/api/psd2/connections", { aspsp: "PayPal", country: "DE" });
        await api("PUT", `/api/bank-connections/${conn.body.id}/psd2-login`, { credentials });
        expect((await api<SyncRun[]>("POST", "/api/sync", {})).body).toEqual([]);
    });

    it("ends the session at Enable Banking when the login goes", async () => {
        const id = await approvedAccess();
        await api("POST", `/api/bank-connections/${id}/login/accounts`);
        const sid = sessionId();
        expect((await api("DELETE", `/api/bank-connections/${id}/login`)).status).toBe(200);
        expect(eb.sessionStatus(sid)).toBe("CLOSED");
    });

    it("replaces the application and ends the approval of the old one", async () => {
        const id = await approvedAccess();
        await api("POST", `/api/bank-connections/${id}/login/accounts`);
        const sid = sessionId();
        const again = await api<{ status: string; consentUntil: string | null }>("PUT", `/api/bank-connections/${id}/psd2-login`, { credentials });
        expect(again.body).toMatchObject({ status: "setup", consentUntil: null });
        expect(eb.sessionStatus(sid)).toBe("CLOSED");
    });
});
