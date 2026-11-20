import { describe, expect, it } from "vitest";
import { applySuggestion, suggest, type SuggestContext } from "./suggest";

const ctx: SuggestContext = { categories: ["Lebensmittel", "Lebensversicherung", "Freizeit & Kultur"], accounts: ["Girokonto", "Bargeld"] };
const at = (text: string, c: SuggestContext = ctx) => suggest(text, text.length, c);

describe("suggestions while typing", () => {
    it("offers field names for a word at the start or after a space", () => {
        expect(at("geg")?.items.map((i) => i.label)).toEqual(["gegenseite:"]);
        expect(at("rewe ka")?.items.map((i) => i.label)).toEqual(["kategorie:", "kat:"]);
        expect(at("rewe ka")?.from).toBe(5);
    });

    it("offers English field names only where no German one fits", () => {
        expect(at("am")?.items.map((i) => i.label)).toEqual(["amount:"]);
        expect(at("pu")?.items.map((i) => i.label)).toEqual(["purpose:"]);
        expect(at("da")?.items.map((i) => i.label)).toEqual(["datum:"]);
        expect(at("date")?.items.map((i) => i.label)).toEqual(["date:"]);
        expect(at("ca", { ...ctx, mode: "rule" })).toBeNull();
    });

    it("offers names after English fields too", () => {
        expect(at("category:leb")?.items.map((i) => i.label)).toEqual(["Lebensmittel", "Lebensversicherung"]);
        expect(at("Account:geld")?.items.map((i) => i.insert)).toEqual(["Account:Bargeld "]);
        expect(at("is:")?.items.map((i) => i.insert)).toEqual(["is:neu "]);
    });

    it("stays quiet for operators, numbers and other words", () => {
        expect(at("rewe UND")).toBeNull();
        expect(at("12,50")).toBeNull();
        expect(at("rewe")).toBeNull();
        expect(at("rewe ")).toBeNull();
    });

    it("offers category and account names after their field", () => {
        expect(at("kategorie:leb")?.items.map((i) => i.label)).toEqual(["Lebensmittel", "Lebensversicherung"]);
        expect(at("konto:geld")?.items.map((i) => i.label)).toEqual(["Bargeld"]);
        expect(at("zweck:leb")).toBeNull();
    });

    it("offers the values of ist:", () => {
        expect(at("is")?.items.map((i) => i.label)).toEqual(["ist:"]);
        expect(at("ist:")?.items.map((i) => i.insert)).toEqual(["ist:neu "]);
        expect(at("ist:n")?.items.map((i) => i.label)).toEqual(["neu"]);
    });

    it("quotes names with spaces", () => {
        expect(at("kat:frei")?.items[0]?.insert).toBe('kat:"Freizeit & Kultur" ');
        expect(at("kat:leb")?.items[0]?.insert).toBe("kat:Lebensmittel ");
    });

    it("leaves the category out of rules", () => {
        const rule = { ...ctx, mode: "rule" as const };
        expect(at("ka", rule)?.items.map((i) => i.label)).toBeUndefined();
        expect(at("kategorie:leb", rule)).toBeNull();
        expect(at("ko", rule)?.items.map((i) => i.label)).toEqual(["konto:"]);
        expect(at("is", rule)).toBeNull();
        expect(at("ist:", rule)).toBeNull();
    });

    it("replaces the whole word at the cursor", () => {
        // Cursor after "geg" inside "gegxx": the whole word goes
        const text = "rewe gegxx datum:2026";
        const r = suggest(text, 8, ctx)!;
        expect(applySuggestion(text, r, r.items[0]!)).toEqual({ text: "rewe gegenseite: datum:2026", caret: 16 });
    });
});
