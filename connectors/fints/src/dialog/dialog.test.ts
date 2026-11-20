import { afterEach, describe, expect, it } from "vitest";
import { Dialog, type DialogOptions } from "./dialog.js";
import { discoverTanMethods, openDialog } from "./session.js";
import { FintsBankError, FintsPinError, FintsSetupError } from "./errors.js";
import { emptyState, parseState, serializeState, type FintsState } from "../state.js";
import { httpTransport } from "../transport/http.js";
import { OperationStore } from "../operations/store.js";
import { SIM_BLZ } from "../testing/bank-sim.js";
import { SIM_PIN, SIM_SYSTEM_ID, SIM_TAN, SIM_USER, startPersonalBank, type PersonalBank, type PersonalBankOptions } from "../testing/personal-bank.js";

let bank: PersonalBank | undefined;
afterEach(async () => {
    await bank?.close();
    bank = undefined;
});

async function setup(opts: PersonalBankOptions = {}, pin = SIM_PIN, state: FintsState = emptyState()): Promise<DialogOptions> {
    bank = await startPersonalBank(opts);
    return {
        transport: httpTransport(bank.url, { allowInsecure: true }),
        product: { id: "TESTPRODUKT", version: "0.1" },
        credentials: { blz: SIM_BLZ, userId: SIM_USER, pin },
        state,
    };
}

describe("discoverTanMethods", () => {
    it("reads the allowed methods, the bank parameters and a Kundensystem-ID", async () => {
        const o = await setup();
        const methods = await discoverTanMethods(o);
        expect(methods.map((m) => [m.securityFunction, m.name, m.decoupled !== null])).toEqual([
            ["946", "SecureGo plus", true],
            ["942", "mobile TAN", false],
        ]);
        expect(methods[0]?.decoupled).toEqual({ maxPolls: 60, firstDelay: 1, nextDelay: 1, manualConfirm: true, autoPoll: true });
        expect(methods[0]?.mediumRequired).toBe(2);
        expect(o.state.systemId).toBe(SIM_SYSTEM_ID);
        expect(o.state.allowedFunctions).toEqual(["946", "942"]);
        expect(o.state.bpd?.version).toBe(9);

        const [init, end] = bank!.received;
        expect(init?.find("HNSHK")?.elements[1]).toEqual(["999"]);
        expect(init?.find("HKIDN")?.elements).toEqual([["280", SIM_BLZ], [SIM_USER], ["0"], ["1"]]);
        expect(init?.find("HKSYN")).toBeDefined();
        expect(init?.find("HKTAN")).toBeUndefined();
        expect(end?.find("HKEND")).toBeDefined();
    });

    it("rejects a wrong PIN as PIN error", async () => {
        const o = await setup({}, "00000");
        await expect(discoverTanMethods(o)).rejects.toBeInstanceOf(FintsPinError);
    });

    it("synchronises later if the bank refuses HKSYN with 999", async () => {
        const o = await setup({ refuseSyncWith999: true, sca: "none" });
        await discoverTanMethods(o);
        expect(o.state.systemId).toBe("0");
        o.state.securityFunction = "946";
        o.state.tanMedium = "Mein Telefon";
        const { dialog, result } = await openDialog(o);
        expect(result.kind).toBe("done");
        expect(o.state.systemId).toBe(SIM_SYSTEM_ID);
        await dialog.end();
        const syncInit = bank!.received.find((m) => m.find("HKSYN") && m.find("HKTAN"));
        expect(syncInit?.find("HNSHK")?.elements[1]).toEqual(["946"]);
    });
});

describe("dialog with strong authentication", () => {
    async function ready(opts: PersonalBankOptions): Promise<DialogOptions> {
        const o = await setup(opts);
        await discoverTanMethods(o);
        return o;
    }

    it("opens without approval when the bank needs none (3076)", async () => {
        const o = await ready({ sca: "none" });
        o.state.securityFunction = "946";
        o.state.tanMedium = "Mein Telefon";
        const { dialog, result } = await openDialog(o);
        expect(result.kind).toBe("done");
        expect(o.state.upd?.accounts[0]?.iban).toBe("DE02123456780001234567");
        const init = bank!.received.at(-1);
        expect(init?.find("HKTAN")?.elements).toEqual([["4"], ["HKIDN"], [""], [""], [""], [""], [""], [""], [""], [""], ["Mein Telefon"]]);
        expect(init?.find("HNSHK")?.elements[0]).toEqual(["PIN", "2"]);
        await dialog.end();
    });

    it("waits for a decoupled approval and queries its status", async () => {
        const o = await ready({ sca: "decoupled", pendingPolls: 2 });
        o.state.securityFunction = "946";
        o.state.tanMedium = "Mein Telefon";
        const { dialog, result } = await openDialog(o);
        expect(result).toMatchObject({ kind: "challenge", challenge: { decoupled: true, text: "Bitte bestätigen Sie den Vorgang in Ihrer App.", medium: "Mein Telefon", validUntil: "2026-11-16T10:30:00", methodName: "SecureGo plus", polling: { first: 1, next: 1, max: 60 } } });
        expect(dialog.awaitingApproval).toBe(true);
        expect((await dialog.poll()).kind).toBe("challenge");
        expect((await dialog.poll()).kind).toBe("challenge");
        const done = await dialog.poll();
        expect(done.kind).toBe("done");
        expect(dialog.awaitingApproval).toBe(false);
        expect(o.state.upd?.userName).toBe("Erika Mustermann");
        const pollMsg = bank!.received.at(-1);
        expect(pollMsg?.find("HKTAN")?.elements.slice(0, 6).map((e) => e[0])).toEqual(["S", "", "", "", expect.stringMatching(/^REF/), "N"]);
        expect(bank!.signatures.at(-1)).toEqual([SIM_PIN]);
        await dialog.end();
    });

    it("recognises a decoupled approval announced with 3955 alone", async () => {
        const o = await ready({ sca: "decoupled", without0030: true });
        o.state.securityFunction = "946";
        o.state.tanMedium = "Mein Telefon";
        const { dialog, result } = await openDialog(o);
        expect(result).toMatchObject({ kind: "challenge", challenge: { decoupled: true } });
        expect(dialog.awaitingApproval).toBe(true);
        expect((await dialog.poll()).kind).toBe("done");
        expect(o.state.upd?.accounts.length).toBeGreaterThan(0);
        await dialog.end();
    });

    it("hands in a TAN in the signature closing", async () => {
        const o = await ready({ sca: "tan" });
        o.state.securityFunction = "942";
        const { dialog, result } = await openDialog(o);
        expect(result).toMatchObject({ kind: "challenge", challenge: { decoupled: false, text: "Bitte TAN eingeben.", polling: null } });
        await expect(dialog.submitTan("999999")).rejects.toBeInstanceOf(FintsBankError);
        expect(dialog.awaitingApproval).toBe(false);
        await dialog.end();

        const again = await openDialog(o);
        expect((await again.dialog.submitTan(SIM_TAN)).kind).toBe("done");
        expect(bank!.signatures.at(-1)).toEqual([SIM_PIN, SIM_TAN]);
        expect(bank!.received.at(-1)?.find("HKTAN")?.elements[0]).toEqual(["2"]);
        await again.dialog.end();
    });

    it("refuses to open without a chosen method", async () => {
        const o = await ready({});
        await expect(openDialog(o)).rejects.toBeInstanceOf(FintsSetupError);
        const d = new Dialog(o, "946");
        await expect(d.poll()).rejects.toBeInstanceOf(FintsSetupError);
    });
});

describe("state", () => {
    it("round-trips and falls back to an empty state for unknown data", () => {
        const s = { ...emptyState(), systemId: "SYS1", securityFunction: "946", tanMedium: "Telefon", allowedFunctions: ["946"] };
        expect(parseState(serializeState(s))).toEqual(s);
        expect(parseState("{broken")).toEqual(emptyState());
        expect(parseState(JSON.stringify({ ...s, format: 99 }))).toEqual(emptyState());
        expect(parseState(JSON.stringify({ ...s, securityFunction: "x" })).securityFunction).toBe("999");
        expect(parseState(null)).toEqual(emptyState());
    });
});

describe("OperationStore", () => {
    it("expires operations and ends their dialog", async () => {
        let now = 1000;
        const store = new OperationStore(60_000, () => now);
        let ended = 0;
        const dialog = { end: async () => void ended++ } as unknown as Dialog;
        const challenge = { decoupled: true, text: "", medium: "", validUntil: "", methodName: "", polling: null };
        let aborted: unknown = null;
        const op = store.add({ kind: "accounts", payment: false, dialog, challenge, vop: null, nextPollAt: now, resume: () => undefined, abort: (e) => void (aborted = e) });
        expect(store.get(op.id)).toBe(op);
        now += 60_001;
        expect(store.get(op.id)).toBeUndefined();
        await store.sweep();
        expect(ended).toBe(1);
        expect(aborted).toBeInstanceOf(Error);
        expect(store.size).toBe(0);
        await store.close();
    });
});
