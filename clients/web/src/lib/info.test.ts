import { describe, expect, it } from "vitest";
import { hasInfo, infoFromRows, labelSuggestions, moveRow, newRow } from "./info";

describe("info rows", () => {
    it("drops empty rows, trims, and keeps the order", () => {
        const rows = [newRow(" Kundennummer ", " 4711 "), newRow("", "  "), newRow("Ansprechpartner", "")];
        const { info, errors } = infoFromRows(rows, "Zeile 1\nZeile 2\n\n  ");
        expect(errors).toEqual({});
        expect(info).toEqual({
            attributes: [
                { key: "Kundennummer", value: "4711" },
                { key: "Ansprechpartner", value: "" },
            ],
            notes: "Zeile 1\nZeile 2",
        });
    });

    it("flags a value without a label and a label used twice", () => {
        const noLabel = newRow(" ", "4711");
        const first = newRow("IBAN", "1");
        const twice = newRow("iban", "2");
        const { errors } = infoFromRows([noLabel, first, twice], "");
        expect(Object.keys(errors).map(Number)).toEqual([noLabel.id, twice.id]);
        expect(errors[twice.id]).toContain("gibt es schon");
    });

    it("moves rows and ignores moves past the ends", () => {
        expect(moveRow(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
        expect(moveRow(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
        expect(moveRow(["a", "b"], 1, 2)).toEqual(["a", "b"]);
    });

    it("suggests labels used elsewhere, once each and without the taken ones", () => {
        const infos = [
            { attributes: [{ key: "Vertragsende", value: "" }, { key: "Kundennummer", value: "" }], notes: "" },
            { attributes: [{ key: "kundennummer", value: "" }, { key: "Ansprechpartner", value: "" }], notes: "" },
        ];
        expect(labelSuggestions(infos, ["  ansprechpartner"])).toEqual(["Kundennummer", "Vertragsende"]);
    });

    it("counts a note of blanks as empty", () => {
        expect(hasInfo({ attributes: [], notes: " \n " })).toBe(false);
        expect(hasInfo({ attributes: [], notes: "x" })).toBe(true);
    });
});
