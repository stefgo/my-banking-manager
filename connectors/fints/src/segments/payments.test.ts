import { describe, expect, it } from "vitest";
import { parseSegments } from "../syntax/parse.js";
import { serializeSegment } from "../syntax/serialize.js";
import { parseBpd } from "./bpd.js";
import { hkccs, hkipz, hkvpa, hkvpp, parseHiipz, parseHivpp, vopParameters } from "./payments.js";

const PAIN002 = "urn:iso:std:iso:20022:tech:xsd:pain.002.001.10";
const account = { accountNumber: "1234567", subAccount: "", blz: "12345678", iban: "DE02123456780001234567", bic: "SIMUDEM1XXX" };

describe("payment segments", () => {
    it("builds HKCCS and HKIPZ; instant is never turned into a standard transfer", () => {
        const pain = Buffer.from("<x/>");
        expect(serializeSegment({ ...hkccs(account, "urn:pain.001.001.09", pain), number: 3 })).toBe("HKCCS:3:1+DE02123456780001234567:SIMUDEM1XXX:1234567::280:12345678+urn?:pain.001.001.09+@4@<x/>'");
        expect(serializeSegment({ ...hkipz(2, account, "d", pain), number: 3 })).toBe("HKIPZ:3:2+DE02123456780001234567:SIMUDEM1XXX:1234567::280:12345678+d+@4@<x/>+N'");
        expect(hkipz(1, account, "d", pain).elements).toHaveLength(3);
    });

    it("builds HKVPP for the first request and for a follow-up with polling ID and touchdown", () => {
        expect(serializeSegment({ ...hkvpp([PAIN002]), number: 2 })).toBe(`HKVPP:2:1+${PAIN002.replaceAll(":", "?:")}'`);
        expect(serializeSegment({ ...hkvpp([PAIN002], Buffer.from("P1"), "T2"), number: 2 })).toBe(`HKVPP:2:1+${PAIN002.replaceAll(":", "?:")}+@2@P1++T2'`);
        expect(serializeSegment({ ...hkvpa(Buffer.from("VOP-1")), number: 2 })).toBe("HKVPA:2:1+@5@VOP-1'");
    });

    it("reads HIVPP with the single result DEG", () => {
        const [s] = parseSegments("HIVPP:4:1:3+@5@VOP-1+20261117:120000++++DE89370400440532013000::Erika Musterfrau::RVMC+Bitte prüfen.+'");
        const h = parseHivpp(s!);
        expect(Buffer.from(h.vopId!).toString()).toBe("VOP-1");
        expect(h.pollingId).toBeNull();
        expect(h.single).toEqual({ iban: "DE89370400440532013000", otherName: "Erika Musterfrau", code: "RVMC", reason: "" });
        expect(h.explanation).toBe("Bitte prüfen.");
        expect(h.waitSeconds).toBeNull();
    });

    it("reads HIVPP with a polling ID and a pain.002", () => {
        const [s] = parseSegments(`HIVPP:4:1:3+++@2@P1+${PAIN002.replaceAll(":", "?:")}+@3@<x>+++2'`);
        const h = parseHivpp(s!);
        expect(h.vopId).toBeNull();
        expect(Buffer.from(h.pollingId!).toString()).toBe("P1");
        expect(h.reportDescriptor).toBe(PAIN002);
        expect(Buffer.from(h.report!).toString()).toBe("<x>");
        expect(h.single).toBeNull();
        expect(h.waitSeconds).toBe(2);
    });

    it("reads HIVPPS and HIIPZ", () => {
        const bpd = parseBpd(parseSegments(`HIBPA:2:3:4+1+280:12345678+Bank+0+1+300+0'HIVPPS:3:1:4+1+1+0+1:J:V:N:N:${PAIN002.replaceAll(":", "?:")}:HKCCS:HKIPZ'`))!;
        expect(vopParameters(bpd)).toEqual({ formats: [PAIN002], jobs: ["HKCCS", "HKIPZ"], structured: true });
        expect(vopParameters(parseBpd(parseSegments("HIBPA:2:3:4+1+280:12345678+Bank+0+1+300+0'")))).toBeNull();
        const [z] = parseSegments("HIIPZ:5:2:3+IPZ-77++7'");
        expect(parseHiipz(z!)).toEqual({ orderId: "IPZ-77", status: "7" });
    });
});
