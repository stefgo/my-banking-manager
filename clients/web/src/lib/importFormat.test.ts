import { describe, expect, it } from "vitest";
import { BUILTIN_IMPORT_FORMATS, type ImportFormatDefinition, type ImportPreview } from "@mbm/shared";
import { categoryChange, copyName, emptyFormat, fieldsSummary, fileSummary, formatColumns, formatProblem, matchesFilter, matchesSearch, newStep, parseReviewSearch, NO_CHOICE, partName, pruneRefs, replaceStep, reviewCounts, reviewOutcome, rowCheck, rowSelectable, setRowPart, shownSelection, sourceKey, sourceOptions, stepsSummary, toggleRow, toggleShown } from "./importFormat";

type Row = ImportPreview["rows"][number];

const MONEY = BUILTIN_IMPORT_FORMATS.find((f) => f.key === "builtin:moneymoney")!.definition;
const row = (over: Partial<Row>): Row => ({
    line: 1, date: "2026-11-01", amount: -100, name: "Markt", iban: null, purpose: "", shownName: null, shownPurpose: null, bookingText: "", fillsBookingText: false, reference: "", customerReference: "", bankReference: "", mandateId: "", creditorId: "", counterpartyBic: "", fillsDetails: false, fills: [],
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
        expect(fieldsSummary(MONEY)).toBe("12 von 15 zugeordnet");
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
        row({ line: 7, state: "duplicate", categoryState: "empty", categoryId: 7 }),
    ];
    const lines = (f: Parameters<typeof matchesFilter>[1]) => rows.filter((r) => matchesFilter(r, f)).map((r) => r.line);

    it("shows what the import does by default, without bare conflicts", () => {
        expect(lines("changes")).toEqual([1, 3, 5, 6, 7]);
    });

    it("sorts rows into the tiles", () => {
        expect(lines("new")).toEqual([1]);
        expect(lines("fill")).toEqual([3, 6, 7]);
        expect(lines("differs")).toEqual([4, 6]);
        expect(lines("duplicate")).toEqual([2]);
        expect(lines("invalid")).toEqual([5]);
    });

    it("counts per filter", () => {
        expect(reviewCounts(rows)).toEqual({ changes: 5, new: 1, fill: 3, differs: 2, duplicate: 1, invalid: 1, all: 7 });
    });

    it("shows every row with the filter for all", () => {
        expect(lines("all")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
});

describe("search in the review", () => {
    const r = row({ name: "Bäckerei Müller", purpose: "Brötchen", iban: "DE02120300000000202051", reference: "REF-77" });

    const finds = (row: Row, text: string) => matchesSearch(row, parseReviewSearch(text, "2026-11-27"));

    it("finds name, purpose, IBAN and reference without case and accents", () => {
        for (const text of ["backerei", "MULLER", "brotchen", "de0212", "ref-77", "  "]) expect(finds(r, text)).toBe(true);
        expect(finds(r, "Metzgerei")).toBe(false);
    });

    it("finds an IBAN typed with spaces", () => {
        expect(finds(r, "DE02 1203 0000")).toBe(true);
    });

    it("compares the booking date with > >= < <= = and :", () => {
        // r is booked on 2026-11-01
        for (const text of ["datum>31.10.2026", "datum>=1.11.2026", "datum<2.11.2026", "datum<=1.11.2026", "datum=1.11.2026", "datum:11.2026", "datum:>=2026-11", "date<2027", "Datum>= 1.11.2026"]) expect(finds(r, text)).toBe(true);
        for (const text of ["datum>1.11.2026", "datum>=2.11.2026", "datum<1.11.2026", "datum<=31.10.2026", "datum=2.11.2026", "datum:10.2026", "datum>=2026-12"]) expect(finds(r, text)).toBe(false);
    });

    it("reads relative dates and combines dates with text", () => {
        expect(finds(r, "datum:vormonat")).toBe(false);
        expect(finds(r, "datum:monat backerei")).toBe(true);
        expect(finds(r, "datum>=1.11.2026 datum<=30.11.2026 brotchen")).toBe(true);
        expect(finds(r, "datum>=1.11.2026 metzgerei")).toBe(false);
        expect(finds(row({ date: null }), "datum>2000")).toBe(false);
    });

    it("names a date it cannot read and searches without it", () => {
        expect(parseReviewSearch("datum>=32.1.2026 markt")).toMatchObject({ text: "markt", dates: [], error: expect.stringContaining("„32.1.2026“ ist kein gültiges Datum") });
        expect(parseReviewSearch("datum>=").error).toBe("Nach „datum>=“ fehlt ein Datum");
        expect(parseReviewSearch("aktualisierungsdatum").dates).toEqual([]);
    });
});

describe("choice of rows in the review", () => {
    const fresh = row({ line: 1, state: "new", newCategory: "Neu A" });
    const other = row({ line: 2, state: "new", newCategory: "Neu B" });
    const fill = row({ line: 3, state: "duplicate", fillsDetails: true });
    const same = row({ line: 4, state: "duplicate" });
    const differs = row({ line: 5, state: "duplicate", categoryState: "differs", categoryId: 7 });
    const bad = row({ line: 6, state: "invalid", error: "x" });
    const empty = row({ line: 7, state: "duplicate", categoryState: "empty", categoryId: 7 });
    const both = row({ line: 8, state: "duplicate", categoryState: "differs", categoryId: 7, fillsDetails: true });
    const all = [fresh, other, fill, same, differs, bad, empty, both];

    it("offers only rows with something to decide", () => {
        expect(all.filter(rowSelectable).map((x) => x.line)).toEqual([1, 2, 3, 5, 7, 8]);
    });

    it("takes what is new or empty by default and replaces no category", () => {
        expect(reviewOutcome(all, NO_CHOICE)).toMatchObject({ fresh: 2, fills: 3, changes: 0, affected: 5, leftOut: 0, differing: 2, chosen: 0, missing: ["Neu A", "Neu B"] });
        expect([fresh, fill, empty, differs, both, same].map((x) => rowCheck(x, NO_CHOICE))).toEqual(["on", "on", "on", "off", "partial", "none"]);
    });

    it("counts only the rows still selected", () => {
        const outcome = reviewOutcome(all, { ...NO_CHOICE, excluded: new Set([2, 3]), createCategories: true });
        expect(outcome).toMatchObject({ fresh: 1, fills: 2, affected: 3, leftOut: 2, missing: ["Neu A"], create: true });
    });

    it("replaces the category of a single row", () => {
        const choice = toggleRow(differs, NO_CHOICE);
        expect(choice.replaced).toEqual(new Set([5]));
        expect(reviewOutcome(all, choice)).toMatchObject({ changes: 1, chosen: 1, affected: 6 });
        expect(toggleRow(differs, choice).replaced).toEqual(new Set());
    });

    it("clicks a row with both decisions from partly to all to nothing", () => {
        const on = toggleRow(both, NO_CHOICE);
        expect(rowCheck(both, on)).toBe("on");
        const off = toggleRow(both, on);
        expect(rowCheck(both, off)).toBe("off");
        expect(off.excluded).toEqual(new Set([8]));
        expect(off.replaced).toEqual(new Set());
    });

    it("decides the category and the filled-in values of a row separately", () => {
        const onlyCategory = setRowPart([both], "take", false, setRowPart([both], "category", true, NO_CHOICE));
        expect(rowCheck(both, onlyCategory)).toBe("partial");
        expect(reviewOutcome([both], onlyCategory)).toMatchObject({ changes: 1, fills: 0, affected: 1, leftOut: 1 });
    });

    it("never replaces categories with all shown outside the filter for them", () => {
        const off = toggleShown(all, "changes", NO_CHOICE);
        expect(off.replaced).toEqual(new Set());
        expect(off.excluded).toEqual(new Set([1, 2, 3, 7, 8]));
        expect(toggleShown(all, "changes", off).replaced).toEqual(new Set());
        expect(toggleShown(all, "all", NO_CHOICE).replaced).toEqual(new Set());
    });

    it("replaces all shown conflicts under their filter and leaves the rest", () => {
        const conflicts = [differs, both];
        const on = toggleShown(conflicts, "differs", NO_CHOICE);
        expect(on.replaced).toEqual(new Set([5, 8]));
        expect(on.excluded).toEqual(new Set());
        expect(shownSelection(conflicts, "differs", on)).toMatchObject({ targets: 2, all: true, some: false, chosen: 2 });
        expect(toggleShown(conflicts, "differs", on).replaced).toEqual(new Set());
        expect(shownSelection(conflicts, "differs", { ...NO_CHOICE, replaced: new Set([5]) })).toMatchObject({ all: false, some: true });
    });

    it("writes a missing category only when it gets created", () => {
        const absent = row({ line: 9, state: "duplicate", categoryState: "differs", categoryId: null, newCategory: "Neu C" });
        const hollow = row({ line: 10, state: "duplicate", categoryState: "empty", categoryId: null, newCategory: "Neu D" });
        const chosen = { ...NO_CHOICE, replaced: new Set([9]) };
        expect(reviewOutcome([absent, hollow], NO_CHOICE)).toMatchObject({ missing: ["Neu D"], fills: 0, affected: 0, blocked: true });
        expect(reviewOutcome([absent, hollow], chosen)).toMatchObject({ missing: ["Neu D", "Neu C"], changes: 0, blocked: true });
        expect(reviewOutcome([absent, hollow], { ...chosen, createCategories: true })).toMatchObject({ changes: 1, fills: 1, affected: 2, blocked: false, create: true });
    });

    it("says what happens to a stored category", () => {
        const absent = row({ line: 9, state: "duplicate", categoryState: "differs", categoryId: null, newCategory: "Neu C" });
        const hollow = row({ line: 10, state: "duplicate", categoryState: "empty", categoryId: null, newCategory: "Neu D" });
        const replaced = new Set([5, 9]);
        expect(categoryChange(differs, NO_CHOICE)).toBe("not-chosen");
        expect(categoryChange(differs, { ...NO_CHOICE, replaced })).toBe("replaced");
        expect(categoryChange(differs, { ...NO_CHOICE, replaced, excluded: new Set([5]) })).toBe("replaced");
        expect(categoryChange(absent, { ...NO_CHOICE, replaced })).toBe("needs-category");
        expect(categoryChange(absent, { ...NO_CHOICE, replaced, createCategories: true })).toBe("replaced");
        expect(categoryChange(empty, NO_CHOICE)).toBe("filled");
        expect(categoryChange(empty, { ...NO_CHOICE, excluded: new Set([7]) })).toBe("left-out");
        expect(categoryChange(hollow, NO_CHOICE)).toBe("needs-category");
        expect(categoryChange(hollow, { ...NO_CHOICE, createCategories: true })).toBe("filled");
    });
});
