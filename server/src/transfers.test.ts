import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { confirmCode, createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { startFakeConnector, type FakeConnector } from "./testing/fakeConnector.js";
import { ConnectorClient } from "./connectors/client.js";
import { TransferManager } from "./services/transfers.js";

let t: TestApp;
let fc: FakeConnector;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];
let session = "";
let secret = "";

const caps = { balance: true, transactions: true, cardTransactions: false, transfer: true, instantTransfer: true, standingOrders: false, scheduledTransfers: false, payeeVerification: true };
const acc = (iban: string, name: string, c: Partial<typeof caps> = {}) => ({ accountNumber: iban.slice(-7), subAccount: "", iban, bic: "SIMUDEM1XXX", externalId: iban, name, owner: "Anna", currency: "EUR", kind: "giro", capabilities: { ...caps, ...c } });
const GIRO = acc("DE02700543060001234567", "Girokonto");
const SAVINGS = acc("DE02700543060009876543", "Tagesgeld", { transfer: false, instantTransfer: false });
const PAYEE_IBAN = "DE89370400440532013000";

const MATCH = { result: "match", payeeName: null, reason: null, explanation: "", structured: false };
const CLOSE = { result: "close_match", payeeName: "Erika Musterfrau", reason: null, explanation: "<p>Der Name weicht ab.</p>", structured: true };
const decoupled = { decoupled: true, text: "In der App freigeben.", medium: "", validUntil: "", methodName: "pushTAN" };
const DONE = { status: "done", data: { bankMessage: "Auftrag zur Ausführung vorgemerkt.", reference: "REF-1", vop: MATCH, unconfirmed: false, converted: false }, state: "S-AFTER" };

type T = { id: number; status: string; finishedAt: string | null; vop: { result: string; payeeName: string | null } | null; challenge: { decoupled: boolean } | null; bankMessage: string | null; bankReference: string | null; transactionId: number | null; mine: boolean; endToEndId: string };

beforeEach(async () => {
    fc = await startFakeConnector();
    t = await createTestApp({ connectors: { fints: { socket: fc.socket } }, bankPollMs: 20 });
    ({ api, session, secret } = await setUpSignedIn(t));
    fc.on("checkBank", () => ({ bankName: "Sparkasse", bpdVersion: 1, pinTan: true, jobs: [] }));
    fc.on("tanMethods", () => ({ status: "done", data: { methods: [{ id: "923", name: "pushTAN", decoupled: true, needsMedium: false }] }, state: "S0" }));
    fc.on("accounts", () => ({ status: "done", data: { accounts: [GIRO, SAVINGS] }, state: "S1" }));
});

afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
    await fc.close();
});

async function setUpAccess(savePin = true): Promise<{ giro: number; savings: number }> {
    const { body: conn } = await api<{ id: number }>("POST", "/api/bank-connections", { blz: "70054306", fintsUrl: "https://bank.example.invalid/fints" });
    await api("PUT", `/api/bank-connections/${conn.id}/login`, { loginName: "anna1234567", pin: "1234", savePin });
    await api("PUT", `/api/bank-connections/${conn.id}/login/tan-method`, { tanMethod: "923" });
    await api("POST", `/api/bank-connections/${conn.id}/login/accounts`, savePin ? undefined : { pin: "1234" });
    const { body } = await api<{ created: number[] }>("POST", `/api/bank-connections/${conn.id}/accounts`, { accounts: [GIRO, SAVINGS].map((a) => ({ externalId: a.externalId })) });
    const [giro, savings] = body.created as [number, number];
    return { giro, savings };
}

const request = (accountId: number, extra: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    accountId,
    payeeName: "Erika Mustermann",
    payeeIban: "DE89 3704 0044 0532 0130 00",
    amount: 100,
    remittance: "Test über MBM",
    ...extra,
});

async function waitFor(id: number, pred: (x: T) => boolean): Promise<T> {
    for (let i = 0; i < 300; i++) {
        const { body } = await api<T>("GET", `/api/transfers/${id}`);
        if (pred(body)) return body;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout waiting for transfer");
}

const calls = (route: string) => fc.received.filter((r) => r.route === route);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OP = "00000000-0000-4000-8000-0000000000a1";
const tanChallenge = { ...decoupled, decoupled: false };

/** The fake connector answers at once; this holds the answers of `route` back by `ms` and logs the order of calls. */
function slowRoute(route: string, ms: number): string[] {
    const log: string[] = [];
    const call = ConnectorClient.prototype.call;
    vi.spyOn(ConnectorClient.prototype, "call").mockImplementation(async function (this: ConnectorClient, r: never, o?: never) {
        if (r !== route) {
            log.push(r);
            return call.call(this, r, o);
        }
        log.push(`${route}:start`);
        await sleep(ms);
        const out = await call.call(this, r, o);
        log.push(`${route}:end`);
        return out;
    } as never);
    return log;
}

/** A manager with short time limits in place of the server's. */
const shortLimits = (waitMs: number) => (t.ctx.transfers = new TransferManager(t.ctx, { pollMs: 20, waitMs }));

describe("transfers", () => {
    it("lists only accounts with an own login that allows transfers", async () => {
        const { giro } = await setUpAccess();
        const { body } = await api<unknown[]>("GET", "/api/transfers/accounts");
        expect(body).toEqual([{ id: giro, name: "Girokonto", iban: GIRO.iban, connectionName: expect.any(String), instant: true, payeeVerification: true, pinRequired: false, transfer: true, scheduled: false, standing: false, orderRules: null }]);
    });

    it("submits, shows the result of the check next to the approval, and ends executed", async () => {
        const { giro } = await setUpAccess();
        let polls = 0;
        fc.on("transfer", () => ({ status: "approval", operationId: "00000000-0000-4000-8000-000000000001", challenge: decoupled, vop: MATCH }));
        fc.on("operation", () => (++polls < 2 ? { status: "approval", operationId: "00000000-0000-4000-8000-000000000001", challenge: decoupled, vop: MATCH } : DONE));

        const req = request(giro);
        const created = await api<T>("POST", "/api/transfers", req);
        expect(created.status).toBe(200);
        expect(created.body).toMatchObject({ status: "submitting", mine: true, payeeIban: PAYEE_IBAN });
        expect(created.body.endToEndId).toMatch(/^MBM-[A-Z2-9]{31}$/);

        const waiting = await waitFor(created.body.id, (x) => x.status === "awaiting_tan");
        expect(waiting).toMatchObject({ vop: { result: "match" }, challenge: { decoupled: true } });

        const done = await waitFor(created.body.id, (x) => x.status === "executed");
        expect(done).toMatchObject({ bankMessage: "Auftrag zur Ausführung vorgemerkt.", bankReference: "REF-1", challenge: null });
        const [sent] = calls("transfer");
        expect(sent!.body.transfer).toEqual({ payeeName: "Erika Mustermann", payeeIban: PAYEE_IBAN, payeeBic: null, amount: 100, remittance: "Test über MBM", endToEndId: done.endToEndId, instant: false });
        expect(sent!.body.account).toMatchObject({ iban: GIRO.iban });

        // Sending the same request again gives the same transfer and sends nothing
        const again = await api<T>("POST", "/api/transfers", req);
        expect(again.body.id).toBe(created.body.id);
        expect(calls("transfer")).toHaveLength(1);

        const payees = await api<{ payees: { name: string; iban: string }[] }>("GET", "/api/transfers/payees");
        expect(payees.body.payees).toMatchObject([{ name: "Erika Mustermann", iban: PAYEE_IBAN }]);
        const activity = await api<{ action: string }[]>("GET", "/api/activity?limit=20");
        expect(activity.body.map((a) => a.action)).toEqual(expect.arrayContaining(["transfer_submitted", "transfer_executed"]));
    });

    it("waits for the confirmation of a differing name, then goes on to the approval", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => ({ status: "confirm", operationId: "00000000-0000-4000-8000-000000000002", vop: CLOSE }));
        fc.on("confirmOperation", () => ({ status: "approval", operationId: "00000000-0000-4000-8000-000000000002", challenge: { ...decoupled, decoupled: false }, vop: CLOSE }));
        fc.on("operationTan", (b: { tan: string }) => (b.tan === "123456" ? { ...DONE, data: { ...DONE.data, vop: CLOSE } } : { status: 422, json: { error: "bank_error", message: "9941 TAN ungültig", bankCodes: [{ code: "9941", text: "TAN ungültig" }] } }));

        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        const waiting = await waitFor(body.id, (x) => x.status === "awaiting_vop_confirm");
        expect(waiting.vop).toMatchObject({ result: "close_match", payeeName: "Erika Musterfrau" });
        expect(calls("confirmOperation")).toHaveLength(0);
        expect((await api("POST", `/api/transfers/${body.id}/tan`, { tan: "1" })).status).toBe(409);

        await api("POST", `/api/transfers/${body.id}/confirm`);
        const tan = await waitFor(body.id, (x) => x.status === "awaiting_tan");
        expect(tan.challenge).toMatchObject({ decoupled: false });
        await api("POST", `/api/transfers/${body.id}/tan`, { tan: "123456" });
        const done = await waitFor(body.id, (x) => x.status === "executed");
        expect(done.vop).toMatchObject({ result: "close_match" });
        expect(calls("confirmOperation")).toHaveLength(1);
    });

    it("cancels while waiting for the confirmation and ends the operation at the connector", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => ({ status: "confirm", operationId: "00000000-0000-4000-8000-000000000003", vop: { ...CLOSE, result: "no_match", payeeName: null } }));
        fc.on("cancelOperation", () => ({ ok: true }));
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        await waitFor(body.id, (x) => x.status === "awaiting_vop_confirm");
        await api("POST", `/api/transfers/${body.id}/cancel`);
        const done = await waitFor(body.id, (x) => x.status === "cancelled");
        expect(done.bankMessage).toBe("Abgebrochen.");
        expect(calls("cancelOperation")).toHaveLength(1);
        expect(calls("confirmOperation")).toHaveLength(0);
        expect((await api("POST", `/api/transfers/${body.id}/cancel`)).status).toBe(409);
    });

    it("ends as unknown when the answer is lost, and as executed once the booking arrives", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => ({ status: "approval", operationId: "00000000-0000-4000-8000-000000000004", challenge: decoupled, vop: MATCH }));
        fc.on("operation", () => ({ status: 502, json: { error: "outcome_unknown", message: "lost" } }));
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        const unknown = await waitFor(body.id, (x) => x.status === "unknown");
        expect(unknown.bankMessage).toContain("unbekannt");
        expect(calls("transfer")).toHaveLength(1);
        expect((await api<{ payees: unknown[] }>("GET", "/api/transfers/payees")).body.payees).toHaveLength(0);

        // The next fetch brings the booking with MBM's end-to-end ID
        const booking = { bookingDate: "2026-11-17", valueDate: "2026-11-17", amount: -100, currency: "EUR", status: "booked", counterpartyName: "Erika Mustermann", counterpartyIban: PAYEE_IBAN, counterpartyBic: null, remittance: "Test über MBM", endToEndId: unknown.endToEndId, mandateId: null, creditorId: null, bookingText: "", bankReference: null };
        fc.on("balances", () => ({ status: "done", data: { balances: [] }, state: "S2" }));
        fc.on("transactions", (b: { account: { iban: string } }) => ({ status: "done", data: { transactions: b.account.iban === GIRO.iban ? [booking] : [] }, state: "S3" }));
        await api("POST", "/api/sync", { accountId: giro });
        const booked = await waitFor(body.id, (x) => x.transactionId !== null);
        expect(booked.status).toBe("executed");
        // Now known as executed: the payee joins the list, the activity log says so
        expect((await api<{ payees: { iban: string }[] }>("GET", "/api/transfers/payees")).body.payees).toMatchObject([{ iban: PAYEE_IBAN }]);
        const activity = await api<{ action: string; details: string }[]>("GET", "/api/activity?limit=50");
        expect(activity.body.find((a) => a.action === "transfer_executed")?.details).toContain("durch die Buchung bestätigt");
    });

    it("waits for the bank's answer to a TAN although the time for the user runs out meanwhile", async () => {
        const { giro } = await setUpAccess();
        shortLimits(300);
        fc.on("transfer", () => ({ status: "approval", operationId: OP, challenge: tanChallenge, vop: MATCH }));
        fc.on("operationTan", () => DONE);
        slowRoute("operationTan", 600);
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        await waitFor(body.id, (x) => x.status === "awaiting_tan");
        await api("POST", `/api/transfers/${body.id}/tan`, { tan: "123456" });
        expect((await waitFor(body.id, (x) => x.finishedAt !== null)).status).toBe("executed");
        expect(calls("cancelOperation")).toHaveLength(0);
    });

    it("cancels when no TAN comes in time and ends the operation at the connector", async () => {
        const { giro } = await setUpAccess();
        shortLimits(100);
        fc.on("transfer", () => ({ status: "approval", operationId: OP, challenge: tanChallenge, vop: MATCH }));
        fc.on("cancelOperation", () => ({ ok: true }));
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        const done = await waitFor(body.id, (x) => x.finishedAt !== null);
        expect(done).toMatchObject({ status: "cancelled", bankMessage: "Abgebrochen: Es kam keine TAN." });
        expect(calls("cancelOperation")).toHaveLength(1);
    });

    it("refuses to cancel while the TAN is on its way to the bank", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => ({ status: "approval", operationId: OP, challenge: tanChallenge, vop: MATCH }));
        fc.on("operationTan", () => DONE);
        slowRoute("operationTan", 300);
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        await waitFor(body.id, (x) => x.status === "awaiting_tan");
        const tan = api("POST", `/api/transfers/${body.id}/tan`, { tan: "123456" });
        await sleep(50);
        expect(await api<{ error: string }>("POST", `/api/transfers/${body.id}/cancel`)).toMatchObject({ status: 409, body: { error: "tan_in_flight" } });
        await tan;
        expect((await waitFor(body.id, (x) => x.finishedAt !== null)).status).toBe("executed");
        expect(calls("cancelOperation")).toHaveLength(0);
    });

    it("cancels an approval in the app only after the status query under way", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => ({ status: "approval", operationId: OP, challenge: decoupled, vop: MATCH }));
        fc.on("operation", () => ({ status: "approval", operationId: OP, challenge: decoupled, vop: MATCH }));
        fc.on("cancelOperation", () => ({ ok: true }));
        const log = slowRoute("operation", 150);
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        await waitFor(body.id, (x) => x.status === "awaiting_tan");
        while (log.at(-1) !== "operation:start") await sleep(5);
        expect((await api("POST", `/api/transfers/${body.id}/cancel`)).status).toBe(200);
        const done = await waitFor(body.id, (x) => x.finishedAt !== null);
        expect(done).toMatchObject({ status: "cancelled", bankMessage: "Abgebrochen. Bitte die Anfrage in der App jetzt nicht mehr freigeben." });
        expect(log.slice(-2)).toEqual(["operation:end", "cancelOperation"]);
    });

    it("counts an approval that arrives with the status query under way, even after cancelling", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => ({ status: "approval", operationId: OP, challenge: decoupled, vop: MATCH }));
        fc.on("operation", () => DONE);
        const log = slowRoute("operation", 150);
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        await waitFor(body.id, (x) => x.status === "awaiting_tan");
        while (log.at(-1) !== "operation:start") await sleep(5);
        await api("POST", `/api/transfers/${body.id}/cancel`);
        expect((await waitFor(body.id, (x) => x.finishedAt !== null)).status).toBe("executed");
        expect(calls("cancelOperation")).toHaveLength(0);
    });

    it("refuses to lock the server or delete the connection while a transfer runs", async () => {
        const { giro } = await setUpAccess();
        let release = false;
        fc.on("transfer", () => ({ status: "approval", operationId: OP, challenge: decoupled, vop: MATCH }));
        fc.on("operation", () => (release ? DONE : { status: "approval", operationId: OP, challenge: decoupled, vop: MATCH }));
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        await waitFor(body.id, (x) => x.status === "awaiting_tan");
        const conn = (await api<{ id: number }[]>("GET", "/api/bank-connections")).body[0]!.id;
        expect(await api<{ error: string }>("POST", "/api/lock")).toMatchObject({ status: 409, body: { error: "transfer_running" } });
        expect(await api<{ error: string }>("DELETE", `/api/bank-connections/${conn}?accounts=delete`)).toMatchObject({ status: 409, body: { error: "transfer_running" } });
        release = true;
        expect((await waitFor(body.id, (x) => x.finishedAt !== null)).status).toBe("executed");
        expect((await api("POST", "/api/lock")).status).toBe(200);
        const unlocked = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { name: "Anna", password: "sehr-geheimes-passwort" }, headers: { cookie: session } });
        expect(unlocked.statusCode).toBe(200);
        expect((await api<T>("GET", `/api/transfers/${body.id}`)).body.status).toBe("executed");
    });

    it("gives the same transfer to two requests with the same ID at once, and refuses one with other data", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => DONE);
        const req = request(giro);
        const [a, b] = await Promise.all([api<T>("POST", "/api/transfers", req), api<T>("POST", "/api/transfers", req)]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(a.body.id).toBe(b.body.id);
        await waitFor(a.body.id, (x) => x.finishedAt !== null);
        expect(calls("transfer")).toHaveLength(1);
        expect(t.vault.database.prepare("SELECT COUNT(*) AS n FROM transfers").get()).toEqual({ n: 1 });
        expect(await api<{ error: string }>("POST", "/api/transfers", { ...req, amount: 999 })).toMatchObject({ status: 409, body: { error: "request_id_conflict" } });
    });

    it("stays quiet while an approval in the app is pending", async () => {
        const { giro } = await setUpAccess();
        let polls = 0;
        fc.on("transfer", () => ({ status: "approval", operationId: OP, challenge: decoupled, vop: MATCH }));
        fc.on("operation", () => (++polls < 10 ? { status: "approval", operationId: OP, challenge: decoupled, vop: MATCH } : DONE));
        const changed = vi.spyOn(t.ctx.events, "changed");
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        await waitFor(body.id, (x) => x.finishedAt !== null);
        expect(polls).toBe(10);
        // Started, waits for the approval, finished
        expect(changed.mock.calls.filter((c) => c.includes("transfers")).length).toBeLessThanOrEqual(3);
    });

    it("ends as rejected with the bank's text when the bank refuses", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => ({ status: "approval", operationId: "00000000-0000-4000-8000-000000000005", challenge: decoupled }));
        fc.on("operation", () => ({ status: 422, json: { error: "bank_error", message: "9230 Unzureichendes Guthaben", bankCodes: [{ code: "9230", text: "Unzureichendes Guthaben" }] } }));
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        const done = await waitFor(body.id, (x) => x.status === "rejected");
        expect(done.bankMessage).toBe("Die Bank hat abgelehnt: 9230 Unzureichendes Guthaben");
    });

    it("ends as failed when the bank is not reached before anything was sent", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => ({ status: 502, json: { error: "unreachable", message: "Die Bank ist nicht erreichbar." } }));
        const { body } = await api<T>("POST", "/api/transfers", request(giro));
        expect((await waitFor(body.id, (x) => x.status === "failed")).bankMessage).toBe("Die Bank ist nicht erreichbar.");
    });

    it("checks the request before anything is sent", async () => {
        const { giro, savings } = await setUpAccess();
        const offline = (await api<{ id: number }>("POST", "/api/accounts", { name: "Bargeld" })).body.id;
        const bad = async (body: object, status: number, error?: string) => {
            const res = await api<{ error: string; message: string }>("POST", "/api/transfers", body);
            expect(res.status, JSON.stringify(res.body)).toBe(status);
            if (error) expect(res.body.error).toBe(error);
            return res.body.message;
        };
        expect(await bad(request(giro, { payeeIban: "DE89370400440532013001" }), 400)).toContain("IBAN");
        expect(await bad(request(giro, { remittance: "Rechnung #12 ✓" }), 400)).toContain("„#“, „✓“");
        await bad(request(giro, { amount: 0 }), 400);
        await bad(request(giro, { payeeName: "" }), 400);
        await bad(request(giro, { remittance: "x".repeat(141) }), 400);
        await bad(request(savings), 422, "not_allowed");
        await bad(request(offline), 422, "not_bank_account");
        t.vault.database.prepare("UPDATE accounts SET iban = ? WHERE id = ?").run(PAYEE_IBAN, giro);
        await bad(request(giro), 422, "same_account");
        expect(calls("transfer")).toHaveLength(0);
        expect(t.vault.database.prepare("SELECT COUNT(*) AS n FROM transfers").get()).toEqual({ n: 0 });
    });

    it("asks for the PIN when it is not stored", async () => {
        const { giro } = await setUpAccess(false);
        fc.on("transfer", () => DONE);
        expect((await api<{ error: string }>("POST", "/api/transfers", request(giro))).body.error).toBe("pin_required");
        const { body } = await api<T>("POST", "/api/transfers", request(giro, { pin: "1234" }));
        await waitFor(body.id, (x) => x.status === "executed");
        expect(calls("transfer")[0]!.body.login.pin).toBe("1234");
    });

    it("asks for the password again after a while", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => DONE);
        t.vault.database.prepare("UPDATE devices SET password_at = ?").run(new Date(Date.now() - 16 * 60_000).toISOString());
        const req = request(giro);
        expect((await api<{ error: string }>("POST", "/api/transfers", req))).toMatchObject({ status: 403, body: { error: "confirm_required" } });
        expect((await api("POST", "/api/session/password", { password: "falsch" })).status).toBe(401);
        expect((await api("POST", "/api/session/password", { password: "sehr-geheimes-passwort" })).status).toBe(200);
        const { body } = await api<T>("POST", "/api/transfers", req);
        await waitFor(body.id, (x) => x.status === "executed");
    });

    it("asks a device token created from a session for the password before its first transfer", async () => {
        const { giro } = await setUpAccess();
        fc.on("transfer", () => DONE);
        const { body: created } = await api<{ token: string }>("POST", "/api/devices", { name: "MacBook", code: confirmCode(t, secret) });
        const res = await t.app.inject({ method: "POST", url: "/api/transfers", payload: request(giro), headers: { authorization: `Bearer ${created.token}` } });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("confirm_required");
        expect(calls("transfer")).toHaveLength(0);
    });

    it("ends transfers that were waiting when the server stopped", async () => {
        const { giro } = await setUpAccess();
        const db = t.vault.database;
        const insert = db.prepare(
            "INSERT INTO transfers (request_id, account_id, created_by, created_by_name, payee_name, payee_iban, amount, remittance, end_to_end_id, status, created_at, updated_at) VALUES (?, ?, 1, 'Anna', 'X', ?, 1, '', ?, ?, '2026-11-17', '2026-11-17')",
        );
        for (const [i, s] of ["submitting", "awaiting_vop_confirm", "awaiting_tan", "executed"].entries()) insert.run(randomUUID(), giro, PAYEE_IBAN, `MBM-${i}`, s);
        t.ctx.transfers.recover(db);
        expect((db.prepare("SELECT status FROM transfers ORDER BY id").all() as { status: string }[]).map((r) => r.status)).toEqual(["unknown", "cancelled", "unknown", "executed"]);
    });

    it("keeps a list of payees and suggests counterparties of debits", async () => {
        const { giro } = await setUpAccess();
        const db = t.vault.database;
        db.prepare("INSERT INTO payees (name, iban, last_used_at, created_at) VALUES ('Vermieter', ?, '2026-11-01', '2026-11-01')").run(PAYEE_IBAN);
        db.prepare("INSERT INTO transactions (account_id, fingerprint, booking_date, amount, currency, counterparty_name, counterparty_iban, remittance, status, source, first_seen_at) VALUES (?, 'f1', '2026-11-10', -500, 'EUR', 'Stadtwerke', 'DE44500105175407324931', '', 'booked', 'manual', '2026-11-10')").run(giro);
        const { body } = await api<{ payees: { id: number; name: string }[]; suggestions: { name: string; iban: string }[] }>("GET", "/api/transfers/payees");
        expect(body.payees.map((p) => p.name)).toEqual(["Vermieter"]);
        expect(body.suggestions).toEqual([{ name: "Stadtwerke", iban: "DE44500105175407324931", bic: null, lastDate: "2026-11-10" }]);
        const id = body.payees[0]!.id;
        await api("DELETE", `/api/transfers/payees/${id}`);
        expect((await api<{ payees: unknown[] }>("GET", "/api/transfers/payees")).body.payees).toHaveLength(0);
    });
});
