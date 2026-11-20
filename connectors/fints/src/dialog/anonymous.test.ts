import { afterEach, describe, expect, it } from "vitest";
import { fetchBankParameters } from "./anonymous.js";
import { FintsBankError } from "./errors.js";
import { FintsTransportError, decodeBody, httpTransport } from "../transport/http.js";
import { buildMessage } from "../message/build.js";
import { ok, simBpd, startBankSim, SIM_BLZ, type BankSim } from "../testing/bank-sim.js";

const product = { id: "TESTPRODUKT", version: "0.1" };
let sim: BankSim | undefined;

afterEach(async () => {
    await sim?.close();
    sim = undefined;
});

describe("anonymous dialog", () => {
    it("fetches the bank parameters and ends the dialog", async () => {
        sim = await startBankSim((m, ctx) => {
            if (m.find("HKEND")) return [ok(), ok(ctx.numberOf("HKEND"), "0100", "Dialog beendet.")];
            const vvb = ctx.numberOf("HKVVB");
            return [ok(), ok(vvb, "3050", "BPD nicht mehr aktuell, aktuelle Version enthalten."), ...simBpd(7, vvb), { id: "HIKIM", version: 2, elements: ["Wartung", "Am Sonntag kurz nicht erreichbar."] }];
        });
        const result = await fetchBankParameters({ blz: SIM_BLZ, product, transport: httpTransport(sim.url, { allowInsecure: true }) });

        expect(result.bpd?.version).toBe(7);
        expect(result.bpd?.bankName).toBe("Simulationsbank");
        expect(result.bpd?.pinTan?.tanRequired.HKSAL).toBe(true);
        expect(result.bpd?.jobs.DKKKU?.[0]?.version).toBe(2);
        expect(result.codes.map((c) => c.code)).toContain("3050");
        expect(result.notices).toEqual([{ subject: "Wartung", text: "Am Sonntag kurz nicht erreichbar." }]);

        const [init, end] = sim.received;
        expect(init?.dialogId).toBe("0");
        expect(init?.find("HKIDN")?.elements).toEqual([["280", SIM_BLZ], ["9999999999"], ["0"], ["0"]]);
        expect(init?.find("HKVVB")?.elements).toEqual([["0"], ["0"], ["0"], ["TESTPRODUKT"], ["0.1"]]);
        expect(init?.find("HNVSK")).toBeUndefined();
        expect(end?.dialogId).toBe("SIMDIALOG1");
        expect(end?.messageNumber).toBe(2);
        expect(end?.find("HKEND")?.elements).toEqual([["SIMDIALOG1"]]);
    });

    it("reports the bank's errors with code and text", async () => {
        sim = await startBankSim(() => [{ id: "HIRMG", version: 2, elements: [["9800", "", "Dialog abgebrochen."]] }]);
        const err = await fetchBankParameters({ blz: SIM_BLZ, product, transport: httpTransport(sim.url, { allowInsecure: true }) }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(FintsBankError);
        expect((err as FintsBankError).codes[0]).toMatchObject({ code: "9800", text: "Dialog abgebrochen." });
        expect(sim.received).toHaveLength(1);
    });

    it("keeps the parameters if ending the dialog fails", async () => {
        sim = await startBankSim((m, ctx) => (m.find("HKEND") ? "close" : [ok(), ...simBpd(3, ctx.numberOf("HKVVB"))]));
        const result = await fetchBankParameters({ blz: SIM_BLZ, product, transport: httpTransport(sim.url, { allowInsecure: true }) });
        expect(result.bpd?.version).toBe(3);
    });
});

describe("http transport", () => {
    it("requires HTTPS unless allowed for tests", () => {
        expect(() => httpTransport("http://bank.example.invalid/fints")).toThrow(FintsTransportError);
        expect(() => httpTransport("https://bank.example.invalid/fints")).not.toThrow();
    });

    it("reports broken answers, HTTP errors, timeouts and unreachable banks", async () => {
        const msg = buildMessage({ dialogId: "0", messageNumber: 1, segments: [] }).bytes;
        sim = await startBankSim(() => "garbage");
        await expect(httpTransport(sim.url, { allowInsecure: true }).send(msg)).rejects.toMatchObject({ kind: "invalid" });
        await expect(httpTransport(sim.url, { allowInsecure: true }).send(Buffer.from("no FinTS"))).rejects.toMatchObject({ kind: "http", status: 500 });
        const url = sim.url;
        await sim.close();

        sim = await startBankSim(() => "hang");
        await expect(httpTransport(sim.url, { allowInsecure: true, timeoutMs: 200 }).send(msg)).rejects.toMatchObject({ kind: "timeout" });
        await sim.close();
        sim = undefined;

        await expect(httpTransport(url, { allowInsecure: true }).send(msg)).rejects.toMatchObject({ kind: "network" });
    });

    it("accepts Base64 with line breaks and unencoded answers", () => {
        const msg = "HNHBK:1:3+000000000020+300+0+1'";
        const b64 = Buffer.from(msg, "latin1").toString("base64");
        expect(decodeBody(Buffer.from(b64.slice(0, 10) + "\r\n" + b64.slice(10))).toString("latin1")).toBe(msg);
        expect(decodeBody(Buffer.from(msg, "latin1")).toString("latin1")).toBe(msg);
        expect(() => decodeBody(Buffer.from(Buffer.from("hello").toString("base64")))).toThrow(FintsTransportError);
    });
});
