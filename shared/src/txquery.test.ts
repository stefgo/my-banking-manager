import { describe, expect, it } from "vitest";
import { dateBounds, foldText, matchTxQuery, parseDateSpec, parseTxQuery, quoteTxQueryValue, toTxQueryTarget, TX_QUERY_FIELDS, type TxQueryInput } from "./txquery.js";

const TODAY = "2026-11-14"; // a Saturday

const base: TxQueryInput = {
    counterparty: "REWE Markt GmbH",
    remittance: "Kartenzahlung Teststraße 12",
    iban: "DE89370400440532013000",
    amount: -1299,
    category: "Lebensmittel",
    categoryPath: ["Lebensmittel", "Haushalt"],
    uncategorized: false,
    accountPath: ["Girokonto", "Alltag", "Privat"],
    accountIban: "DE12 5001 0517 0000 1234 56",
    bookingDate: "2026-03-14",
};

const salary: TxQueryInput = {
    counterparty: "Arbeitgeber AG",
    remittance: "Gehalt März und Bonus",
    iban: null,
    amount: 250000,
    category: "",
    categoryPath: [],
    uncategorized: true,
    accountPath: ["Bargeld"],
    accountIban: null,
    bookingDate: "2026-02-27",
};

function matches(q: string, tx: TxQueryInput = base): boolean {
    const r = parseTxQuery(q, { today: TODAY });
    if (!r.ok) throw new Error(`${q}: ${r.error}`);
    return matchTxQuery(r.query, toTxQueryTarget(tx));
}

function error(q: string, mode: "search" | "rule" = "search"): string {
    const r = parseTxQuery(q, { today: TODAY, mode });
    if (r.ok) throw new Error(`${q} should not parse`);
    return r.error;
}

describe("foldText", () => {
    it("ignores case, accents, ß and runs of whitespace", () => {
        expect(foldText("Café  Müller Straße")).toBe("cafe muller strasse");
    });
});

describe("text search", () => {
    it("finds a word in any field, as before", () => {
        expect(matches("")).toBe(true);
        expect(matches("rewe")).toBe(true);
        expect(matches("markt gmbh")).toBe(true);
        expect(matches("kartenzahlung")).toBe(true);
        expect(matches("de8937")).toBe(true);
        expect(matches("12,99")).toBe(true);
        expect(matches("2,99")).toBe(true);
        expect(matches("lebensmittel")).toBe(true);
        expect(matches("haushalt")).toBe(false);
        expect(matches("edeka")).toBe(false);
    });

    it("treats spaces as UND and quotes as a phrase", () => {
        expect(matches("rewe kartenzahlung")).toBe(true);
        expect(matches("rewe edeka")).toBe(false);
        expect(matches('"rewe markt"')).toBe(true);
        expect(matches('"markt rewe"')).toBe(false);
    });

    it("knows wildcards and ß as ss", () => {
        expect(matches("Test*strasse")).toBe(true);
        expect(matches("test*12")).toBe(true);
        expect(matches("r?we")).toBe(true);
        expect(matches("r??we")).toBe(false);
        expect(matches("rewe*kartenzahlung")).toBe(false); // wildcards stay within one field
        expect(matches("teststrasse")).toBe(true);
        expect(matches("TESTSTRAẞE")).toBe(true);
        expect(matches("a.b")).toBe(false);
    });

    it("takes lower-case und / oder as words", () => {
        expect(matches("märz und bonus", salary)).toBe(true);
        expect(matches("gehalt oder", salary)).toBe(false);
    });
});

describe("operators", () => {
    it("combines with UND, ODER, NICHT and parentheses", () => {
        expect(matches("rewe UND edeka")).toBe(false);
        expect(matches("rewe ODER edeka")).toBe(true);
        expect(matches("edeka OR aldi")).toBe(false);
        expect(matches("NICHT edeka")).toBe(true);
        expect(matches("NOT rewe")).toBe(false);
        expect(matches("-rewe")).toBe(false);
        expect(matches("-edeka rewe")).toBe(true);
        expect(matches("(edeka ODER rewe) >10")).toBe(true);
        expect(matches("(edeka ODER rewe) >20")).toBe(false);
        expect(matches("-(edeka ODER aldi)")).toBe(true);
    });

    it("binds UND stronger than ODER", () => {
        // rewe ODER (edeka UND aldi)
        expect(matches("rewe ODER edeka aldi")).toBe(true);
        // (edeka ODER rewe) is not what this means: edeka ODER (rewe UND aldi)
        expect(matches("edeka ODER rewe aldi")).toBe(false);
        expect(matches("(edeka ODER rewe) lebensmittel")).toBe(true);
    });
});

describe("fields", () => {
    it("searches in one field only", () => {
        expect(matches("gegenseite:rewe")).toBe(true);
        expect(matches("name:kartenzahlung")).toBe(false);
        expect(matches("zweck:kartenzahlung")).toBe(true);
        expect(matches("verwendungszweck:rewe")).toBe(false);
        expect(matches('gegenseite:"rewe markt"')).toBe(true);
        expect(matches("Gegenseite: rewe")).toBe(true);
        expect(matches("betrag:12,99")).toBe(true);
        expect(matches("betrag:rewe")).toBe(false);
    });

    it("compares IBANs without spaces", () => {
        expect(matches("iban:DE89*")).toBe(true);
        expect(matches('iban:"DE89 3704"')).toBe(true);
        expect(matches("iban:rewe")).toBe(false);
        expect(matches("iban:DE89*", salary)).toBe(false);
    });

    it("finds a category with its parents and bookings without one", () => {
        expect(matches("kategorie:lebensmittel")).toBe(true);
        expect(matches("kat:haushalt")).toBe(true);
        expect(matches("kat:-")).toBe(false);
        expect(matches("kat:-", salary)).toBe(true);
        expect(matches('kat:"ohne kategorie"', salary)).toBe(true);
        expect(matches("kat:haus*")).toBe(true);
    });

    it("finds new bookings with ist:neu", () => {
        expect(matches("ist:neu")).toBe(false);
        expect(matches("ist:neu", { ...base, unread: true })).toBe(true);
        expect(matches("Ist:Neu rewe", { ...base, unread: true })).toBe(true);
        expect(matches("-ist:neu", { ...base, unread: true })).toBe(false);
        expect(error("ist:alt")).toBe("„alt“ gibt es bei ist: nicht – möglich ist ist:neu");
        expect(error("ist:")).toBe("Nach „ist:“ fehlt ein Wert");
    });

    it("searches unknown fields as text", () => {
        expect(matches("foo:bar")).toBe(false);
        expect(matches("Teststraße:12", { ...base, remittance: "Teststraße:12" })).toBe(true);
    });
});

describe("amounts", () => {
    it("compares the amount without sign unless the value has one", () => {
        expect(matches(">10")).toBe(true);
        expect(matches("betrag>10", salary)).toBe(true);
        expect(matches("betrag:>10")).toBe(true);
        expect(matches("> 10")).toBe(true);
        expect(matches("<12,99")).toBe(false);
        expect(matches("<=12,99")).toBe(true);
        expect(matches("=12,99")).toBe(true);
        expect(matches("=12.99")).toBe(true);
        expect(matches(">10 <20")).toBe(true);
        expect(matches("<-10")).toBe(true);
        expect(matches("<-10", salary)).toBe(false);
        expect(matches(">+1000", salary)).toBe(true);
        expect(matches(">+1000")).toBe(false);
        expect(matches(">1.000", salary)).toBe(true);
        expect(matches(">2.500,01", salary)).toBe(false);
    });
});

describe("dates", () => {
    it("reads full and partial dates as intervals", () => {
        expect(parseDateSpec("2026")).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
        expect(parseDateSpec("2026-02")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
        expect(parseDateSpec("2.2028")).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
        expect(parseDateSpec("1.3.2026")).toMatchObject({ from: "2026-03-01", to: "2026-03-01" });
        expect(parseDateSpec("2026-3-1")).toMatchObject({ from: "2026-03-01", to: "2026-03-01" });
        expect(parseDateSpec("31.2.2026")).toBeNull();
        expect(parseDateSpec("13.2026")).toBeNull();
        expect(parseDateSpec("morgen")).toBeNull();
    });

    it("compares the booking date", () => {
        expect(matches("datum:2026-03")).toBe(true);
        expect(matches("datum:3.2026")).toBe(true);
        expect(matches("datum:2026")).toBe(true);
        expect(matches("datum:14.03.2026")).toBe(true);
        expect(matches("datum=2026-03-13")).toBe(false);
        expect(matches("datum>=1.3.2026")).toBe(true);
        expect(matches("datum>2026-03")).toBe(false);
        expect(matches("datum>2026-02")).toBe(true);
        expect(matches("datum<2026-03")).toBe(false);
        expect(matches("datum<=2026-03")).toBe(true);
        expect(matches("datum<2026")).toBe(false);
        expect(matches("datum>=2026-01 datum<=2026-03")).toBe(true);
        expect(matches("datum:>=2026-03-15")).toBe(false);
    });

    it("tells whether a query holds a date condition", () => {
        expect(parseTxQuery("rewe")).toMatchObject({ ok: true, hasDate: false });
        expect(parseTxQuery("rewe ODER -datum:2026")).toMatchObject({ ok: true, hasDate: true });
    });
});

describe("errors", () => {
    it("names what is wrong and where", () => {
        expect(parseTxQuery("rewe (edeka")).toEqual({ ok: false, error: "Schließende Klammer fehlt", at: 5 });
        expect(error("rewe)")).toBe("Öffnende Klammer fehlt");
        expect(error("()")).toBe("Leere Klammer");
        expect(error("rewe ODER")).toBe("Nach „ODER“ fehlt ein Suchbegriff");
        expect(error("rewe UND ODER edeka")).toBe("Nach „UND“ fehlt ein Suchbegriff");
        expect(error("ODER rewe")).toBe("Vor „ODER“ fehlt ein Suchbegriff");
        expect(error("NICHT")).toBe("Nach „NICHT“ fehlt ein Suchbegriff");
        expect(error('"rewe')).toBe("Anführungszeichen nicht geschlossen");
        expect(error(">")).toBe("Nach „>“ fehlt ein Wert");
        expect(error("zweck:")).toBe("Nach „zweck:“ fehlt ein Wert");
        expect(error(">abc")).toBe("„abc“ ist kein gültiger Betrag");
        expect(error(">2026-03")).toBe("„2026-03“ ist kein gültiger Betrag – für ein Datum: datum>2026-03");
        expect(error("datum:31.2.2026")).toMatch(/^„31.2.2026“ ist kein gültiges Datum/);
        expect(error("datum>morgen")).toMatch(/kein gültiges Datum/);
        expect(error("zweck>5")).toBe("Vergleiche gehen nur bei betrag und datum, nicht bei zweck");
    });

    it("limits length, terms and depth", () => {
        expect(error("x".repeat(201))).toMatch(/zu lang/);
        expect(error(Array.from({ length: 51 }, (_, i) => `w${i}`).join(" "))).toMatch(/Zu viele Suchbegriffe/);
        expect(parseTxQuery(Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ")).ok).toBe(true);
        expect(error(`${"(".repeat(11)}a${")".repeat(11)}`)).toMatch(/verschachtelte Klammern/);
        expect(parseTxQuery(`${"(".repeat(10)}a${")".repeat(10)}`).ok).toBe(true);
    });
});

describe("account field", () => {
    it("searches the account name, its groups and its IBAN, but not in free text", () => {
        expect(matches("konto:giro")).toBe(true);
        expect(matches("konto:alltag")).toBe(true);
        expect(matches("konto:privat")).toBe(true);
        expect(matches("konto:DE12*")).toBe(true);
        expect(matches('konto:"DE12 5001"')).toBe(true);
        expect(matches("konto:bargeld")).toBe(false);
        expect(matches("NICHT konto:bargeld")).toBe(true);
        expect(matches("konto:bargeld", salary)).toBe(true);
        expect(matches("girokonto")).toBe(false);
    });
});

describe("relative dates", () => {
    const span = (s: string) => {
        const d = parseDateSpec(s, TODAY);
        return d && [d.from, d.to];
    };

    it("reads the last days, weeks, months and years up to today", () => {
        expect(span("-30t")).toEqual(["2026-10-16", TODAY]);
        expect(span("-1t")).toEqual([TODAY, TODAY]);
        expect(span("-2w")).toEqual(["2026-11-01", TODAY]);
        expect(span("-3m")).toEqual(["2026-08-15", TODAY]);
        expect(span("-1J")).toEqual(["2025-11-15", TODAY]);
        expect(span("-0t")).toBeNull();
        expect(parseDateSpec("-3m", "2026-05-31")).toMatchObject({ from: "2026-03-01" });
        expect(parseDateSpec("-1m", "2024-03-31")).toMatchObject({ from: "2024-03-01" });
    });

    it("knows calendar periods by name", () => {
        expect(span("heute")).toEqual([TODAY, TODAY]);
        expect(span("Gestern")).toEqual(["2026-11-13", "2026-11-13"]);
        expect(span("woche")).toEqual(["2026-11-09", "2026-11-15"]);
        expect(span("vorwoche")).toEqual(["2026-11-02", "2026-11-08"]);
        expect(span("monat")).toEqual(["2026-11-01", "2026-11-30"]);
        expect(span("vormonat")).toEqual(["2026-10-01", "2026-10-31"]);
        expect(span("quartal")).toEqual(["2026-10-01", "2026-12-31"]);
        expect(span("vorquartal")).toEqual(["2026-07-01", "2026-09-30"]);
        expect(span("jahr")).toEqual(["2026-01-01", "2026-12-31"]);
        expect(span("vorjahr")).toEqual(["2025-01-01", "2025-12-31"]);
        expect(parseDateSpec("vormonat", "2026-01-10")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
        expect(parseDateSpec("vorquartal", "2026-02-10")).toMatchObject({ from: "2025-10-01", to: "2025-12-31" });
        expect(parseDateSpec("woche", "2026-11-09")).toMatchObject({ from: "2026-11-09", to: "2026-11-15" });
        expect(parseDateSpec("vormonat", TODAY)?.relative).toBe(true);
        expect(parseDateSpec("2026", TODAY)?.relative).toBe(false);
    });

    it("compares like partial dates", () => {
        const recent = { ...base, bookingDate: "2026-11-01" };
        expect(matches("datum:-30t", recent)).toBe(true);
        expect(matches("datum:-30t")).toBe(false);
        expect(matches("datum<-1j")).toBe(false);
        expect(matches("datum<-6m")).toBe(true);
        expect(matches("datum:jahr")).toBe(true);
        expect(matches("datum<vorjahr")).toBe(false);
        expect(matches("datum>=quartal", recent)).toBe(true);
        expect(matches("datum:vormonat", { ...base, bookingDate: "2026-10-31" })).toBe(true);
    });
});

describe("rules", () => {
    it("allows no kategorie:, no relative dates and no empty rule", () => {
        expect(parseTxQuery("gegenseite:rewe >10 konto:giro datum>=2026", { mode: "rule" }).ok).toBe(true);
        expect(error("kat:haushalt", "rule")).toMatch(/^kategorie: geht in Regeln nicht/);
        expect(error("ist:neu", "rule")).toMatch(/^ist: geht in Regeln nicht/);
        expect(error("datum:vormonat", "rule")).toMatch(/^Relative Datumsangaben gehen in Regeln nicht/);
        expect(error("datum>-30t", "rule")).toMatch(/^Relative Datumsangaben/);
        expect(error("  ", "rule")).toBe("Die Regel braucht mindestens einen Suchbegriff");
        expect(parseTxQuery("", { mode: "search" }).ok).toBe(true);
    });
});

describe("quoting", () => {
    it("reads escaped quotes and backslashes and quotes any text safely", () => {
        const odd = { ...base, counterparty: 'Café "Am Eck" C:\\ GmbH\\' };
        expect(matches('gegenseite:"\\"am eck\\""', odd)).toBe(true);
        for (const text of ['Café "Am Eck"', "PAYPAL *SPOTIFY", "a\\b", "end\\", '"']) {
            const q = `gegenseite:${quoteTxQueryValue(text)}`;
            expect(parseTxQuery(q).ok, q).toBe(true);
            expect(matches(q, { ...base, counterparty: `x ${text} y` }), q).toBe(true);
        }
        expect(quoteTxQueryValue('a"b\\')).toBe('"a\\"b\\\\"');
    });
});

describe("dateBounds", () => {
    const bounds = (q: string) => {
        const r = parseTxQuery(q, { today: TODAY });
        if (!r.ok) throw new Error(r.error);
        return dateBounds(r.query);
    };

    it("finds the span of days a query can match", () => {
        expect(bounds("rewe")).toEqual({});
        expect(bounds("datum:2026-03")).toEqual({ from: "2026-03-01", to: "2026-03-31" });
        expect(bounds("datum>=2026-01 datum<=2026-03 rewe")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
        expect(bounds("datum:2025 ODER datum:2026")).toEqual({ from: "2025-01-01", to: "2026-12-31" });
        expect(bounds("datum:2025 ODER rewe")).toEqual({ from: undefined, to: undefined });
        expect(bounds("datum>2026-03")).toEqual({ from: "2026-04-01" });
        expect(bounds("datum<2026")).toEqual({ to: "2025-12-31" });
        expect(bounds("NICHT datum:2026")).toEqual({});
        expect(bounds("datum:-30t")).toEqual({ from: "2026-10-16", to: TODAY });
    });
});

describe("field names", () => {
    const sample = (field: string) => (TX_QUERY_FIELDS[field] === "amount" ? "5" : TX_QUERY_FIELDS[field] === "date" ? "2026" : TX_QUERY_FIELDS[field] === "flag" ? "neu" : "x");

    it("lists every field the parser reads", () => {
        expect(Object.keys(TX_QUERY_FIELDS).sort()).toEqual(["betrag", "datum", "gegenseite", "iban", "ist", "kat", "kategorie", "konto", "name", "verwendungszweck", "zweck"]);
        for (const f of Object.keys(TX_QUERY_FIELDS)) expect(parseTxQuery(`${f}:${sample(f)}`).ok, f).toBe(true);
    });

    it("leaves the category and ist: out of rules", () => {
        for (const f of Object.keys(TX_QUERY_FIELDS)) {
            expect(parseTxQuery(`${f}:${sample(f)}`, { mode: "rule" }).ok, f).toBe(TX_QUERY_FIELDS[f] !== "category" && TX_QUERY_FIELDS[f] !== "flag");
        }
    });
});
