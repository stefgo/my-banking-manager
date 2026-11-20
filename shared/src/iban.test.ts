import { describe, expect, it } from "vitest";
import { IBAN_LENGTHS, ibanLength, ibanProblem, isValidIban } from "./iban.js";

describe("IBAN", () => {
    it("accepts valid IBANs of several countries, grouped or not", () => {
        for (const iban of [
            "DE89 3704 0044 0532 0130 00",
            "AT61 1904 3002 3457 3201",
            "CH93 0076 2011 6238 5295 7",
            "GB29 NWBK 6016 1331 9268 19",
            "NL91ABNA0417164300",
            "NO93 8601 1117 947",
            "FR14 2004 1010 0505 0001 3M02 606",
            "MT84 MALT 0110 0001 2345 MTLC AST0 01S",
            "be68 5390 0754 7034",
        ])
            expect(isValidIban(iban), iban).toBe(true);
    });

    it("knows the length of each country", () => {
        expect(Object.keys(IBAN_LENGTHS)).toHaveLength(89);
        expect(ibanLength("AT12")).toBe(20);
        expect(ibanLength("DE")).toBe(22);
        expect(ibanLength("XX12")).toBeNull();
    });

    it("says what is wrong", () => {
        expect(ibanProblem("AT12 3456 7890 121")).toBe("Eine IBAN aus AT hat 20 Zeichen, diese hat 15.");
        // Check digits that would fit, but one character too many for the country
        expect(ibanProblem("AT61 1904 3002 3457 3201 0")).toContain("hat 20 Zeichen, diese hat 21");
        expect(ibanProblem("AT62 1904 3002 3457 3201")).toContain("Prüfziffer");
        expect(ibanProblem("XX12 3456 7890 1234 5")).toBe("Für „XX“ gibt es keine IBAN.");
        expect(ibanProblem("1234")).toContain("Länderkürzel");
    });
});
