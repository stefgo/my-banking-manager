import { describe, expect, it } from "vitest";
import { detectDelimiter, duplicateKey, guessColumns, mapRows, readCsv, sameCounterparty, splitCsv } from "./csv.js";
import { parseDate } from "./dates.js";

const SPARKASSE = [
    "\"Auftragskonto\";\"Buchungstag\";\"Valutadatum\";\"Buchungstext\";\"Verwendungszweck\";\"Glaeubiger ID\";\"Mandatsreferenz\";\"Kundenreferenz (End-to-End)\";\"Sammlerreferenz\";\"Lastschrift Ursprungsbetrag\";\"Auslagenersatz Ruecklastschrift\";\"Beguenstigter/Zahlungspflichtiger\";\"Kontonummer/IBAN\";\"BIC (SWIFT-Code)\";\"Betrag\";\"Waehrung\";\"Info\"",
    "\"DE89370400440532013000\";\"03.11.26\";\"03.11.26\";\"LASTSCHRIFT\";\"Einkauf; Filiale 12\";\"\";\"\";\"\";\"\";\"\";\"\";\"REWE Markt GmbH\";\"DE02120300000000202051\";\"BYLADEM1001\";\"-54,23\";\"EUR\";\"Umsatz gebucht\"",
    "\"DE89370400440532013000\";\"04.11.26\";\"04.11.26\";\"GUTSCHRIFT\";\"Lohn/Gehalt\nOktober\";\"\";\"\";\"\";\"\";\"\";\"\";\"Muster AG\";\"\";\"\";\"2.850,00\";\"EUR\";\"Umsatz vorgemerkt\"",
].join("\r\n");

const MONEYMONEY = "Datum;Wertstellung;Kategorie;Name;Verwendungszweck;Konto;Bank;Betrag;Währung\n01.10.2026;01.10.2026;Wohnen\\Miete;Hausverwaltung;Miete Oktober;DE..;Spk;-950,00;EUR\n";

describe("splitCsv", () => {
    it("keeps delimiters and line breaks inside quotes", () => {
        expect(splitCsv("a;\"b;c\";\"d\"\"e\"\n1;\"2\n3\";4", ";")).toEqual([
            ["a", "b;c", "d\"e"],
            ["1", "2\n3", "4"],
        ]);
    });
});

describe("detectDelimiter", () => {
    it("finds semicolons, commas and tabs", () => {
        expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
        expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
        expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    });
});

describe("Sparkasse CSV-CAMT", () => {
    const table = readCsv(SPARKASSE);
    const map = guessColumns(table.header);

    it("maps the columns by name", () => {
        expect(map.date).toBe(1);
        expect(map.valueDate).toBe(2);
        expect(map.bookingText).toBe(3);
        expect(map.purpose).toBe(4);
        expect(map.name).toBe(11);
        expect(map.iban).toBe(12);
        expect(map.amount).toBe(14);
        expect(map.status).toBe(16);
    });

    it("reads bookings", () => {
        const rows = mapRows(table, map);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ date: "2026-11-03", amount: -5423, name: "REWE Markt GmbH", iban: "DE02120300000000202051", bookingText: "LASTSCHRIFT", pending: false, error: null });
        expect(rows[1]).toMatchObject({ date: "2026-11-04", amount: 285000, purpose: "Lohn/Gehalt Oktober", pending: true });
    });
});

describe("MoneyMoney export", () => {
    it("maps date, category, name and amount", () => {
        const table = readCsv(MONEYMONEY);
        const map = guessColumns(table.header);
        expect(map).toMatchObject({ date: 0, valueDate: 1, category: 2, name: 3, purpose: 4, iban: 5, amount: 7 });
        expect(mapRows(table, map)[0]).toMatchObject({ date: "2026-10-01", amount: -95000, category: "Wohnen\\Miete" });
    });
});

describe("counterparty account column", () => {
    it("takes \"Konto\" only as the whole name, not \"Auftragskonto\"", () => {
        expect(guessColumns(["Buchungstag", "Auftragskonto", "Betrag"]).iban).toBeNull();
        expect(guessColumns(["Buchungstag", "Auftragskonto", "Konto", "Betrag"]).iban).toBe(2);
    });
});

describe("kind of booking column", () => {
    it("is not taken as amount or date", () => {
        expect(guessColumns(["Buchungstag", "Umsatzart", "Name", "Verwendungszweck", "Betrag in Euro"])).toMatchObject({ date: 0, bookingText: 1, amount: 4 });
        expect(guessColumns(["Wertstellung", "Buchungstext", "Name", "Betrag"])).toMatchObject({ date: null, valueDate: 0, bookingText: 1, amount: 3 });
    });

    it("matches the whole column name only", () => {
        expect(guessColumns(["Buchungstag", "Vorgangsnummer", "Betrag"]).bookingText).toBeNull();
    });

    it("leaves \"Umsatztyp\" unassigned", () => {
        const map = guessColumns(["Buchungstag", "Umsatztyp", "Betrag in Euro"]);
        expect(map).toMatchObject({ bookingText: null, amount: 2 });
    });
});

describe("rows with errors", () => {
    it("keeps the error on the row", () => {
        const table = readCsv("Datum;Betrag;Name\n32.13.2026;1,00;X\n01.01.2026;abc;Y\n");
        const rows = mapRows(table, guessColumns(table.header));
        expect(rows[0]!.error).toMatch(/Datum/);
        expect(rows[1]!.error).toMatch(/Betrag/);
    });
});

describe("duplicateKey", () => {
    it("takes day and amount only", () => {
        expect(duplicateKey("2026-11-01", -100)).toBe("2026-11-01|-100");
        expect(duplicateKey("2026-11-01", -100)).not.toBe(duplicateKey("2026-11-02", -100));
    });
});

describe("sameCounterparty", () => {
    const IBAN = "DE02120300000000202051";
    const party = (iban: string | null, name: string, purpose = "") => ({ iban, name, purpose });

    it("compares the IBANs when both have one, regardless of the name", () => {
        expect(sameCounterparty(party(IBAN, "Bäckerei Huber"), party("DE02 1203 0000 0000 2020 51", "Huber GmbH"))).toBe(true);
        expect(sameCounterparty(party(IBAN, "Bäckerei Huber"), party("DE89370400440532013000", "Bäckerei Huber"))).toBe(false);
    });

    it("compares the normalized names when one IBAN is missing", () => {
        expect(sameCounterparty(party(IBAN, "Bäckerei Müller GmbH"), party(null, "BACKEREI MULLER GMBH."))).toBe(true);
        expect(sameCounterparty(party("", "Bäckerei Müller"), party(null, "Huber"))).toBe(false);
    });

    it("ignores the purpose while both names are there", () => {
        expect(sameCounterparty(party(null, "Huber", "Miete"), party(null, "Huber", "Strom"))).toBe(true);
        expect(sameCounterparty(party(null, "Huber", "Miete"), party(null, "Müller", "Miete"))).toBe(false);
    });

    it("needs the purpose of the file inside the stored one when a name is missing", () => {
        expect(sameCounterparty(party(null, "", "Entgelt Oktober 2026, Kontofuehrung"), party(null, "Entgeltabrechnung", "ENTGELT oktober 2026"))).toBe(true);
        expect(sameCounterparty(party(IBAN, "Huber", "Rechnung 4711 vom Mai"), party(null, " – ", "Rechnung 4711"))).toBe(true);
        expect(sameCounterparty(party(null, "", "Entgelt Oktober"), party(null, "Entgeltabrechnung", "Entgelt November"))).toBe(false);
    });

    it("does not take a longer purpose of the file as contained", () => {
        expect(sameCounterparty(party(null, "", "Rechnung 4711"), party(null, "Huber", "Rechnung 4711 vom Mai"))).toBe(false);
    });

    it("matches an empty purpose of the file only against an empty one", () => {
        expect(sameCounterparty(party(null, ""), party(null, ""))).toBe(true);
        expect(sameCounterparty(party(null, "", "Entgelt"), party(null, "Huber"))).toBe(false);
    });

    it("never matches two different IBANs, even with the same purpose", () => {
        expect(sameCounterparty(party(IBAN, "", "Miete"), party("DE89370400440532013000", "", "Miete"))).toBe(false);
    });

    it("compares account numbers when there is no IBAN on both sides", () => {
        // Loan interest: the bank names its internal account by number only, without name or purpose
        const bank = { iban: null, counterpartyAccount: "9000926924", name: "", purpose: "" };
        const file = { iban: null, counterpartyAccount: "9000926924", name: "Darlehenszins", purpose: "" };
        expect(sameCounterparty({ ...bank, purpose: "Zinsen 3. Quartal" }, file)).toBe(true);
        expect(sameCounterparty({ ...bank, counterpartyAccount: "0009000926924" }, file)).toBe(true);
        expect(sameCounterparty({ ...bank, counterpartyAccount: "9000926925" }, file)).toBe(false);
    });

    it("lets an IBAN on both sides decide before the account number", () => {
        expect(sameCounterparty({ iban: IBAN, counterpartyAccount: "1", name: "", purpose: "" }, { iban: IBAN, counterpartyAccount: "2", name: "", purpose: "" })).toBe(true);
    });

    it("falls back to the name with an account number on one side only", () => {
        expect(sameCounterparty({ iban: null, counterpartyAccount: "", name: "Huber", purpose: "" }, { iban: null, counterpartyAccount: "123", name: "Huber", purpose: "" })).toBe(true);
    });
});

describe("parseDate", () => {
    it.each([
        ["31.12.2026", "2026-12-31"],
        ["1.2.26", "2026-02-01"],
        ["2026-02-28", "2026-02-28"],
        ["2026-02-30", null],
        ["12/31/2026", null],
    ])("%s → %s", (input, iso) => {
        expect(parseDate(input)).toBe(iso);
    });
});
