import { describe, expect, it } from "vitest";
import { BIC_PATTERN, joinRemittance, needsBic, REMITTANCE_LINE_MAX, splitRemittance, wrapRemittance } from "./sepa.js";

describe("remittance lines", () => {
    it("joins lines with one space and drops empty ones", () => {
        expect(joinRemittance(["Rechnung 4711 ", "", "  Kunde 12", ""])).toBe("Rechnung 4711 Kunde 12");
        expect(joinRemittance(["", "", "", ""])).toBe("");
    });

    it("wraps between words and cuts words longer than a line", () => {
        expect(wrapRemittance("Miete Januar Wohnung 3 links Hausnummer 12a", 20)).toEqual(["Miete Januar Wohnung", "3 links Hausnummer", "12a"]);
        expect(wrapRemittance("a".repeat(40) + " b")).toEqual(["a".repeat(35), "aaaaa b"]);
        expect(wrapRemittance("eins\nzwei")).toEqual(["eins", "zwei"]);
    });

    it("splits a stored text into four lines of at most 35 characters", () => {
        expect(splitRemittance("")).toEqual(["", "", "", ""]);
        expect(splitRemittance("Rechnung 4711")).toEqual(["Rechnung 4711", "", "", ""]);
        const full = Array.from({ length: 4 }, (_, i) => String(i).repeat(REMITTANCE_LINE_MAX)).join(" ").slice(0, 140);
        expect(full).toHaveLength(140);
        expect(splitRemittance(full)).toEqual(["0".repeat(35), "1".repeat(35), "2".repeat(35), "3".repeat(32)]);
    });

    it("cuts every 35 characters when words would need a fifth line", () => {
        const text = "Kurz " + "x".repeat(33) + " " + "y".repeat(33) + " " + "z".repeat(33) + " Ende";
        const lines = splitRemittance(text);
        expect(lines.join("")).toBe(text);
        expect(lines.every((l) => l.length <= REMITTANCE_LINE_MAX)).toBe(true);
    });

    it("round-trips lines that are joined and split again", () => {
        const lines = ["Rechnung 2026-117", "Kundennummer 88231", "Danke", ""];
        expect(splitRemittance(joinRemittance(lines))).toEqual(["Rechnung 2026-117 Kundennummer", "88231 Danke", "", ""]);
    });
});

describe("BIC", () => {
    it("is offered only for SEPA countries outside the EEA", () => {
        expect(needsBic("CH93 0076 2011 6238 5295 7")).toBe(true);
        expect(needsBic("GB29NWBK60161331926819")).toBe(true);
        expect(needsBic("DE89370400440532013000")).toBe(false);
        expect(needsBic("AT611904300234573201")).toBe(false);
        expect(needsBic("")).toBe(false);
    });

    it("has 8 or 11 characters", () => {
        expect(BIC_PATTERN.test("UBSWCHZH")).toBe(true);
        expect(BIC_PATTERN.test("UBSWCHZH80A")).toBe(true);
        expect(BIC_PATTERN.test("UBSWCHZH8")).toBe(false);
    });
});
