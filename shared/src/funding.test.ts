import { describe, expect, it } from "vitest";
import { fundingOrder, minimalStart, payLaterPairs, runFunding } from "./funding.js";

describe("runFunding", () => {
    it("takes the balance first and fetches the rest from outside", () => {
        const items = [
            { amount: 1000, date: "2026-10-01" },
            { amount: -400, date: "2026-10-02" },
            { amount: -900, date: "2026-10-03" },
            { amount: -500, date: "2026-10-04" },
        ];
        expect(runFunding(items, 0)).toEqual({ end: 0, outside: [0, 0, 300, 500] });
    });

    it("leaves purchases on credit alone and never funds a payout", () => {
        const items = [
            { amount: -2000, date: "2026-10-01", onCredit: true },
            { amount: 500, date: "2026-10-02" },
            { amount: -800, date: "2026-10-03", noFunding: true },
        ];
        expect(runFunding(items, 0)).toEqual({ end: -300, outside: [0, 0, 0] });
    });
});

describe("minimalStart", () => {
    const items = [
        { amount: -1000, date: "2026-10-01" },
        { amount: -400, date: "2026-10-02" },
    ];

    it("finds the smallest start that ends at the balance", () => {
        expect(minimalStart(items, 0)).toBe(0);
        expect(minimalStart(items, 600)).toBe(2000);
    });

    it("is null when even a start of 0 ends above the balance", () => {
        expect(minimalStart([{ amount: 500, date: "2026-10-01" }], 100)).toBeNull();
    });
});

describe("fundingOrder", () => {
    it("sorts by date and puts credits first on a day", () => {
        const items = [
            { amount: -1, date: "2026-10-02", n: 1 },
            { amount: -1, date: "2026-10-01", n: 2 },
            { amount: 1, date: "2026-10-01", n: 3 },
            { amount: -1, date: "2026-10-01", n: 4 },
        ];
        expect(fundingOrder(items).map((i) => i.n)).toEqual([3, 2, 4, 1]);
    });
});

describe("payLaterPairs", () => {
    const pay = (date: string, amount: number) => ({ date, amount, repayment: false, purchase: true });
    const repay = (date: string, amount: number) => ({ date, amount, repayment: true, purchase: false });

    it("pairs a repayment with the one purchase 25–35 days before", () => {
        const purchase = pay("2026-10-01", -5000);
        const repayment = repay("2026-10-30", -5000);
        expect([...payLaterPairs([purchase, pay("2026-10-20", -5000), repayment])]).toEqual([[purchase, repayment]]);
    });

    it("pairs nothing where two purchases fit (a monthly subscription)", () => {
        expect(payLaterPairs([pay("2026-10-01", -999), pay("2026-10-05", -999), repay("2026-10-31", -999)]).size).toBe(0);
    });

    it("pairs nothing outside the window or with another amount", () => {
        expect(payLaterPairs([pay("2026-10-01", -999), repay("2026-10-20", -999)]).size).toBe(0);
        expect(payLaterPairs([pay("2026-10-01", -998), repay("2026-10-30", -999)]).size).toBe(0);
    });

    it("gives each purchase to one repayment", () => {
        const a = pay("2026-10-01", -100);
        const r1 = repay("2026-10-30", -100);
        const r2 = repay("2026-11-02", -100);
        expect([...payLaterPairs([a, r1, r2])]).toEqual([[a, r1]]);
    });
});
