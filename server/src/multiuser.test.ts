// Several users at the same time, with the FinTS connector embedded in the server's process
// (image mbm-server-full): the real connector against the simulated bank, never a real one.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createEmbeddedConnector } from "@mbm/connector-fints/embedded";
import { httpTransport, SIM_BLZ, SIM_GIRO_IBAN, SIM_PAYEE_IBAN, SIM_PIN, SIM_TAN, SIM_USER, startPersonalBank, type PersonalBank, type PersonalBankOptions } from "@mbm/connector-fints/testing";
import type { EmbeddedLoader } from "./connectors/client.js";
import { confirmCode, createTestApp, setUpSignedIn, signInCreatedUser, type TestApp } from "./testing/testApp.js";

type Api = Awaited<ReturnType<typeof setUpSignedIn>>["api"];
type Run = { id: string; status: string; error: string | null; message: string | null; newTransactions: number; challenge: { decoupled: boolean } | null };

const URL_A = "https://sim-a.example.invalid/fints";
const URL_B = "https://sim-b.example.invalid/fints";

let t: TestApp | undefined;
let banks: PersonalBank[] = [];

afterEach(async () => {
    await t?.close();
    await Promise.all(banks.map((b) => b.close()));
    t = undefined;
    banks = [];
});

/**
 * A server with the embedded connector; each FinTS address reaches its own simulated bank, an
 * address mapped to "broken" fails every request inside the connector.
 */
async function start(sims: Record<string, PersonalBankOptions | "broken">) {
    const targets = new Map<string, string | "broken">();
    for (const [url, o] of Object.entries(sims)) {
        if (o === "broken") {
            targets.set(url, "broken");
            continue;
        }
        const bank = await startPersonalBank(o);
        banks.push(bank);
        targets.set(url, bank.url);
    }
    const loadEmbeddedConnector: EmbeddedLoader = () =>
        createEmbeddedConnector({ MBM_FINTS_PRODUCT_ID: "TESTPRODUKT" }, {
            transport: (url: string) => {
                const target = targets.get(url);
                if (!target) throw new Error(`no simulated bank for ${url}`);
                if (target === "broken") return { send: async () => Promise.reject(new Error("broken on purpose")) };
                return httpTransport(target, { allowInsecure: true });
            },
        });
    t = await createTestApp({ connectors: { fints: { embedded: true } }, bankPollMs: 20 }, { loadEmbeddedConnectors: { fints: loadEmbeddedConnector } });
    const anna = await setUpSignedIn(t);
    const created = await anna.api<{ id: number }>("POST", "/api/users", { name: "Ben", password: "bens-langes-passwort", code: confirmCode(t, anna.secret) });
    expect(created.status).toBe(200);
    const ben = await signInCreatedUser(t, "Ben", "bens-langes-passwort");
    return { anna: anna.api, ben: ben.api, targets };
}

/** The bank access at `url` with the user's own login; takes over the giro account. */
async function setUpAccess(api: Api, url: string): Promise<{ connectionId: number; giro: number }> {
    const conn = await api<{ id: number }>("POST", "/api/bank-connections", { blz: SIM_BLZ, fintsUrl: url });
    expect(conn.status, JSON.stringify(conn.body)).toBe(200);
    const id = conn.body.id;
    expect((await api("PUT", `/api/bank-connections/${id}/login`, { loginName: SIM_USER, pin: SIM_PIN, savePin: true })).status).toBe(200);
    expect((await api("PUT", `/api/bank-connections/${id}/login/tan-method`, { tanMethod: "942" })).status).toBe(200);
    const offered = await api<unknown>("POST", `/api/bank-connections/${id}/login/accounts`);
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    const taken = await api("POST", `/api/bank-connections/${id}/accounts`, { accounts: [{ externalId: SIM_GIRO_IBAN }] });
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    // The giro account of this connection: a second user on the same connection gets the same one
    const giro = t!.vault.database
        .prepare("SELECT la.account_id AS id FROM bank_login_accounts la JOIN bank_logins l ON l.id = la.login_id JOIN accounts a ON a.id = la.account_id WHERE l.connection_id = ? AND a.iban = ? LIMIT 1")
        .get(id, SIM_GIRO_IBAN) as { id: number };
    return { connectionId: id, giro: giro.id };
}

async function waitFor(api: Api, pred: (runs: Run[]) => boolean): Promise<Run[]> {
    for (let i = 0; i < 500; i++) {
        const { body } = await api<Run[]>("GET", "/api/sync");
        if (pred(body)) return body;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout waiting for sync");
}

const runOf = (runs: Run[], id: string) => runs.find((r) => r.id === id);

/** Hands in a TAN whenever the run waits for one, until it ends. */
async function approveUntilDone(api: Api, id: string): Promise<Run> {
    for (let i = 0; i < 20; i++) {
        const run = runOf(await waitFor(api, (r) => runOf(r, id)?.status !== "running"), id)!;
        if (run.status !== "approval") return run;
        expect((await api("POST", `/api/sync/${id}/tan`, { tan: SIM_TAN })).status).toBe(200);
    }
    throw new Error("the run kept asking for a TAN");
}

describe("several users with the embedded connector", () => {
    it("fetch the same account at the same time without duplicates", async () => {
        const { anna, ben } = await start({ [URL_A]: { sca: "none" } });
        const a = await setUpAccess(anna, URL_A);
        const b = await setUpAccess(ben, URL_A);
        expect(b.giro).toBe(a.giro);

        const [startedA, startedB] = await Promise.all([anna<Run[]>("POST", "/api/sync", { accountId: a.giro }), ben<Run[]>("POST", "/api/sync", { accountId: b.giro })]);
        const idA = startedA.body[0]!.id;
        const idB = startedB.body[0]!.id;
        expect(idA).not.toBe(idB);
        const doneA = runOf(await waitFor(anna, (r) => runOf(r, idA)?.status === "done"), idA)!;
        const doneB = runOf(await waitFor(ben, (r) => runOf(r, idB)?.status === "done"), idB)!;
        expect(doneA.error).toBeNull();
        expect(doneB.error).toBeNull();

        const db = t!.vault.database;
        const rows = () => db.prepare("SELECT amount, status, counterparty_name AS name, booking_date AS date FROM transactions WHERE account_id = ? ORDER BY id").all(a.giro) as { amount: number; status: string; name: string; date: string }[];
        const after = rows();
        expect(after.length).toBeGreaterThan(0);
        // No booking twice, and each booked one was taken over by exactly one of the two runs
        expect(new Set(after.map((r) => JSON.stringify(r))).size).toBe(after.length);
        expect(doneA.newTransactions + doneB.newTransactions).toBe(after.filter((r) => r.status === "booked").length);

        // A later fetch finds nothing new
        const again = (await anna<Run[]>("POST", "/api/sync", { accountId: a.giro })).body[0]!.id;
        expect(runOf(await waitFor(anna, (r) => runOf(r, again)?.status === "done"), again)).toMatchObject({ newTransactions: 0, error: null });
        expect(rows()).toEqual(after);
    });

    it("keep their approvals apart: nobody hands in or cancels the TAN of another", async () => {
        const { anna, ben } = await start({ [URL_A]: { sca: "none", jobSca: "tan" }, [URL_B]: { sca: "none", jobSca: "tan" } });
        const a = await setUpAccess(anna, URL_A);
        const b = await setUpAccess(ben, URL_B);

        const [startedA, startedB] = await Promise.all([anna<Run[]>("POST", "/api/sync", { connectionId: a.connectionId }), ben<Run[]>("POST", "/api/sync", { connectionId: b.connectionId })]);
        const idA = startedA.body[0]!.id;
        const idB = startedB.body[0]!.id;
        await waitFor(anna, (r) => runOf(r, idA)?.status === "approval");
        await waitFor(ben, (r) => runOf(r, idB)?.status === "approval");

        // Ben neither sees nor reaches Anna's run
        expect((await ben<Run[]>("GET", "/api/sync")).body.map((r) => r.id)).toEqual([idB]);
        expect((await ben("POST", `/api/sync/${idA}/tan`, { tan: SIM_TAN })).status).toBe(404);
        expect((await ben("DELETE", `/api/sync/${idA}`)).status).toBe(404);
        expect(runOf((await anna<Run[]>("GET", "/api/sync")).body, idA)?.status).toBe("approval");

        // Each goes on with the own TANs (one per job that needs one), at the same time
        const [doneA, doneB] = await Promise.all([approveUntilDone(anna, idA), approveUntilDone(ben, idB)]);
        expect(doneA).toMatchObject({ error: null });
        expect(doneB).toMatchObject({ error: null });
        expect(doneA.newTransactions).toBeGreaterThan(0);
    });

    it("keep a failure inside the connector to the request it belongs to", async () => {
        const { anna, ben, targets } = await start({ [URL_A]: { sca: "none" }, [URL_B]: { sca: "none" } });
        const a = await setUpAccess(anna, URL_A);
        const b = await setUpAccess(ben, URL_B);
        // From now on every request to Ben's bank fails inside the connector
        targets.set(URL_B, "broken");

        const [startedA, startedB] = await Promise.all([anna<Run[]>("POST", "/api/sync", { connectionId: a.connectionId }), ben<Run[]>("POST", "/api/sync", { connectionId: b.connectionId })]);
        const idA = startedA.body[0]!.id;
        const idB = startedB.body[0]!.id;
        const failed = runOf(await waitFor(ben, (r) => runOf(r, idB)?.status === "error"), idB)!;
        expect(failed.error).not.toBeNull();
        const done = runOf(await waitFor(anna, (r) => runOf(r, idA)?.status === "done"), idA)!;
        expect(done).toMatchObject({ error: null });
        expect(done.newTransactions).toBeGreaterThan(0);
        // The connector still answers
        expect((await anna<{ name: string; reachable: boolean }[]>("GET", "/api/connectors")).body).toEqual([expect.objectContaining({ name: "fints", reachable: true })]);
    });
});

describe("one login, a fetch and a transfer at the same time", () => {
    it("lose nothing of the login: both end, the state stays usable, the TAN method stays", async () => {
        const { anna } = await start({ [URL_A]: { sca: "none", payments: { vop: "match" } } });
        const a = await setUpAccess(anna, URL_A);
        const db = t!.vault.database;
        const bank = banks[0]!;
        // Setting up the login already synchronised: the customer system ID is in the stored state
        const hksyn = () => bank.received.filter((m) => m.segments.some((x) => x.id === "HKSYN")).length;
        const synced = hksyn();
        expect(synced).toBeGreaterThan(0);

        const [sync, transfer] = await Promise.all([
            anna<Run[]>("POST", "/api/sync", { accountId: a.giro }),
            anna<{ id: number }>("POST", "/api/transfers", { requestId: randomUUID(), accountId: a.giro, payeeName: "Erika Mustermann", payeeIban: SIM_PAYEE_IBAN, amount: 100, remittance: "Test über MBM" }),
        ]);
        expect(transfer.status, JSON.stringify(transfer.body)).toBe(200);
        const id = sync.body[0]!.id;
        expect(runOf(await waitFor(anna, (r) => runOf(r, id)?.status === "done"), id)).toMatchObject({ error: null });
        let sent = { status: "" };
        for (let i = 0; i < 500 && ["", "submitting"].includes(sent.status); i++) {
            sent = (await anna<{ status: string }>("GET", `/api/transfers/${transfer.body.id}`)).body;
            await new Promise((r) => setTimeout(r, 10));
        }
        expect(sent.status).toBe("executed");
        expect(bank.executed).toBe(1);

        // TAN method and medium live in their own columns, not in the state either of them stored
        expect(db.prepare("SELECT tan_method, status FROM bank_logins").get()).toEqual({ tan_method: "942", status: "ready" });
        // Whichever state was stored last works and keeps the customer system ID
        const again = (await anna<Run[]>("POST", "/api/sync", { accountId: a.giro })).body[0]!.id;
        expect(runOf(await waitFor(anna, (r) => runOf(r, again)?.status === "done"), again)).toMatchObject({ error: null, newTransactions: 0 });
        expect(hksyn()).toBe(synced);
    });
});
