import { describe, expect, it } from "vitest";
import { guessColumns, readCsv } from "./csv.js";
import { parseDate } from "./dates.js";
import { columnsFromFormat, formatFromColumns, formatIssues, mapFormatRows, matchFormat, missingColumns, readWithFormat, referenceMatch } from "./importFormat.js";
import { BUILTIN_IMPORT_FORMATS } from "./importPresets.js";
import { parseAmount } from "./money.js";
import { ImportFormatDefinition, type FormatStep } from "./schemas/banking.js";

const preset = (key: string) => BUILTIN_IMPORT_FORMATS.find((f) => f.key === key)!.definition;
const MONEY = preset("builtin:moneymoney");
const HEADER = "Datum;Wertstellung;Kategorie;Name;Verwendungszweck;Konto;Bank;Betrag;Währung";
const row = (purpose: string) => `19.11.2026;19.11.2026;Alle - Wohnen - Miete;Muster GmbH;${purpose};DE02120300000000202051;BYLADEM1001;-1,00;EUR`;
const read = (purpose: string) => {
    const table = readWithFormat(`${HEADER}\n${row(purpose)}\n`, MONEY);
    return mapFormatRows(table, MONEY)[0]!;
};

const base = (steps: FormatStep[], fields: ImportFormatDefinition["fields"]): ImportFormatDefinition => ({
    version: 1,
    file: { encoding: "auto", delimiter: ";", quote: "\"", headerLine: 1 },
    steps,
    fields: { bookingDate: [{ column: "Datum" }], amount: [{ column: "Betrag" }], ...fields },
    values: { dateOrder: "dmy", decimalSeparator: ",", categorySeparator: "auto", pendingWords: [] },
});

describe("keywords step", () => {
    it("takes the details out of the purpose and keeps the free text", () => {
        expect(read("Übertrag, Umsatzart: Echtzeitüberweisung, Referenz: MBM-ABC, Mandat: M1, Gläubiger-ID: DE98ZZZ")).toMatchObject({
            purpose: "Übertrag",
            bookingText: "Echtzeitüberweisung",
            reference: "MBM-ABC",
            mandateId: "M1",
            creditorId: "DE98ZZZ",
            counterpartyBic: "BYLADEM1001",
            amount: -100,
            date: "2026-11-19",
        });
    });

    it("finds a keyword at the very start and leaves no free text", () => {
        expect(read("Umsatzart: Sonstiger Einzug")).toMatchObject({ purpose: "", bookingText: "Sonstiger Einzug" });
    });

    it("keeps a keyword no field takes in the rest", () => {
        expect(read("Text, Umsatzart: LS Rückbelastung, Rückgabegrund: Widerspruch, Referenz: R1")).toMatchObject({
            purpose: "Text, Rückgabegrund: Widerspruch",
            bookingText: "LS Rückbelastung",
            reference: "R1",
        });
        expect(read("Umsatzart: X, Rückgabegrund: Y").purpose).toBe("Rückgabegrund: Y");
    });

    it("takes the last occurrence, an earlier one stays in the free text", () => {
        expect(read("Referenz: alt, Umsatzart: X, Referenz: neu")).toMatchObject({ purpose: "Referenz: alt", reference: "neu", bookingText: "X" });
    });

    it("leaves a text without keywords whole", () => {
        expect(read("Nur ein Text, mit Komma")).toMatchObject({ purpose: "Nur ein Text, mit Komma", bookingText: "", reference: "" });
    });

    it("without a prefix does not match the end of a longer word", () => {
        const def = base(
            [{ id: "a", input: { column: "Zweck" }, type: "keywords", prefix: "", suffix: ": ", keywords: [{ text: "Mandat", part: "mandate" }] }],
            { mandateId: [{ step: "a", part: "mandate" }], remittance: [{ step: "a", part: "rest" }] },
        );
        const table = readWithFormat("Datum;Zweck;Betrag\n01.10.2026;Erstmandat: 1;2,00\n", def);
        expect(mapFormatRows(table, def)[0]).toMatchObject({ mandateId: "", purpose: "Erstmandat: 1" });
    });
});

describe("several steps", () => {
    it("takes a part of one step apart in the next", () => {
        const def = base(
            [
                { id: "first", input: { column: "Text" }, type: "separator", separator: " // ", parts: ["left", "right"] },
                { id: "second", input: { step: "first", part: "right" }, type: "keywords", prefix: " ", suffix: "=", keywords: [{ text: "REF", part: "ref" }] },
            ],
            { remittance: [{ step: "first", part: "left" }], bookingText: [{ step: "second", part: "rest" }], reference: [{ step: "second", part: "ref" }] },
        );
        const table = readWithFormat("Datum;Text;Betrag\n01.10.2026;Miete // Lastschrift REF=42;-5,00\n", def);
        expect(mapFormatRows(table, def)[0]).toMatchObject({ purpose: "Miete", bookingText: "Lastschrift", reference: "42" });
    });

    it("keeps pieces beyond the named parts in the rest", () => {
        const def = base([{ id: "s", input: { column: "Text" }, type: "separator", separator: "|", parts: ["a"] }], { bookingText: [{ step: "s", part: "a" }], remittance: [{ step: "s", part: "rest" }] });
        const table = readWithFormat("Datum;Text;Betrag\n01.10.2026;x|y|z;1,00\n", def);
        expect(mapFormatRows(table, def)[0]).toMatchObject({ bookingText: "x", purpose: "y|z" });
    });

    it("joins several sources of a field", () => {
        const def = base([], { remittance: [{ column: "A" }, { column: "B" }] });
        const table = readWithFormat("Datum;A;B;Betrag\n01.10.2026;eins;zwei;1,00\n", def);
        expect(mapFormatRows(table, def)[0]!.purpose).toBe("eins zwei");
    });
});

describe("reading the file", () => {
    it("splits at a delimiter of several characters", () => {
        const def = { ...base([], {}), file: { encoding: "auto", delimiter: "||", quote: null, headerLine: 1 } } as ImportFormatDefinition;
        expect(readWithFormat("Datum||Betrag\n01.10.2026||1,00\n", def).rows).toEqual([["01.10.2026", "1,00"]]);
    });

    it("reads a file without a header by position", () => {
        const def = { ...base([], { bookingDate: [{ columnIndex: 0 }], amount: [{ columnIndex: 1 }] }), file: { encoding: "auto", delimiter: ";", quote: "\"", headerLine: "none" } } as ImportFormatDefinition;
        const table = readWithFormat("01.10.2026;1,00\n02.10.2026;2,00\n", def);
        expect(table.header).toEqual(["Spalte 1", "Spalte 2"]);
        expect(mapFormatRows(table, def).map((r) => r.amount)).toEqual([100, 200]);
    });

    it("takes the header from the given line", () => {
        const def = { ...base([], {}), file: { encoding: "auto", delimiter: ";", quote: "\"", headerLine: 2 } } as ImportFormatDefinition;
        expect(readWithFormat("Kontoauszug;x\nDatum;Betrag\n01.10.2026;1,00\n", def).header).toEqual(["Datum", "Betrag"]);
    });
});

describe("fixed value forms", () => {
    it("reads dates in the given order", () => {
        expect(parseDate("03/04/2026", "mdy")).toBe("2026-03-04");
        expect(parseDate("03/04/2026", "dmy")).toBe("2026-04-03");
        expect(parseDate("2026.04.03", "ymd")).toBe("2026-04-03");
        expect(parseDate("31.02.2026", "dmy")).toBeNull();
    });

    it("reads amounts with the given decimal separator", () => {
        expect(parseAmount("1,234", ".")).toBe(123400);
        expect(parseAmount("1.234", ",")).toBe(123400);
        expect(parseAmount("1.234,56", ",")).toBe(123456);
        expect(parseAmount("1,2,3", ",")).toBeNull();
    });
});

describe("choosing a format", () => {
    it("recognizes both built-in formats by their header", () => {
        expect(matchFormat(`${HEADER}\n${row("x")}\n`, BUILTIN_IMPORT_FORMATS)?.key).toBe("builtin:moneymoney");
        const sparkasse = "\"Auftragskonto\";\"Buchungstag\";\"Valutadatum\";\"Buchungstext\";\"Verwendungszweck\";\"Glaeubiger ID\";\"Mandatsreferenz\";\"Kundenreferenz (End-to-End)\";\"Sammlerreferenz\";\"Lastschrift Ursprungsbetrag\";\"Auslagenersatz Ruecklastschrift\";\"Beguenstigter/Zahlungspflichtiger\";\"Kontonummer/IBAN\";\"BIC (SWIFT-Code)\";\"Betrag\";\"Waehrung\";\"Info\"\n";
        expect(matchFormat(sparkasse, BUILTIN_IMPORT_FORMATS)?.key).toBe("builtin:sparkasse-camt");
    });

    it("prefers the earlier of two equal candidates", () => {
        const own = { key: "custom:1", definition: MONEY };
        expect(matchFormat(`${HEADER}\n`, [own, ...BUILTIN_IMPORT_FORMATS])?.key).toBe("custom:1");
    });

    it("finds none for another header", () => {
        expect(matchFormat("Tag;Wert\n01.10.2026;1,00\n", BUILTIN_IMPORT_FORMATS)).toBeNull();
    });

    it("names the columns a file lacks", () => {
        expect(missingColumns(MONEY, ["Datum", "Betrag"])).toContain("Verwendungszweck");
    });
});

describe("plain column assignments", () => {
    it("turn into a format and back", () => {
        const { header } = readCsv(`${HEADER}\n${row("x")}\n`);
        const map = guessColumns(header);
        expect(columnsFromFormat(formatFromColumns(map, header), header)).toEqual(map);
    });

    it("go by position where a column name repeats", () => {
        const def = formatFromColumns({ ...guessColumns(["Datum", "Betrag", "X", "X"]), purpose: 3 }, ["Datum", "Betrag", "X", "X"]);
        expect(def.fields.remittance).toEqual([{ columnIndex: 3 }]);
    });

    it("recognize the columns of the new details", () => {
        expect(guessColumns(["Buchungstag", "Betrag", "Glaeubiger ID", "Mandatsreferenz", "Kundenreferenz (End-to-End)", "BIC (SWIFT-Code)", "Sammlerreferenz"])).toMatchObject({ creditorId: 2, mandateId: 3, reference: 4, counterpartyBic: 5 });
    });

    it("recognize customer and bank reference only by their whole name", () => {
        expect(guessColumns(["Buchungstag", "Betrag", "Kundenreferenz (End-to-End)"])).toMatchObject({ reference: 2, customerReference: null, bankReference: null });
        expect(guessColumns(["Buchungstag", "Betrag", "Referenz", "Kundenreferenz", "Bankreferenz"])).toMatchObject({ reference: 2, customerReference: 3, bankReference: 4 });
    });
});

describe("validating a format", () => {
    it("accepts the built-in formats", () => {
        for (const f of BUILTIN_IMPORT_FORMATS) expect(ImportFormatDefinition.safeParse(f.definition).success).toBe(true);
    });

    it("rejects a step reading a later step or an unknown part", () => {
        const later = base(
            [
                { id: "a", input: { step: "b", part: "x" }, type: "separator", separator: ",", parts: ["x"] },
                { id: "b", input: { column: "T" }, type: "separator", separator: ",", parts: ["x"] },
            ],
            {},
        );
        expect(formatIssues(later).length).toBeGreaterThan(0);
        expect(formatIssues(base([], { remittance: [{ step: "a", part: "x" }] })).length).toBe(1);
    });

    it("rejects doubled ids, doubled keywords and the reserved part", () => {
        const step: FormatStep = { id: "a", input: { column: "T" }, type: "keywords", prefix: "", suffix: ":", keywords: [{ text: "W", part: "rest" }, { text: "W", part: "rest" }] };
        expect(formatIssues(base([step, step], {})).length).toBeGreaterThanOrEqual(4);
    });

    it("rejects one source for two kinds of reference", () => {
        expect(formatIssues(base([], { reference: [{ column: "Ref" }], customerReference: [{ column: "Ref" }] }))).toEqual(["End-to-End-Referenz und Kundenreferenz lesen dieselbe Quelle."]);
        expect(formatIssues(base([], { reference: [{ column: "Ref" }], bankReference: [{ column: "Bankref" }] }))).toEqual([]);
    });

    it("limits the number of steps", () => {
        const steps = Array.from({ length: 6 }, (_, i): FormatStep => ({ id: `s${i}`, input: { column: "T" }, type: "separator", separator: ",", parts: ["x"] }));
        expect(ImportFormatDefinition.safeParse(base(steps, {})).success).toBe(false);
    });
});

describe("reference fields", () => {
    const def = base([], { reference: [{ column: "Ref" }], customerReference: [{ column: "KRef" }], bankReference: [{ column: "BRef" }] });
    const read = (line: string, format = def) => mapFormatRows(readWithFormat(`Datum;Betrag;Ref;KRef;BRef\n${line}\n`, format), format)[0]!;

    it("reads each kind into its own field", () => {
        expect(read("19.11.2026;-1,00;E2E-1;KREF-1;BANK-1")).toMatchObject({ reference: "E2E-1", customerReference: "KREF-1", bankReference: "BANK-1" });
    });

    it("takes NOTPROVIDED as none and a value given before only once", () => {
        expect(read("19.11.2026;-1,00;NOTPROVIDED;X-1;x-1")).toMatchObject({ reference: "", customerReference: "X-1", bankReference: "" });
    });

    it("searches all kinds without a setting and always its own kind", () => {
        expect(referenceMatch(def, "reference")).toEqual(["reference", "customerReference", "bankReference"]);
        const set = { ...def, values: { ...def.values, referenceMatch: { reference: [], bankReference: ["customerReference" as const] } } };
        expect(referenceMatch(set, "reference")).toEqual(["reference"]);
        expect(referenceMatch(set, "bankReference")).toEqual(["customerReference", "bankReference"]);
        expect(referenceMatch(set, "customerReference")).toEqual(["reference", "customerReference", "bankReference"]);
    });

    it("reads stored formats without the setting", () => {
        expect(ImportFormatDefinition.safeParse(def).success).toBe(true);
        expect(ImportFormatDefinition.safeParse({ ...def, values: { ...def.values, referenceMatch: { reference: ["bankReference"] } } }).success).toBe(true);
        expect(ImportFormatDefinition.safeParse({ ...def, values: { ...def.values, referenceMatch: { reference: ["mandateId"] } } }).success).toBe(false);
    });
});
