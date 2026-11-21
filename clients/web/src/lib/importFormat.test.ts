import { describe, expect, it } from "vitest";
import { BUILTIN_IMPORT_FORMATS, type ImportFormatDefinition, type ImportPreview } from "@mbm/shared";
import { categoryChange, copyName, emptyFormat, fieldsSummary, fileSummary, formatColumns, formatProblem, matchesFilter, matchesSearch, newStep, NO_CHOICE, partName, pruneRefs, replaceStep, reviewCounts, reviewOutcome, rowSelectable, sourceKey, sourceOptions, stepsSummary } from "./importFormat";

type Row = ImportPreview["rows"][number];

const MONEY = BUILTIN_IMPORT_FORMATS.find((f) => f.key === "builtin:moneymoney")!.definition;
const row = (over: Partial<Row>): Row => ({
    line: 1, date: "2026-11-01", amount: -100, name: "Markt", iban: null, purpose: "", bookingText: "", fillsBookingText: false, reference: "", mandateId: "", creditorId: "", counterpartyBic: "", fillsDetails: false, fills: [],
    pending: false, categoryId: null, newCategory: null, state: "new", storedCategoryId: null, categoryState: null, error: null, ...over,
});
const mapped = (over: Partial<ImportFormatDefinition> = {}): ImportFormatDefinition => ({ ...emptyFormat(), fields: { bookingDate: [{ column: "Tag" }], amount: [{ column: "Wert" }] }, ...over });

describe("columns and summaries", () => {
    it("lists the columns a format names, once each", () => {
        expect(formatColumns(MONEY)).toEqual(["Datum", "Wertstellung", "Betrag", "Name", "Konto", "Bank", "Kategorie", "Verwendungszweck"]);
    });

    it("sums up the parts of a format", () => {
        expect(fileSummary(MONEY)).toBe("Semikolon · Kopfzeile 1");
        expect(fileSummary({ ...MONEY, file: { ...MONEY.file, delimiter: "||", headerLine: "none" } })).toBe("Trenner „||“ · ohne Kopfzeile");
        expect(stepsSummary(MONEY)).toBe("1 Stufe");
        expect(stepsSummary(emptyFormat())).toBe("keine Zerlegung");
        expect(fieldsSummary(MONEY)).toBe("12 von 13 zugeordnet");
    });

    it("offers columns and the parts of earlier steps only", () => {
        const labels = sourceOptions(MONEY, ["Datum", "Verwendungszweck"]).map((o) => o.label);
        expect(labels).toContain("Stufe 1 › Umsatzart");
        expect(labels).toContain("Stufe 1 › Rest");
        expect(sourceOptions(MONEY, ["Datum"], 0).map((o) => o.label)).toEqual(["Datum"]);
    });

    it("lists a column by its unique name, also when referenced by position", () => {
        expect(sourceKey({ columnIndex: 1 }, ["A", "B"])).toBe(JSON.stringify({ column: "B" }));
        expect(sourceKey({ columnIndex: 1 }, ["A", "A"])).toBe(JSON.stringify({ columnIndex: 1 }));
    });
});

describe("what keeps a format from being used", () => {
    it("needs date and amount", () => {
        expect(formatProblem(emptyFormat(), null)).toContain("Buchungstag");
        expect(formatProblem(mapped(), null)).toBe("");
    });

    it("names columns missing in the sample", () => {
        expect(formatProblem(mapped(), { delimiter: ";", header: ["Tag"], rows: [] })).toBe("In der Datei fehlt: Wert.");
        expect(formatProblem(mapped(), { delimiter: ";", header: [], rows: [] })).toContain("keine Tabelle");
    });

    it("finds an incomplete step", () => {
        const step = { id: "a", input: { column: "Tag" }, type: "separator" as const, separator: "", parts: ["x"] };
        expect(formatProblem(mapped({ steps: [step] }), null)).not.toBe("");
    });
});

describe("editing steps", () => {
    const step = { id: "s", input: { column: "T" }, type: "separator" as const, separator: ",", parts: ["a", "b"] };
    const def = mapped({ steps: [step, { ...step, id: "t", input: { step: "s", part: "b" } }], fields: { bookingDate: [{ column: "Tag" }], amount: [{ column: "Wert" }], remittance: [{ step: "s", part: "b" }] } });

    it("carries a renamed part into fields and later steps", () => {
        const next = replaceStep(def, 0, { ...step, parts: ["a", "neu"] });
        expect(next.fields.remittance).toEqual([{ step: "s", part: "neu" }]);
        expect(next.steps[1]!.input).toEqual({ step: "s", part: "neu" });
    });

    it("drops what points to a removed part", () => {
        const next = pruneRefs(replaceStep(def, 0, { ...step, parts: ["a"] }));
        expect(next.fields.remittance).toBeUndefined();
        expect(next.steps[1]!.input).toEqual({ columnIndex: 0 });
    });

    it("gives a new step a free id", () => {
        expect(newStep(def, ["T"]).id).toBe("step3");
    });

    it("makes valid, unique names for parts", () => {
        expect(partName("Gläubiger ID", [])).toBe("Glaubiger-ID");
        expect(partName("Referenz", ["Referenz"])).toBe("Referenz-2");
        expect(partName("rest", [])).toBe("rest-2");
        expect(partName("123", [])).toBe("part");
    });

    it("finds a free name for a copy", () => {
        expect(copyName("X", ["X"])).toBe("X (Kopie)");
        expect(copyName("X", ["X", "x (kopie)"])).toBe("X (Kopie 2)");
    });
});

describe("filter of the review", () => {
    const rows = [
        row({ line: 1 }),
        row({ line: 2, state: "duplicate" }),
        row({ line: 3, state: "duplicate", fillsDetails: true }),
        row({ line: 4, state: "duplicate", categoryState: "differs" }),
        row({ line: 5, state: "invalid", error: "x" }),
        row({ line: 6, state: "duplicate", fillsBookingText: true, categoryState: "differs" }),
    ];
    const lines = (f: Parameters<typeof matchesFilter>[1]) => rows.filter((r) => matchesFilter(r, f)).map((r) => r.line);

    it("shows everything that changes something by default", () => {
        expect(lines("changes")).toEqual([1, 3, 4, 5, 6]);
    });

    it("sorts rows into the tiles", () => {
        expect(lines("new")).toEqual([1]);
        expect(lines("fill")).toEqual([3, 6]);
        expect(lines("differs")).toEqual([4, 6]);
        expect(lines("duplicate")).toEqual([2]);
        expect(lines("invalid")).toEqual([5]);
    });

    it("counts per filter", () => {
        expect(reviewCounts(rows)).toEqual({ changes: 5, new: 1, fill: 2, differs: 2, duplicate: 1, invalid: 1, all: 6 });
    });

    it("shows every row with the filter for all", () => {
        expect(lines("all")).toEqual([1, 2, 3, 4, 5, 6]);
    });
});

describe("search in the review", () => {
    const r = row({ name: "Bäckerei Müller", purpose: "Brötchen", iban: "DE02120300000000202051", reference: "REF-77" });

    it("finds name, purpose, IBAN and reference without case and accents", () => {
        for (const text of ["backerei", "MULLER", "brotchen", "de0212", "ref-77", "  "]) expect(matchesSearch(r, text)).toBe(true);
        expect(matchesSearch(r, "Metzgerei")).toBe(false);
    });

    it("finds an IBAN typed with spaces", () => {
        expect(matchesSearch(r, "DE02 1203 0000")).toBe(true);
    });
});

describe("choice of rows in the review", () => {
    const fresh = row({ line: 1, state: "new", newCategory: "Neu A" });
    const other = row({ line: 2, state: "new", newCategory: "Neu B" });
    const fill = row({ line: 3, state: "duplicate", fillsDetails: true });
    const same = row({ line: 4, state: "duplicate" });
    const differs = row({ line: 5, state: "duplicate", categoryState: "differs", categoryId: 7 });
    const bad = row({ line: 6, state: "invalid", error: "x" });
    const all = [fresh, other, fill, same, differs, bad];

    it("offers only rows that change something", () => {
        expect(all.filter((x) => rowSelectable(x, false)).map((x) => x.line)).toEqual([1, 2, 3]);
        expect(all.filter((x) => rowSelectable(x, true)).map((x) => x.line)).toEqual([1, 2, 3, 5]);
    });

    it("takes everything that changes something by default", () => {
        expect(reviewOutcome(all, NO_CHOICE)).toMatchObject({ fresh: 2, fills: 1, changes: 0, affected: 3, leftOut: 0, missing: ["Neu A", "Neu B"] });
    });

    it("counts only the rows still selected", () => {
        const outcome = reviewOutcome(all, { ...NO_CHOICE, excluded: new Set([2, 3]), createCategories: true });
        expect(outcome).toMatchObject({ fresh: 1, fills: 0, affected: 1, leftOut: 2, missing: ["Neu A"], create: true });
    });

    it("overwrites only selected differing rows", () => {
        expect(reviewOutcome(all, { ...NO_CHOICE, overwriteCategories: true })).toMatchObject({ overwrite: true, changes: 1, affected: 4 });
        expect(reviewOutcome(all, { ...NO_CHOICE, overwriteCategories: true, excluded: new Set([5]) })).toMatchObject({ overwrite: false, changes: 0, affected: 3, leftOut: 1 });
    });

    it("says what happens to a stored category that differs", () => {
        const absent = row({ line: 7, state: "duplicate", categoryState: "differs", categoryId: null, newCategory: "Neu C" });
        expect(categoryChange(differs, NO_CHOICE)).toBe("no-overwrite");
        expect(categoryChange(differs, { ...NO_CHOICE, overwriteCategories: true })).toBe("replaced");
        expect(categoryChange(differs, { ...NO_CHOICE, overwriteCategories: true, excluded: new Set([5]) })).toBe("left-out");
        expect(categoryChange(absent, { ...NO_CHOICE, overwriteCategories: true })).toBe("needs-category");
        expect(categoryChange(absent, { ...NO_CHOICE, overwriteCategories: true, createCategories: true })).toBe("replaced");
    });
});
