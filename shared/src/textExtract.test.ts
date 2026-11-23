import { describe, expect, it } from "vitest";
import { cleanValue, parsePattern, parseTemplate, renderTemplate, runPattern } from "./textExtract.js";

const run = (pattern: string, text: string) => {
    const parsed = parsePattern(pattern);
    if (!parsed.ok) throw new Error(parsed.error);
    const m = runPattern(parsed.parts, text);
    return m ? Object.fromEntries(m.values) : null;
};
const render = (template: string, values: Record<string, string>) => {
    const parsed = parseTemplate(template);
    if (!parsed.ok) throw new Error(parsed.error);
    return renderTemplate(parsed.parts, (n) => values[n]);
};

describe("patterns", () => {
    it("takes text up to the next fixed text or the end", () => {
        expect(run("Ihr Einkauf bei {haendler}", "PP.1234.PP . SPOTIFY, Ihr Einkauf bei SPOTIFY")).toEqual({ haendler: "SPOTIFY" });
        expect(run("VISA Debit {haendler}//{ort}/", "VISA Debit REWE MARKT//MUENCHEN/DE")).toEqual({ haendler: "REWE MARKT", ort: "MUENCHEN" });
    });

    it("knows words, numbers and skipped text", () => {
        expect(run("Rechnung {nr:wort} Kundennr {kunde:zahl}", "Rechnung 2026-4711 Kundennr 88123")).toEqual({ nr: "2026-4711", kunde: "88123" });
        expect(run("Vertrag * Nr {nr:zahl}", "Vertrag Strom 2026 Nr 17 Ende")).toEqual({ nr: "17" });
        expect(run("{name:wort} GmbH", "Firma Muster GmbH Berlin")).toEqual({ name: "Muster" });
        expect(run("{nr:zahl}", "Beleg 4711 von 12")).toEqual({ nr: "4711" });
    });

    it("tries the next place of its first text", () => {
        expect(run("Rechnung {nr:zahl}", "Rechnung vom 12.03. Rechnung 4711")).toEqual({ nr: "4711" });
        expect(run("Rechnung {nr:zahl}", "Rechnung vom 12.03.")).toBeNull();
    });

    it("ignores case, accents and repeated spaces and keeps the original characters", () => {
        expect(run("einkauf BEI {h}", "EINKAUF   bei Café Müller")).toEqual({ h: "Café Müller" });
        expect(run("strasse {nr:zahl}", "Hauptstraße 12")).toEqual({ nr: "12" });
        expect(run("Gruss {name}", "Gruß Jürgen Weiß")).toEqual({ name: "Jürgen Weiß" });
    });

    it("reads an escaped star as plain text", () => {
        expect(run("PAYPAL \\*{h}", "PAYPAL *SPOTIFY")).toEqual({ h: "SPOTIFY" });
    });

    it("refuses what it cannot read", () => {
        for (const p of ["{a}{b}", "{a}*", "*{a}", "{a", "{1a}", "{a:foo}", "{a} x {a}", "", "x".repeat(201)]) expect(parsePattern(p).ok, p).toBe(false);
    });

    it("stays fast on long and unfavourable texts", () => {
        const parsed = parsePattern("a{x}a{y}a{z}b");
        if (!parsed.ok) throw new Error(parsed.error);
        const start = performance.now();
        expect(runPattern(parsed.parts, "a".repeat(100_000))).toBeNull();
        expect(performance.now() - start).toBeLessThan(1000);
    });
});

describe("templates", () => {
    it("inserts values and changes their case", () => {
        expect(render("{h:titel}", { h: "REWE MARKT" })).toBe("Rewe Markt");
        expect(render("Einkauf in {o:titel}", { o: "MUENCHEN" })).toBe("Einkauf in Muenchen");
        expect(render("{a:gross}/{a:klein}", { a: "Abc" })).toBe("ABC/abc");
    });

    it("does not evaluate inserted values again", () => {
        expect(render("{a}", { a: "{zweck}", zweck: "geheim" })).toBe("{zweck}");
    });

    it("gives nothing when a value is missing or empty", () => {
        expect(render("x {a}", {})).toBeNull();
        expect(render("x {a}", { a: "" })).toBeNull();
    });

    it("cleans values for storing", () => {
        expect(cleanValue("  a\n\t b\u0000c‮ ", 100)).toBe("a bc");
        expect(cleanValue("abcdef", 3)).toBe("abc");
        expect(cleanValue(`ab${"😀"}`, 3)).toBe("ab");
    });
});
