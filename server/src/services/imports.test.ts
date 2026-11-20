import { describe, expect, it } from "vitest";
import { categoryByName, splitCategoryPath } from "./imports.js";

describe("category paths of an import file", () => {
    it("splits at the usual separators and at a spaced hyphen", () => {
        expect(splitCategoryPath("Wohnen\\Miete")).toEqual(["Wohnen", "Miete"]);
        expect(splitCategoryPath("Lebensmittel › Bäckerei")).toEqual(["Lebensmittel", "Bäckerei"]);
        expect(splitCategoryPath("Alle - Interne Umbuchung - Kontoumbuchung")).toEqual(["Interne Umbuchung", "Kontoumbuchung"]);
        expect(splitCategoryPath("Wohnen – Miete")).toEqual(["Wohnen", "Miete"]);
        expect(splitCategoryPath("Kfz-Versicherung")).toEqual(["Kfz-Versicherung"]);
        expect(splitCategoryPath("Alle")).toEqual(["Alle"]);
    });

    it("finds a category by its whole name first, then by the path", () => {
        const cats = [
            { id: 1, parentId: null, name: "Wohnen" },
            { id: 2, parentId: 1, name: "Miete" },
            { id: 3, parentId: null, name: "Freizeit" },
            { id: 4, parentId: 3, name: "Haus - Garten" },
            { id: 5, parentId: 3, name: "Miete" },
        ];
        expect(categoryByName(cats, "Alle - Wohnen - Miete")).toBe(2);
        expect(categoryByName(cats, "Freizeit - Miete")).toBe(5);
        expect(categoryByName(cats, "haus - garten")).toBe(4);
        expect(categoryByName(cats, "Alle - Interne Umbuchung - Kontoumbuchung")).toBeNull();
    });

    it("prefers the category whose ancestors match more of the path", () => {
        const cats = [
            { id: 1, parentId: null, name: "Wohnen" },
            { id: 2, parentId: 1, name: "Nebenkosten" },
            { id: 3, parentId: 2, name: "Strom" },
            { id: 4, parentId: null, name: "Auto" },
            { id: 5, parentId: 4, name: "Nebenkosten" },
            { id: 6, parentId: 5, name: "Strom" },
        ];
        expect(categoryByName(cats, "Wohnen\\Nebenkosten\\Strom")).toBe(3);
        expect(categoryByName(cats, "Auto\\Nebenkosten\\Strom")).toBe(6);
        expect(categoryByName(cats, "Nebenkosten\\Strom")).toBe(3);
        expect(categoryByName(cats, "Alle - Auto - Nebenkosten - Strom")).toBe(6);
        expect(categoryByName(cats, "Strom")).toBe(3);
    });
});
