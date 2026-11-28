import { describe, expect, it } from "vitest";
import { completeAmountInput, formatCents, formatSignedCents, parseAmount } from "./money.js";

describe("parseAmount", () => {
    it.each([
        ["1.234,56", 123456],
        ["-12,3", -1230],
        ["12.30", 1230],
        ["1,234.56", 123456],
        ["−5 €", -500],
        ["(12,00)", -1200],
        ["1.234", 123400],
        ["0,05", 5],
        ["+7", 700],
        ["12,00-", -1200],
        ["100 EUR", 10000],
    ])("%s → %d", (input, cents) => {
        expect(parseAmount(input)).toBe(cents);
    });

    it.each(["", "abc", "1,234,5x", "12,345"])("rejects %s", (input) => {
        expect(parseAmount(input)).toBeNull();
    });
});

describe("completeAmountInput", () => {
    it.each([
        ["1", "1,00"],
        ["1,1", "1,10"],
        ["0", "0,00"],
        [",5", "0,50"],
        ["1234,5", "1.234,50"],
        ["-3", "-3,00"],
    ])("%s → %s", (input, shown) => {
        expect(completeAmountInput(input)).toBe(shown);
    });

    it.each(["", "abc", "1,234"])("leaves %s as typed when it is no amount", (input) => {
        expect(completeAmountInput(input)).toBe(input);
    });
});

describe("formatting", () => {
    it("uses a real minus sign", () => {
        expect(formatCents(-123456)).toMatch(/^−1\.234,56\s€$/);
        expect(formatSignedCents(500)).toMatch(/^\+5,00\s€$/);
        expect(formatSignedCents(0)).toMatch(/^0,00\s€$/);
    });
});
