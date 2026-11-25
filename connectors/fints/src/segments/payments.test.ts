import { describe, expect, it } from "vitest";
import { parseSegments } from "../syntax/parse.js";
import { serializeSegment } from "../syntax/serialize.js";
import type { SegmentInput } from "../syntax/types.js";
import { parseBpd } from "./bpd.js";
import { hkccs, hkipz, hkvpa, hkvpp, parseHiipz, parseHivpp, vopParameters } from "./payments.js";
import { deleteNeedsData, hkcde, hkcdl, hkcdn, hkcsa, hkcse, hkcsl, orderRules, parseOrderId, twoDigitList } from "./orders.js";

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

describe("order segments", () => {
    const sparkasse = [
        "HIBPA:2:3:4+1+280:12345678+Bank+0+1+300+0'",
        "HICSES:3:1:4+1+1+0+1:360'",
        "HICSLS:4:1:4+1+1+0+J'",
        "HICDES:5:1:4+1+1+0+4:0:9999:0102030612:01020304050607080910111213141516171819202122232425262728293099'",
        "HICDNS:6:1:4+1+1+0+0:0:9999:J:J:J:J:J:N:J:J:J:0102030612:0102030405060708091099'",
        "HICDLS:7:1:4+1+1+0+0:9999:J:J'",
    ].join("");

    it("reads the bank's rules for writing orders like a Sparkasse sends them", () => {
        const bpd = parseBpd(parseSegments(sparkasse))!;
        const rules = orderRules(bpd)!;
        expect(rules.scheduled).toEqual({ minDays: 1, maxDays: 360 });
        expect(rules.scheduledChange).toBeNull();
        expect(rules.standing).toEqual({ minDays: 0, maxDays: 9999, months: [1, 2, 3, 6, 12], monthDays: [...Array.from({ length: 30 }, (_, i) => i + 1), 99], weeks: [], weekDays: [] });
        expect(rules.standingChange).toMatchObject({
            monthDays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99],
            changeable: { payeeAccount: true, payeeName: true, amount: true, remittance: true, firstDate: true, unit: false, every: true, executionDay: true, lastDate: true },
        });
        expect(deleteNeedsData(bpd, "HKCSL")).toBe(true);
        expect(deleteNeedsData(bpd, "HKCDL")).toBe(true);
        expect(orderRules(parseBpd(parseSegments("HIBPA:2:3:4+1+280:12345678+Bank+0+1+300+0'")))).toBeNull();
    });

    it("reads weekly rhythms where a bank offers them", () => {
        const bpd = parseBpd(parseSegments("HIBPA:2:3:4+1+280:12345678+Bank+0+1+300+0'HICDES:5:1:4+1+1+0+4:1:365:010312:0115:0102:15'"))!;
        expect(orderRules(bpd)!.standing).toEqual({ minDays: 1, maxDays: 365, months: [1, 3, 12], monthDays: [1, 15], weeks: [1, 2], weekDays: [1, 5] });
        expect(twoDigitList("0102x3")).toEqual([1, 2]);
    });

    it("builds the write segments; a deletion sends the bank's own details back", () => {
        const pain = Buffer.from("<x/>");
        const ser = (s: SegmentInput) => serializeSegment({ ...s, number: 3 });
        const r = { firstDate: "2026-12-01", unit: "month" as const, every: 1, executionDay: 1, lastDate: null };
        const kt = "DE02123456780001234567:SIMUDEM1XXX:1234567::280:12345678";
        expect(ser(hkcse(account, "d", pain))).toBe(`HKCSE:3:1+${kt}+d+@4@<x/>'`);
        expect(ser(hkcsa(account, "d", pain, "TU-1"))).toBe(`HKCSA:3:1+${kt}+d+@4@<x/>+TU-1'`);
        expect(ser(hkcsl(account, { descriptor: "d", pain }, "TU-1"))).toBe(`HKCSL:3:1+${kt}+d+@4@<x/>+TU-1'`);
        expect(ser(hkcsl(account, null, "TU-1"))).toBe(`HKCSL:3:1+${kt}+++TU-1'`);
        expect(ser(hkcde(account, "d", pain, r))).toBe(`HKCDE:3:1+${kt}+d+@4@<x/>+20261201:M:1:1'`);
        expect(ser(hkcdn(account, "d", pain, "DA-1", { ...r, lastDate: "2027-12-01" }, "20261230"))).toBe(`HKCDN:3:1+${kt}+d+@4@<x/>++DA-1+20261230:M:1:1:20271201'`);
        expect(ser(hkcdl(account, { descriptor: "d", pain }, "DA-2", ["20250230", "M", "3", "31", "20271231"]))).toBe(`HKCDL:3:1+${kt}+d+@4@<x/>++DA-2+20250230:M:3:31:20271231'`);
        const [hicde] = parseSegments("HICDE:4:1:3+DA-9'");
        expect(parseOrderId(hicde!)).toBe("DA-9");
    });
});
