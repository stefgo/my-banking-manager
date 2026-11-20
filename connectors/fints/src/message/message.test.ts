import { describe, expect, it } from "vitest";
import { buildMessage } from "./build.js";
import { readMessage } from "./read.js";
import { parseSegments } from "../syntax/parse.js";
import { serializeSegment, toWire } from "../syntax/serialize.js";
import { hkidn, hkvvb } from "../segments/dialog.js";
import { bankMessage, ok } from "../testing/bank-sim.js";

const now = new Date(2026, 10, 16, 10, 20, 44);
const product = { id: "TESTPRODUKT", version: "0.1" };

describe("buildMessage", () => {
    it("builds an unsigned message with continuous numbering and the right size", () => {
        const m = buildMessage({ dialogId: "0", messageNumber: 1, segments: [hkidn("10020030", "9999999999", "0", false), hkvvb(0, 0, product)] });
        const text = m.bytes.toString("latin1");
        expect(text).toBe(
            "HNHBK:1:3+" + String(m.bytes.length).padStart(12, "0") + "+300+0+1'" + "HKIDN:2:2+280:10020030+9999999999+0+0'" + "HKVVB:3:3+0+0+0+TESTPRODUKT+0.1'" + "HNHBS:4:1+1'",
        );
        expect(m.numbers).toEqual([2, 3]);
    });

    it("builds the PIN/TAN envelope like the example in PIN/TAN F.2.2", () => {
        const signer = { blz: "10020030", userId: "12345", systemId: "2", securityFunction: "999" };
        const m = buildMessage({
            dialogId: "0",
            messageNumber: 1,
            segments: [hkidn("10020030", "12345", "2", true), hkvvb(0, 0, product)],
            security: { signer, pin: "83427" },
            now,
            controlRef: "654321",
        });
        const outer = parseSegments(m.bytes);
        expect(outer.map((s) => `${s.id}:${s.number}`)).toEqual(["HNHBK:1", "HNVSK:998", "HNVSD:999", "HNHBS:6"]);
        expect(serializeSegment(outer[1]!)).toBe("HNVSK:998:3+PIN:1+998+1+1::2+1:20261116:102044+2:2:13:@8@\0\0\0\0\0\0\0\0:5:1+280:10020030:12345:V:0:0+0'");
        expect(Number((outer[0]!.elements[0]![0] as string))).toBe(m.bytes.length);

        const inner = parseSegments(outer[2]!.elements[0]![0] as Uint8Array);
        expect(inner.map((s) => serializeSegment(s))).toEqual([
            "HNSHK:2:4+PIN:1+999+654321+1+1+1::2+1+1:20261116:102044+1:999:1+6:10:16+280:10020030:12345:S:0:0'",
            "HKIDN:3:2+280:10020030+12345+2+1'",
            "HKVVB:4:3+0+0+0+TESTPRODUKT+0.1'",
            "HNSHA:5:2+654321++83427'",
        ]);
        expect(m.numbers).toEqual([3, 4]);
    });

    it("uses security profile 2 and the method's function in the two-step method", () => {
        const signer = { blz: "10020030", userId: "u", systemId: "S1", securityFunction: "921" };
        const m = buildMessage({ dialogId: "D", messageNumber: 2, segments: [], security: { signer, pin: "p?+" }, now, controlRef: "7" });
        const inner = parseSegments(parseSegments(m.bytes)[2]!.elements[0]![0] as Uint8Array);
        expect(inner[0]!.elements[0]).toEqual(["PIN", "2"]);
        expect(inner[0]!.elements[1]).toEqual(["921"]);
        expect(inner[1]!.elements[2]).toEqual(["p?+"]); // escaped on the wire, intact after reading
    });
});

describe("readMessage", () => {
    it("unpacks HNVSD and collects return codes", () => {
        const innerSegs = serializeSegment({ id: "HIRMG", number: 2, version: 2, elements: [["3060", "", "Teilweise liegen Warnungen/Hinweise vor."]] })
            + serializeSegment({ id: "HIRMS", number: 3, version: 2, ref: 4, elements: [["9942", "", "PIN falsch."], ["3920", "", "Zugelassene TAN-Verfahren", "921", "942"]] });
        const msg =
            "HNHBK:1:3+000000000000+300+DLG1+1+DLG1:1'" +
            serializeSegment({ id: "HNVSK", number: 998, version: 3, elements: [["PIN", "2"], "998"] }) +
            serializeSegment({ id: "HNVSD", number: 999, version: 1, elements: [toWire(innerSegs)] }) +
            "HNHBS:4:1+1'";
        const m = readMessage(toWire(msg));
        expect(m.dialogId).toBe("DLG1");
        expect(m.segments.map((s) => s.id)).toEqual(["HNHBK", "HIRMG", "HIRMS", "HNHBS"]);
        expect(m.globalCodes[0]?.code).toBe("3060");
        expect(m.segmentCodes(4).map((c) => c.code)).toEqual(["9942", "3920"]);
        expect(m.segmentCodes(4)[1]?.params).toEqual(["921", "942"]);
        expect(m.errors.map((c) => c.code)).toEqual(["9942"]);
        expect(m.hasCode("3920", 4)).toBe(true);
        expect(m.hasCode("3920", 5)).toBe(false);
    });

    it("reads a message of the simulated bank", () => {
        const m = readMessage(bankMessage([ok(), ok(3, "0020", "Information fehlerfrei entgegengenommen.")], "SIM7", 1));
        expect(m.dialogId).toBe("SIM7");
        expect(m.errors).toEqual([]);
        expect(m.segmentCodes(3)[0]?.text).toBe("Information fehlerfrei entgegengenommen.");
    });

    it("refuses data that is not a FinTS message", () => {
        expect(() => readMessage(toWire("HIRMG:2:2+0010::x'"))).toThrow();
    });
});
