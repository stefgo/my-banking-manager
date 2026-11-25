// Contract tests: the connector API against the simulated bank. Every answer is checked against
// the schemas in shared/src/connector-api.ts, the source of contracts/connector-api.yaml.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConnectorError, addDaysIso, connectorRoutes, firstRunFrom, todayIso } from "@mbm/shared";
import { buildApi } from "./server.js";
import { OperationStore } from "../operations/store.js";
import { httpTransport } from "../transport/http.js";
import { SIM_BLZ } from "../testing/bank-sim.js";
import { PAIN_SAVINGS, SIM_BANK_PAYEE_NAME, SIM_CARD, SIM_GIRO_IBAN, SIM_PAYEE_IBAN, SIM_PIN, SIM_TAN, SIM_USER, SIM_VOP_ID, startPersonalBank, type PaymentScript, type PersonalBank, type PersonalBankOptions } from "../testing/personal-bank.js";
import { text } from "../syntax/formats.js";

let bank: PersonalBank | undefined;
let app: FastifyInstance | undefined;
let dir: string | undefined;
let socket = "";
let now = 0;
let store: OperationStore;
/** Holds every answer of the bank back by this many milliseconds (a request stays under way). */
let slowMs = 0;

afterEach(async () => {
    await app?.close();
    await bank?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    app = bank = dir = undefined;
    slowMs = 0;
});

async function start(opts: PersonalBankOptions = {}, productId: string | null = "TESTPRODUKT") {
    bank = await startPersonalBank(opts);
    const sim = bank.url;
    now = Date.now();
    store = new OperationStore(60_000, () => now);
    const built = buildApi({
        productId,
        productVersion: "0.1",
        version: "0.1.0",
        transport: () => {
            const http = httpTransport(sim, { allowInsecure: true });
            return {
                send: async (m: Uint8Array) => {
                    const answer = await http.send(m);
                    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
                    return answer;
                },
            };
        },
        store,
        payments: { sleep: async () => undefined },
    });
    app = built.app;
    dir = mkdtempSync(path.join(tmpdir(), "mbm-fints-"));
    socket = path.join(dir, "fints.sock");
    await app.listen({ path: socket });
}

/** One call over the Unix socket, as the server will make it. */
function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = request({ socketPath: socket, method, path: url, headers: data ? { "content-type": "application/json" } : {} }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
        });
        req.on("error", reject);
        req.end(data);
    });
}

/** Calls a route and checks the answer against the contract. */
async function callRoute(name: keyof typeof connectorRoutes, body?: unknown, id?: string) {
    const def = connectorRoutes[name];
    const res = await call(def.method, def.path.replace(":id", id ?? ""), body);
    const schema: z.ZodType = res.status === 200 ? def.response : ConnectorError;
    const parsed = schema.safeParse(res.json);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    return res as { status: number; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const bankRef = { blz: SIM_BLZ, url: "https://fints.example.invalid/fints" };
const login = (extra: Record<string, unknown> = {}) => ({ userId: SIM_USER, pin: SIM_PIN, ...extra });

/** Sets up a login: TAN methods, then chooses the decoupled one. Returns the state. */
async function setupLogin(): Promise<string> {
    const res = await callRoute("tanMethods", { bank: bankRef, login: login() });
    expect(res.json.data.methods).toEqual([
        { id: "946", name: "SecureGo plus", decoupled: true, needsMedium: true },
        { id: "942", name: "mobile TAN", decoupled: false, needsMedium: false },
    ]);
    return res.json.state;
}

describe("connector API", () => {
    it("reports info and whether a product ID is configured", async () => {
        await start({}, null);
        const res = await callRoute("info");
        expect(res.json).toMatchObject({ name: "fints", productConfigured: false });
        const refused = await callRoute("tanMethods", { bank: bankRef, login: login() });
        expect(refused).toMatchObject({ status: 503, json: { error: "product_id_missing" } });
        expect(bank!.received).toHaveLength(0);
    });

    it("rejects requests outside the contract", async () => {
        await start();
        expect((await callRoute("tanMethods", { bank: { ...bankRef, url: "http://x.invalid" }, login: login() })).json.error).toBe("invalid");
        expect((await callRoute("operation", undefined, "not-a-uuid")).json.error).toBe("invalid");
        expect((await callRoute("operation", undefined, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    it("lists accounts after a decoupled approval at dialog start", async () => {
        await start({ sca: "decoupled", pendingPolls: 1 });
        const state = await setupLogin();
        const first = await callRoute("accounts", { bank: bankRef, login: login({ state, tanMethod: "946", tanMedium: "Mein Telefon" }) });
        expect(first.json).toMatchObject({ status: "approval", challenge: { decoupled: true, text: "Bitte bestätigen Sie den Vorgang in Ihrer App.", medium: "Mein Telefon" } });
        const id = first.json.operationId as string;

        // Not due yet: the connector does not ask the bank.
        const before = bank!.received.length;
        expect((await callRoute("operation", undefined, id)).json.status).toBe("approval");
        expect(bank!.received.length).toBe(before);

        now += 1500;
        expect((await callRoute("operation", undefined, id)).json.status).toBe("approval"); // 3956
        now += 1500;
        const done = await callRoute("operation", undefined, id);
        expect(done.json.status).toBe("done");
        const accounts = done.json.data.accounts;
        expect(accounts).toHaveLength(2);
        expect(accounts[0]).toMatchObject({ externalId: SIM_GIRO_IBAN, iban: SIM_GIRO_IBAN, bic: "SIMUDEM1XXX", accountNumber: "1234567", name: "Girokonto", kind: "giro", owner: "Erika Mustermann", capabilities: { balance: true, transactions: true, cardTransactions: false, transfer: false } }); // HKCCS in the UPD, but not offered in the BPD
        expect(accounts[1]).toMatchObject({ externalId: SIM_CARD, iban: null, kind: "credit_card", capabilities: { cardTransactions: true, transactions: false } });
        expect(JSON.parse(done.json.state)).toMatchObject({ systemId: "SYS4711", securityFunction: "946", upd: { version: 5 } });

        expect((await callRoute("operation", undefined, id)).status).toBe(404);
        expect(bank!.received.at(-1)?.find("HKEND")).toBeDefined();
    });

    it("fetches balances, camt transactions over two pages and card transactions", async () => {
        await start({ sca: "none" });
        const state = await setupLogin();
        const l = login({ state, tanMethod: "946", tanMedium: "Mein Telefon" });
        const giro = { accountNumber: "1234567", iban: SIM_GIRO_IBAN };
        const card = { accountNumber: SIM_CARD };

        const balances = await callRoute("balances", { bank: bankRef, login: l, accounts: [giro, card] });
        expect(balances.json.data.balances).toEqual([
            { externalId: SIM_GIRO_IBAN, booked: 220701, currency: "EUR", date: "2026-11-15", pending: -990, creditLine: 300000, available: 519711 },
            expect.objectContaining({ externalId: SIM_CARD, booked: -31250 }),
        ]);

        const tx = await callRoute("transactions", { bank: bankRef, login: l, account: giro, from: "2026-11-01" });
        expect(tx.json.data.transactions.map((t: { amount: number; status: string }) => [t.amount, t.status])).toEqual([
            [125000, "booked"],
            [-4299, "booked"],
            [-990, "pending"],
        ]);
        const cazRequests = bank!.received.filter((m) => m.find("HKCAZ"));
        expect(cazRequests.map((m) => m.find("HKCAZ")!.elements[6]?.[0] ?? "")).toEqual(["", "PAGE2"]);
        expect(cazRequests[0]!.find("HKCAZ")!.elements[3]).toEqual(["20261101"]);

        const cards = await callRoute("cardTransactions", { bank: bankRef, login: l, account: card });
        expect(cards.json.data.balance).toMatchObject({ booked: -31250 });
        expect(cards.json.data.transactions.map((t: { amount: number; counterpartyName: string }) => [t.amount, t.counterpartyName])).toEqual([
            [-5400, "Buchhandlung"],
            [-25850, "Bahn"],
        ]);
    });

    it("lists standing orders over two pages and scheduled transfers", async () => {
        await start({ sca: "none" });
        const state = await setupLogin();
        const l = login({ state, tanMethod: "946", tanMedium: "Mein Telefon" });
        const giro = { accountNumber: "1234567", iban: SIM_GIRO_IBAN };

        const accounts = await callRoute("accounts", { bank: bankRef, login: l });
        expect(accounts.json.data.accounts[0].capabilities).toMatchObject({ standingOrders: true, scheduledTransfers: true, standingOrdersTan: false, scheduledTransfersTan: false });
        expect(accounts.json.data.accounts[1].capabilities).toMatchObject({ standingOrders: false, scheduledTransfers: false });

        const standing = await callRoute("standingOrders", { bank: bankRef, login: l, account: giro });
        expect(standing.json.data.orders).toEqual([
            { bankOrderId: "DA-1", payeeName: "Hausverwaltung Muster", payeeIban: "DE89370400440532013000", payeeBic: "SIMUDEM2XXX", amount: 85000, currency: "EUR", remittance: "Miete Musterweg 1", endToEndId: null, canChange: true, canDelete: true, firstDate: "2024-01-01", unit: "month", every: 1, executionDay: 1, lastDate: null },
            expect.objectContaining({ bankOrderId: "DA-2", amount: 10050, payeeBic: "SIMUDEM2XXX", canChange: false, canDelete: false, firstDate: "2025-02-28", unit: "month", every: 3, executionDay: 99, lastDate: "2027-12-31" }),
            expect.objectContaining({ bankOrderId: "DA-3", amount: 1200, canChange: null, canDelete: null, firstDate: "2026-11-06", unit: "week", every: 2, executionDay: 5 }),
        ]);
        const requests = bank!.received.filter((m) => m.find("HKCDB")).map((m) => m.find("HKCDB")!);
        expect(requests.map((r) => r.elements[4]?.[0] ?? "")).toEqual(["", "ORDERS2"]);
        // The formats named are the bank's own (HISPAS)
        expect(requests[0]!.elements[1]).toEqual(["urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"]);

        const scheduled = await callRoute("scheduledTransfers", { bank: bankRef, login: l, account: giro });
        expect(scheduled.json.data.orders).toEqual([
            { bankOrderId: "TU-1", payeeName: "Handwerker Beispiel", payeeIban: "DE75512108001245126199", payeeBic: "SIMUDEM2XXX", amount: 43120, currency: "EUR", remittance: "Rechnung 4711", endToEndId: null, canChange: false, canDelete: null, executionDate: "2026-12-03" },
        ]);
        expect(bank!.received.find((m) => m.find("HKCSB"))!.find("HKCSB")!.version).toBe(2);
    });

    it("waits for a TAN when listing orders needs one, and says when the bank does not offer them", async () => {
        await start({ sca: "none", jobSca: "tan", ordersTan: true });
        const state = await setupLogin();
        const l = login({ state, tanMethod: "942" });
        const giro = { accountNumber: "1234567", iban: SIM_GIRO_IBAN };
        const accounts = await callRoute("accounts", { bank: bankRef, login: l });
        expect(accounts.json.data.accounts[0].capabilities).toMatchObject({ standingOrdersTan: true, scheduledTransfersTan: true });
        const waiting = await callRoute("standingOrders", { bank: bankRef, login: l, account: giro });
        expect(waiting.json.status).toBe("approval");
        // The bank asks again for the second page
        const second = await callRoute("operationTan", { tan: SIM_TAN }, waiting.json.operationId);
        expect(second.json.status).toBe("approval");
        const done = await callRoute("operationTan", { tan: SIM_TAN }, second.json.operationId);
        expect(done.json.data.orders).toHaveLength(3);

        await app?.close();
        await bank?.close();
        await start({ sca: "none", noOrders: true });
        const l2 = login({ state: await setupLogin(), tanMethod: "946", tanMedium: "Mein Telefon" });
        const refused = await callRoute("scheduledTransfers", { bank: bankRef, login: l2, account: giro });
        expect(refused.status).not.toBe(200);
        expect(refused.json.error).toBe("not_supported");
    });

    it("falls back to MT940 and waits for a TAN at the job", async () => {
        await start({ sca: "none", jobSca: "tan", noCamt: true });
        const state = await setupLogin();
        const l = login({ state, tanMethod: "942" });
        const first = await callRoute("transactions", { bank: bankRef, login: l, account: { accountNumber: "1234567", iban: SIM_GIRO_IBAN } });
        expect(first.json).toMatchObject({ status: "approval", challenge: { decoupled: false, text: "Bitte TAN eingeben." } });
        const done = await callRoute("operationTan", { tan: SIM_TAN }, first.json.operationId);
        expect(done.json.status).toBe("done");
        expect(done.json.data.transactions).toHaveLength(2);
        expect(bank!.signatures.some((s) => s[1] === SIM_TAN)).toBe(true);
    });

    it("cancels an operation and ends its dialog", async () => {
        await start({ sca: "decoupled" });
        const state = await setupLogin();
        const first = await callRoute("accounts", { bank: bankRef, login: login({ state, tanMethod: "946" }) });
        const id = first.json.operationId as string;
        expect((await callRoute("cancelOperation", undefined, id)).json).toEqual({ ok: true });
        expect(bank!.received.at(-1)?.find("HKEND")).toBeDefined();
        expect((await callRoute("operation", undefined, id)).status).toBe(404);
    });

    it("maps bank errors", async () => {
        await start();
        const wrong = await callRoute("tanMethods", { bank: bankRef, login: login({ pin: "00000" }) });
        expect(wrong).toMatchObject({ status: 422, json: { error: "pin_wrong", bankCodes: [{ code: "9942", text: "PIN ungültig." }] } });
        const state = await setupLogin();
        const noMethod = await callRoute("accounts", { bank: bankRef, login: login({ state }) });
        expect(noMethod).toMatchObject({ status: 409, json: { error: "no_tan_method" } });
        const unknownMethod = await callRoute("accounts", { bank: bankRef, login: login({ state, tanMethod: "999" }) });
        expect(unknownMethod.status).toBe(409);
    });

    it("reads the TAN media; the strong authentication refers to HKTAB", async () => {
        await start({ sca: "none" });
        const state = await setupLogin();
        const res = await callRoute("tanMedia", { bank: bankRef, login: login({ state, tanMethod: "946" }) });
        expect(res.json).toMatchObject({ status: "done", data: { media: [{ name: "Mein Telefon", active: true }, { name: "Altes Telefon", active: false }] } });
        expect(bank!.received.find((m) => m.find("HKTAN")?.elements[1]?.[0] === "HKTAB")).toBeDefined();
    });

    it("reports a job error when reading the TAN media instead of an empty list (9075)", async () => {
        await start({ sca: "none", jobError: ["9075", "Dialog abgebrochen - starke Authentifizierung erforderlich."] });
        const state = await setupLogin();
        const res = await callRoute("tanMedia", { bank: bankRef, login: login({ state, tanMethod: "946" }) });
        expect(res).toMatchObject({ status: 422, json: { error: "bank_error", bankCodes: [{ code: "9075" }] } });
    });
});

describe("transfers", () => {
    const account = { accountNumber: "1234567", subAccount: "", iban: SIM_GIRO_IBAN, bic: "SIMUDEM1XXX" };
    const transfer = (extra: Record<string, unknown> = {}) => ({
        payeeName: "Erika Mustermann",
        payeeIban: SIM_PAYEE_IBAN,
        payeeBic: null,
        amount: 100,
        remittance: "Test MBM",
        endToEndId: "MBM-0123456789abcdefghijklmnopqrstu",
        instant: false,
        ...extra,
    });

    /** Starts a bank with payments (no SCA at dialog start) and submits one transfer. */
    async function submit(script: PaymentScript, opts: { tan?: boolean; transfer?: Record<string, unknown> } = {}) {
        await start({ sca: "none", jobSca: opts.tan ? "tan" : "decoupled", payments: script });
        const state = await setupLogin();
        const method = opts.tan ? { tanMethod: "942" } : { tanMethod: "946", tanMedium: "Mein Telefon" };
        return callRoute("transfer", { bank: bankRef, login: login({ state, ...method }), account, transfer: transfer(opts.transfer) });
    }

    /** Queries a decoupled approval until the bank's answer is there. */
    async function approveDecoupled(id: string) {
        now += 1500;
        return callRoute("operation", undefined, id);
    }

    const sentWith = (id: string) => bank!.received.filter((m) => m.find(id));

    it("sends HKVPP before the payment, the approval refers to the payment, and the result comes along (match, 3091)", async () => {
        const first = await submit({ vop: "match" });
        expect(first.json).toMatchObject({ status: "approval", challenge: { decoupled: true }, vop: { result: "match", payeeName: null } });
        const [m] = sentWith("HKCCS");
        const order = m!.segments.map((x) => x.id).filter((id) => /^HK/.test(id));
        expect(order).toEqual(["HKVPP", "HKCCS", "HKTAN"]);
        expect(text(m!.find("HKTAN")!.elements[1])).toBe("HKCCS");
        const pain = Buffer.from(m!.find("HKCCS")!.elements[2]![0] as Uint8Array).toString("utf8");
        expect(pain).toContain("<Dbtr><Nm>Erika Mustermann</Nm></Dbtr>");
        expect(pain).toContain("<EndToEndId>MBM-0123456789abcdefghijklmnopqrstu</EndToEndId>");

        const done = await approveDecoupled(first.json.operationId);
        expect(done.json).toMatchObject({ status: "done", data: { bankMessage: "Auftrag zur Ausführung vorgemerkt.", reference: "REF-0815", vop: { result: "match" }, unconfirmed: false } });
        expect(bank!.executed).toBe(1);
        expect(sentWith("HKVPA")).toHaveLength(0);
    });

    it("sends HKVPA with the approval when the bank does not say 3091", async () => {
        const first = await submit({ vop: "match_vpa" });
        const done = await approveDecoupled(first.json.operationId);
        expect(done.json.status).toBe("done");
        expect(text(sentWith("HKVPA")[0]!.find("HKVPA")!.elements[0])).toBe(SIM_VOP_ID);
        expect(bank!.executed).toBe(1);
    });

    it("waits for the user on a close match, then sends HKVPA with the same payment", async () => {
        const first = await submit({ vop: "close" });
        expect(first.json).toEqual({
            status: "confirm",
            operationId: expect.any(String),
            vop: { result: "close_match", payeeName: SIM_BANK_PAYEE_NAME, reason: null, explanation: "<p>Der Name weicht ab.</p><b>Bitte prüfen.</b>", structured: true },
        });
        expect((await callRoute("operation", undefined, first.json.operationId)).json.status).toBe("confirm");
        expect(bank!.executed).toBe(0);

        const approval = await callRoute("confirmOperation", undefined, first.json.operationId);
        expect(approval.json).toMatchObject({ status: "approval", vop: { result: "close_match" } });
        const [again] = sentWith("HKVPA");
        expect(again!.segments.map((x) => x.id).filter((id) => /^HK/.test(id))).toEqual(["HKVPA", "HKCCS", "HKTAN"]);
        const pains = sentWith("HKCCS").map((m) => text(m.find("HKCCS")!.elements[2]));
        expect(pains[1]).toBe(pains[0]);

        const done = await approveDecoupled(approval.json.operationId);
        expect(done.json.status).toBe("done");
        expect(bank!.executed).toBe(1);
    });

    it("reads the result from a pain.002", async () => {
        const first = await submit({ vop: "pain002_close" });
        expect(first.json.vop).toMatchObject({ result: "close_match", payeeName: SIM_BANK_PAYEE_NAME });
    });

    it("reports no match and not applicable; cancelling sends nothing more", async () => {
        const first = await submit({ vop: "no_match" });
        expect(first.json).toMatchObject({ status: "confirm", vop: { result: "no_match" } });
        const before = sentWith("HKCCS").length;
        expect((await callRoute("cancelOperation", undefined, first.json.operationId)).json).toEqual({ ok: true });
        expect(sentWith("HKCCS")).toHaveLength(before);
        expect(bank!.received.at(-1)?.find("HKEND")).toBeDefined();
        expect(bank!.executed).toBe(0);
        await app!.close();
        await bank!.close();
        const na = await submit({ vop: "not_applicable" });
        expect(na.json.vop).toMatchObject({ result: "not_applicable", reason: "Keine Antwort der Empfängerbank" });
    });

    it("asks again with the polling ID, then goes on with HKVPA when the name matches", async () => {
        const first = await submit({ vop: "polling" });
        expect(first.json).toMatchObject({ status: "approval", vop: { result: "match" } });
        const polls = bank!.received.filter((m) => m.find("HKVPP") && !m.find("HKCCS"));
        expect(polls).toHaveLength(1);
        expect(text(polls[0]!.find("HKVPP")!.elements[1])).toBe("POLL-1");
        expect(text(polls[0]!.find("HKVPP")!.elements[3])).toBe("VOPTD");
        expect(sentWith("HKVPA")).toHaveLength(1);
        expect((await approveDecoupled(first.json.operationId)).json.status).toBe("done");
    });

    it("never reports a payment as done, nor sends it again, when the answer to a poll looks like an acceptance", async () => {
        const res = await submit({ vop: "polling_3076" });
        expect(res).toMatchObject({ status: 502, json: { error: "outcome_unknown" } });
        expect(bank!.received.filter((m) => m.find("HKVPP") && !m.find("HKCCS"))).toHaveLength(1);
        expect(sentWith("HKCCS")).toHaveLength(1);
        expect(sentWith("HKVPA")).toHaveLength(0);
        expect(bank!.executed).toBe(0);
    });

    it("is done at once when the bank needs no approval", async () => {
        const res = await submit({ vop: "bagatelle" });
        expect(res.json).toMatchObject({ status: "done", data: { vop: { result: "match" } } });
        expect(bank!.executed).toBe(1);
    });

    it("sends without HKVPP to a bank that does not verify payees", async () => {
        const first = await submit({ vop: "off" });
        expect(first.json).toMatchObject({ status: "approval", vop: { result: "none" } });
        expect(sentWith("HKVPP")).toHaveLength(0);
        expect((await approveDecoupled(first.json.operationId)).json.status).toBe("done");
    });

    it("works with a TAN instead of an app approval", async () => {
        const first = await submit({ vop: "match" }, { tan: true });
        expect(first.json).toMatchObject({ status: "approval", challenge: { decoupled: false } });
        const done = await callRoute("operationTan", { tan: SIM_TAN }, first.json.operationId);
        expect(done.json.status).toBe("done");
        expect(bank!.executed).toBe(1);
    });

    it("answers a TAN under way before cancelling: cancelling never cuts it off", async () => {
        const first = await submit({ vop: "match" }, { tan: true });
        const id = first.json.operationId as string;
        slowMs = 200;
        const tan = callRoute("operationTan", { tan: SIM_TAN }, id);
        await new Promise((r) => setTimeout(r, 50));
        const cancel = callRoute("cancelOperation", undefined, id);
        expect((await tan).json).toMatchObject({ status: "done" });
        expect((await cancel).status).toBe(404);
        expect(bank!.executed).toBe(1);
    });

    it("keeps an operation whose TAN is under way although its time runs out meanwhile", async () => {
        const first = await submit({ vop: "match" }, { tan: true });
        const id = first.json.operationId as string;
        slowMs = 200;
        const tan = callRoute("operationTan", { tan: SIM_TAN }, id);
        await new Promise((r) => setTimeout(r, 50));
        now += 61_000;
        await store.sweep();
        expect((await tan).json).toMatchObject({ status: "done" });
        expect(bank!.executed).toBe(1);
        expect(store.size).toBe(0);
    });

    it("passes the bank's refusal on", async () => {
        const first = await submit({ vop: "match", reject: ["9230", "Unzureichendes Guthaben des Kontos."] });
        const res = await approveDecoupled(first.json.operationId);
        expect(res).toMatchObject({ status: 422, json: { error: "bank_error", bankCodes: [{ code: "9230" }] } });
        expect(bank!.executed).toBe(0);
    });

    it("reports outcome unknown when the answer to the approval is lost, and sends nothing again", async () => {
        const first = await submit({ vop: "match", dropOnExecute: true });
        const res = await approveDecoupled(first.json.operationId);
        expect(res).toMatchObject({ status: 502, json: { error: "outcome_unknown" } });
        expect(bank!.executed).toBe(1);
        expect(sentWith("HKCCS")).toHaveLength(1);
        expect((await callRoute("operation", undefined, first.json.operationId)).status).toBe(404);
    });

    it("sends instant transfers with HKIPZ and never lets the bank turn them into standard ones", async () => {
        const first = await submit({ vop: "match", unconfirmed: true }, { transfer: { instant: true } });
        const [m] = sentWith("HKIPZ");
        expect(m!.find("HKIPZ")!.version).toBe(2);
        expect(text(m!.find("HKIPZ")!.elements[3])).toBe("N");
        expect(Buffer.from(m!.find("HKIPZ")!.elements[2]![0] as Uint8Array).toString("utf8")).toContain("<LclInstrm><Cd>INST</Cd></LclInstrm>");
        const done = await approveDecoupled(first.json.operationId);
        expect(done.json).toMatchObject({ status: "done", data: { reference: "IPZ-77", unconfirmed: true } });
    });

    it("reports the new capabilities with the accounts", async () => {
        await start({ sca: "none", payments: { vop: "match" } });
        const state = await setupLogin();
        const res = await callRoute("accounts", { bank: bankRef, login: login({ state, tanMethod: "946", tanMedium: "Mein Telefon" }) });
        expect(res.json.data.accounts[0].capabilities).toMatchObject({ transfer: true, instantTransfer: true, payeeVerification: true });
        expect((await callRoute("info")).json.capabilities).toContain("transfers");
    });
});

describe("writing orders", () => {
    const account = { accountNumber: "1234567", subAccount: "", iban: SIM_GIRO_IBAN, bic: "SIMUDEM1XXX" };
    const payment = { payeeName: "Erika Mustermann", payeeIban: SIM_PAYEE_IBAN, payeeBic: null, amount: 100, remittance: "Test MBM", endToEndId: "MBM-0123456789abcdefghijklmnopqrstu" };
    const today = todayIso();
    const rent = { bankOrderId: "DA-1", payeeName: "Hausverwaltung Muster", payeeIban: "DE89370400440532013000", amount: 85000, remittance: "Miete Musterweg 1", firstDate: "2024-01-01", unit: "month", every: 1, executionDay: 1, lastDate: null };
    const savings = { bankOrderId: "DA-2", payeeName: "Erika Mustermann", payeeIban: "DE44500105175407324931", amount: 10050, remittance: "Sparen", firstDate: "2025-02-28", unit: "month", every: 3, executionDay: 99, lastDate: "2027-12-31" };
    const handwerker = { bankOrderId: "TU-1", payeeName: "Handwerker Beispiel", payeeIban: "DE75512108001245126199", amount: 43120, remittance: "Rechnung 4711", executionDate: "2026-12-03" };

    async function begin(script: PaymentScript = { vop: "match" }) {
        await start({ sca: "none", jobSca: "decoupled", payments: script, orderWrites: true });
        const state = await setupLogin();
        return login({ state, tanMethod: "946", tanMedium: "Mein Telefon" });
    }
    const approve = async (id: string) => {
        now += 1500;
        return callRoute("operation", undefined, id);
    };
    const sentWith = (id: string) => bank!.received.filter((m) => m.find(id));
    const jobsOf = (m: { segments: { id: string }[] }) => m.segments.map((x) => x.id).filter((id) => /^HK/.test(id));

    it("reports what the account may do with orders and the bank's rules", async () => {
        const l = await begin();
        const res = await callRoute("accounts", { bank: bankRef, login: l });
        expect(res.json.data.accounts[0].capabilities).toMatchObject({
            createScheduledTransfer: true, changeScheduledTransfer: true, deleteScheduledTransfer: true, createStandingOrder: true, changeStandingOrder: true, deleteStandingOrder: true,
            orderRules: { scheduled: { minDays: 1, maxDays: 360 }, standing: { months: [1, 2, 3, 6, 12], weeks: [] }, standingChange: { changeable: { unit: false, amount: true } } },
        });
        expect(res.json.data.accounts[1].capabilities).toMatchObject({ createStandingOrder: false, orderRules: null });
        expect((await callRoute("info")).json.capabilities).toContain("order-writes");
    });

    it("submits a scheduled transfer with the verification of payee; the bank holds it afterwards", async () => {
        const l = await begin();
        const date = addDaysIso(today, 10);
        const first = await callRoute("createScheduledTransfer", { bank: bankRef, login: l, account, order: { ...payment, executionDate: date } });
        expect(first.json).toMatchObject({ status: "approval", vop: { result: "match" } });
        const [m] = sentWith("HKCSE");
        expect(jobsOf(m!)).toEqual(["HKVPP", "HKCSE", "HKTAN"]);
        expect(text(m!.find("HKTAN")!.elements[1])).toBe("HKCSE");
        expect(Buffer.from(m!.find("HKCSE")!.elements[2]![0] as Uint8Array).toString("utf8")).toContain(`<ReqdExctnDt><Dt>${date}</Dt></ReqdExctnDt>`);
        const done = await approve(first.json.operationId);
        expect(done.json).toMatchObject({ status: "done", data: { bankOrderId: "TU-10", vop: { result: "match" } } });
        expect(bank!.orders.scheduled.map((t) => t.id)).toEqual(["TU-1", "TU-10"]);
    });

    it("refuses a date the bank does not allow before sending anything", async () => {
        const l = await begin();
        const res = await callRoute("createScheduledTransfer", { bank: bankRef, login: l, account, order: { ...payment, executionDate: today } });
        expect(res).toMatchObject({ status: 422, json: { error: "not_supported" } });
        expect(res.json.message).toMatch(/^Ausführung: frühestens am /);
        expect(sentWith("HKCSE")).toHaveLength(0);
        const weekly = await callRoute("createStandingOrder", { bank: bankRef, login: l, account, order: { ...payment, recurrence: { firstDate: firstRunFrom({ unit: "week", executionDay: 1 }, addDaysIso(today, 1)), unit: "week", every: 1, executionDay: 1, lastDate: null } } });
        expect(weekly.json.message).toBe("Wöchentliche Daueraufträge bietet die Bank nicht an.");
    });

    it("sets up a standing order with its rhythm in the Dauerauftragdetails", async () => {
        const l = await begin();
        const firstDate = firstRunFrom({ unit: "month", executionDay: 99 }, addDaysIso(today, 1));
        const first = await callRoute("createStandingOrder", { bank: bankRef, login: l, account, order: { ...payment, recurrence: { firstDate, unit: "month", every: 3, executionDay: 99, lastDate: null } } });
        expect(first.json.status).toBe("approval");
        const seg = sentWith("HKCDE")[0]!.find("HKCDE")!;
        expect(seg.elements[3]).toEqual([firstDate.replaceAll("-", ""), "M", "3", "99"]);
        expect(Buffer.from(seg.elements[2]![0] as Uint8Array).toString("utf8")).toContain("<ReqdExctnDt><Dt>1999-01-01</Dt></ReqdExctnDt>");
        const done = await approve(first.json.operationId);
        expect(done.json.data).toMatchObject({ bankOrderId: "DA-10", bankMessage: "Auftrag zur Ausführung vorgemerkt." });
        expect(bank!.orders.standing.at(-1)).toMatchObject({ id: "DA-10", details: [firstDate.replaceAll("-", ""), "M", "3", "99"] });
    });

    it("changes a standing order: lists it first in the same dialog, then sends the complete new order", async () => {
        const l = await begin();
        const first = await callRoute("changeStandingOrder", { bank: bankRef, login: l, account, expected: rent, order: { ...payment, payeeName: rent.payeeName, payeeIban: rent.payeeIban, remittance: rent.remittance, amount: 90000, recurrence: { firstDate: rent.firstDate, unit: "month", every: 1, executionDay: 1, lastDate: null } } });
        expect(first.json.status).toBe("approval");
        const dialog = bank!.received.filter((m) => m.find("HKCDB") || m.find("HKCDN"));
        expect(dialog.map(jobsOf)).toEqual([["HKCDB"], ["HKCDB"], ["HKVPP", "HKCDN", "HKTAN"]]);
        expect(new Set(dialog.map((m) => m.dialogId)).size).toBe(1);
        const seg = dialog[2]!.find("HKCDN")!;
        expect(text(seg.elements[4])).toBe("DA-1");
        expect(seg.elements[5]).toEqual(["20240101", "M", "1", "1"]);
        expect(text(seg.elements[1])).toBe("urn:iso:std:iso:20022:tech:xsd:pain.001.001.09");
        const done = await approve(first.json.operationId);
        expect(done.json.data).toMatchObject({ bankOrderId: "DA-1", bankMessage: "SEPA-Dauerauftrag geändert." });
        expect(bank!.orders.standing[0]!.pain).toContain("<InstdAmt Ccy=\"EUR\">900.00</InstdAmt>");
    });

    it("sends nothing when the order is no longer what the user saw, or the change touches what the bank keeps", async () => {
        const l = await begin();
        const changed = await callRoute("changeStandingOrder", { bank: bankRef, login: l, account, expected: { ...rent, amount: 80000 }, order: { ...payment, recurrence: { firstDate: rent.firstDate, unit: "month", every: 1, executionDay: 1, lastDate: null } } });
        expect(changed).toMatchObject({ status: 409, json: { error: "order_changed" } });
        const gone = await callRoute("deleteScheduledTransfer", { bank: bankRef, login: l, account, expected: { ...handwerker, bankOrderId: "TU-99" } });
        expect(gone.json.error).toBe("order_changed");
        const unit = await callRoute("changeStandingOrder", { bank: bankRef, login: l, account, expected: rent, order: { ...payment, payeeName: rent.payeeName, payeeIban: rent.payeeIban, amount: rent.amount, remittance: rent.remittance, recurrence: { firstDate: rent.firstDate, unit: "week", every: 1, executionDay: 1, lastDate: null } } });
        expect(unit.json).toMatchObject({ error: "not_supported", message: "Die Bank erlaubt nicht, Zeiteinheit zu ändern." });
        expect(sentWith("HKCDN")).toHaveLength(0);
        expect(sentWith("HKCSL")).toHaveLength(0);
        expect(bank!.executed).toBe(0);
    });

    it("deletes a standing order with the data and details exactly as the bank listed them, without verification of payee", async () => {
        const l = await begin();
        const first = await callRoute("deleteStandingOrder", { bank: bankRef, login: l, account, expected: savings });
        expect(first.json).toMatchObject({ status: "approval" });
        const m = sentWith("HKCDL")[0]!;
        expect(jobsOf(m)).toEqual(["HKCDL", "HKTAN"]);
        const seg = m.find("HKCDL")!;
        expect(text(seg.elements[4])).toBe("DA-2");
        expect(seg.elements[5]).toEqual(["20250230", "M", "3", "31", "20271231"]);
        expect(Buffer.from(seg.elements[2]![0] as Uint8Array).toString("utf8")).toBe(PAIN_SAVINGS);
        const done = await approve(first.json.operationId);
        expect(done.json).toMatchObject({ status: "done", data: { bankMessage: "SEPA-Dauerauftrag gelöscht.", bankOrderId: null, vop: { result: "none" } } });
        expect(bank!.orders.standing.map((d) => d.id)).toEqual(["DA-1", "DA-3"]);
    });

    it("changes and deletes a scheduled transfer", async () => {
        const l = await begin();
        const date = addDaysIso(today, 20);
        const change = await callRoute("changeScheduledTransfer", { bank: bankRef, login: l, account, expected: handwerker, order: { ...payment, payeeName: handwerker.payeeName, payeeIban: handwerker.payeeIban, amount: 50000, remittance: handwerker.remittance, executionDate: date } });
        expect(change.json.status).toBe("approval");
        expect(jobsOf(sentWith("HKCSA")[0]!)).toEqual(["HKVPP", "HKCSA", "HKTAN"]);
        expect((await approve(change.json.operationId)).json.data).toMatchObject({ bankOrderId: "TU-1" });
        expect(bank!.orders.scheduled[0]!.pain).toContain(`<Dt>${date}</Dt>`);

        const del = await callRoute("deleteScheduledTransfer", { bank: bankRef, login: l, account, expected: { ...handwerker, amount: 50000, executionDate: date } });
        const seg = sentWith("HKCSL")[0]!.find("HKCSL")!;
        expect(text(seg.elements[3])).toBe("TU-1");
        expect(seg.elements[2]?.[0]).toBeInstanceOf(Uint8Array);
        expect((await approve(del.json.operationId)).json.data.bankMessage).toBe("Auftrag gelöscht.");
        expect(bank!.orders.scheduled).toEqual([]);
    });

    it("waits for the user on a close match, like a transfer", async () => {
        const l = await begin({ vop: "close" });
        const first = await callRoute("createScheduledTransfer", { bank: bankRef, login: l, account, order: { ...payment, executionDate: addDaysIso(today, 5) } });
        expect(first.json).toMatchObject({ status: "confirm", vop: { result: "close_match" } });
        const approval = await callRoute("confirmOperation", undefined, first.json.operationId);
        expect(jobsOf(sentWith("HKVPA")[0]!)).toEqual(["HKVPA", "HKCSE", "HKTAN"]);
        expect((await approve(approval.json.operationId)).json.status).toBe("done");
    });

    it("reports outcome unknown when the answer is lost after sending, and passes a refusal on", async () => {
        const l = await begin({ vop: "match", dropOnExecute: true });
        const first = await callRoute("deleteStandingOrder", { bank: bankRef, login: l, account, expected: rent });
        const res = await approve(first.json.operationId);
        expect(res).toMatchObject({ status: 502, json: { error: "outcome_unknown" } });
        // The bank did delete it
        expect(bank!.orders.standing.map((d) => d.id)).toEqual(["DA-2", "DA-3"]);
        expect(sentWith("HKCDL")).toHaveLength(1);

        await app!.close();
        await bank!.close();
        const l2 = await begin({ vop: "match", reject: ["9210", "Mindestzeitraum bis zum Ausführungstermin überschritten."] });
        const refused = await callRoute("createScheduledTransfer", { bank: bankRef, login: l2, account, order: { ...payment, executionDate: addDaysIso(today, 2) } });
        expect((await approve(refused.json.operationId))).toMatchObject({ status: 422, json: { error: "bank_error", bankCodes: [{ code: "9210" }] } });
    });
});
