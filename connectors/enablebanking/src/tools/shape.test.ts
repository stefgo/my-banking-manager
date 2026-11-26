import { describe, expect, it } from "vitest";
import { kindOf, Shape } from "./shape.js";

describe("Shape", () => {
    it("shows the form of the fields but no free text", () => {
        const shape = new Shape(new Set(["status", "transaction_amount.currency"]));
        shape.add({ status: "BOOK", transaction_amount: { amount: "-12.50", currency: "EUR" }, creditor: { name: "Erika Mustermann" }, remittance_information: ["Rechnung 4711", "Danke"] });
        shape.add({ status: "PDNG", transaction_amount: { amount: "3.00", currency: "EUR" }, booking_date: "2026-11-20", remittance_information: [] });
        const text = shape.lines().join("\n");

        expect(text).not.toContain("Erika");
        expect(text).not.toContain("4711");
        expect(text).not.toContain("12.50");
        expect(text).not.toContain("2026-11-20");
        expect(text).toContain('"BOOK" 1');
        expect(text).toContain('"EUR" 2');

        const amount = shape.fields.get("transaction_amount.amount")!;
        expect(amount.items).toBe(2);
        expect(amount.negative).toBe(1);
        expect(shape.fields.get("creditor.name")!.items).toBe(1);
        expect(shape.fields.get("creditor.name")!.maxLength).toBe(16);
        expect(shape.fields.get("remittance_information")!.minLength).toBe(0);
        expect(shape.fields.get("remittance_information")!.maxLength).toBe(2);
        expect(shape.fields.get("remittance_information[]")!.items).toBe(1);
        expect(shape.fields.get("booking_date")!.kinds.get("date")).toBe(1);
    });

    it("leaves out long values even of fields whose values it shows", () => {
        const shape = new Shape(new Set(["bank_transaction_code.description"]));
        shape.add({ bank_transaction_code: { description: "x".repeat(61) } });
        expect(shape.fields.get("bank_transaction_code.description")!.values.size).toBe(0);
    });

    it("tells kinds of text apart", () => {
        expect(kindOf("")).toBe("empty");
        expect(kindOf("2026-11-26")).toBe("date");
        expect(kindOf("2026-11-26T10:00:00Z")).toBe("datetime");
        expect(kindOf("-0.99")).toBe("decimal");
        expect(kindOf("Zahlung")).toBe("text");
    });
});
