import { describe, expect, it } from "vitest";
import { parseSegments } from "./parse.js";
import { serializeSegment } from "./serialize.js";
import { dat, jn, num, text, toDat, wrtCents } from "./formats.js";
import { FintsSyntaxError } from "./types.js";

describe("parseSegments", () => {
    it("reads header, elements and groups (Formals H.2.2)", () => {
        const [s] = parseSegments("HKIDN:3:2+280:10020030+12345+2+1'");
        expect(s).toEqual({
            id: "HKIDN",
            number: 3,
            version: 2,
            elements: [["280", "10020030"], ["12345"], ["2"], ["1"]],
        });
    });

    it("reads the reference segment of bank segments", () => {
        const [s] = parseSegments("HIBPA:4:3:4+3+280:10020030+Musterbank'");
        expect(s?.ref).toBe(4);
        expect(s?.elements[2]).toEqual(["Musterbank"]);
    });

    it("unescapes syntax characters (H.1.3)", () => {
        const [s] = parseSegments("HIKIM:2:2+Taschengeld für Hans ?+ Franz+Ist das so richtig????+a?:b?'c?@d'");
        expect(s?.elements).toEqual([["Taschengeld für Hans + Franz"], ["Ist das so richtig??"], ["a:b'c@d"]]);
    });

    it("reads binary data with syntax characters inside (H.1.4)", () => {
        const [s] = parseSegments("HNVSD:999:1+@6@a+b'c:+X'");
        const bin = s?.elements[0]?.[0];
        expect(bin).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(bin as Uint8Array).toString("latin1")).toBe("a+b'c:");
        expect(s?.elements[1]).toEqual(["X"]);
    });

    it("keeps binary data byte for byte", () => {
        const raw = Buffer.from([0, 255, 39, 43, 63, 10]);
        const msg = Buffer.concat([Buffer.from("HNVSD:999:1+@6@", "latin1"), raw, Buffer.from("'", "latin1")]);
        const [s] = parseSegments(msg);
        expect(Buffer.from(s?.elements[0]?.[0] as Uint8Array)).toEqual(raw);
    });

    it("reads omitted and cut-off elements (H.1.5)", () => {
        const [s] = parseSegments("HXXXX:1:1+A+B+++E+F:::G'");
        expect(s?.elements).toEqual([["A"], ["B"], [""], [""], ["E"], ["F", "", "", "G"]]);
    });

    it("reads several segments and ignores line breaks between them", () => {
        const segs = parseSegments("HNHBK:1:3+000000000100+300+0+1'\r\nHNHBS:2:1+1'");
        expect(segs.map((s) => s.id)).toEqual(["HNHBK", "HNHBS"]);
    });

    it("rejects broken data", () => {
        expect(() => parseSegments("HKIDN:3:2+280")).toThrow(FintsSyntaxError);
        expect(() => parseSegments("HKIDN:3:2+28?")).toThrow(FintsSyntaxError);
        expect(() => parseSegments("HNVSD:999:1+@99@abc'")).toThrow(FintsSyntaxError);
        expect(() => parseSegments("HNVSD:999:1+@3@abcX'")).toThrow(FintsSyntaxError);
        expect(() => parseSegments("hkidn:3:2+1'")).toThrow(FintsSyntaxError);
        expect(() => parseSegments("HKIDN:x:2+1'")).toThrow(FintsSyntaxError);
    });
});

describe("serializeSegment", () => {
    it("writes header, groups and escapes", () => {
        const out = serializeSegment({ id: "HKIDN", number: 3, version: 2, elements: [["280", "10020030"], "12345", "a+b:c'd?e@f", 1] });
        expect(out).toBe("HKIDN:3:2+280:10020030+12345+a?+b?:c?'d??e?@f+1'");
    });

    it("cuts off empty trailing elements and components, keeps inner gaps", () => {
        const out = serializeSegment({ id: "HXXXX", number: 1, version: 1, elements: ["A", null, "", "D", ["E", "", "G", "", null], null, ""] });
        expect(out).toBe("HXXXX:1:1+A+++D+E::G'");
    });

    it("writes binary data with its length", () => {
        const out = serializeSegment({ id: "HNVSD", number: 999, version: 1, elements: [Buffer.from("a+b'", "latin1")] });
        expect(out).toBe("HNVSD:999:1+@4@a+b''");
    });

    it("trims text and rejects characters outside ISO 8859-1", () => {
        expect(serializeSegment({ id: "HX", number: 1, version: 1, elements: ["  x  "] })).toBe("HX:1:1+x'");
        expect(() => serializeSegment({ id: "HX", number: 1, version: 1, elements: ["€"] })).toThrow(FintsSyntaxError);
    });

    it("round-trips through the parser", () => {
        const input = "HIUPD:16:6:4+1234567::280:10020030+DE02100200301234567+12345+1+EUR+Ernst Müller++Giro?+Spezial+T:2000,:EUR+HKSAL:1+HKKAZ:1'";
        const [s] = parseSegments(input);
        expect(serializeSegment(s!)).toBe(input);
    });
});

describe("formats", () => {
    it("reads values by position", () => {
        expect(text(["a", "b"], 1)).toBe("b");
        expect(text(["a"], 3)).toBe("");
        expect(num(["300"])).toBe(300);
        expect(num([""])).toBeNull();
        expect(() => num(["3a"])).toThrow(FintsSyntaxError);
        expect(jn(["J"])).toBe(true);
        expect(jn([""])).toBe(false);
        expect(dat(["20261116"])).toBe("2026-11-16");
        expect(toDat("2026-11-16")).toBe("20261116");
        expect(toDat(new Date(2026, 0, 5))).toBe("20260105");
    });

    it("converts amounts without rounding (B.4.1)", () => {
        expect(wrtCents(["100,"])).toBe(10000);
        expect(wrtCents(["100,2"])).toBe(10020);
        expect(wrtCents(["4567,89"])).toBe(456789);
        expect(wrtCents(["0,5"])).toBe(50);
        expect(wrtCents(["1,500"])).toBe(150);
        expect(() => wrtCents(["1,555"])).toThrow(FintsSyntaxError);
        expect(() => wrtCents(["1.000,00"])).toThrow(FintsSyntaxError);
    });
});
