import { describe, expect, it } from "vitest";
import { isBankingDay, nextStandingOrderDate, recurrenceLabel, standingOrderDates, toBankingDay, type Recurrence } from "./orders.js";

const order = (over: Partial<Recurrence>): Recurrence => ({ unit: "month", every: 1, executionDay: 1, firstDate: "2024-01-01", lastDate: null, ...over });

describe("banking days", () => {
    it("knows weekends and the TARGET holidays", () => {
        expect(isBankingDay("2026-11-13")).toBe(true);
        expect(isBankingDay("2026-11-14")).toBe(false); // Saturday
        expect(isBankingDay("2026-11-15")).toBe(false);
        for (const d of ["2027-01-01", "2027-03-26", "2027-03-29", "2026-05-01", "2026-12-25", "2026-12-26"]) expect(isBankingDay(d), d).toBe(false);
        // Not TARGET holidays: Ascension Day, German Unity Day
        expect(isBankingDay("2027-05-06")).toBe(true);
        expect(isBankingDay("2027-10-04")).toBe(true);
    });

    it("moves to the next or the previous banking day", () => {
        expect(toBankingDay("2026-12-25")).toBe("2026-12-28"); // Friday holiday, Saturday holiday, Sunday
        expect(toBankingDay("2027-03-26")).toBe("2027-03-30"); // Good Friday to the Tuesday after Easter
        expect(toBankingDay("2026-10-31", -1)).toBe("2026-10-30");
        expect(toBankingDay("2026-11-16")).toBe("2026-11-16");
    });
});

describe("standingOrderDates", () => {
    it("runs monthly and moves a non-banking day forward", () => {
        expect(standingOrderDates(order({}), "2026-11-01", "2027-02-28")).toEqual(["2026-11-02", "2026-12-01", "2027-01-04", "2027-02-01"]);
    });

    it("keeps the rhythm of the first date", () => {
        const quarterly = order({ every: 3, executionDay: 15, firstDate: "2025-02-15" });
        expect(standingOrderDates(quarterly, "2026-01-01", "2026-12-31")).toEqual(["2026-02-16", "2026-05-15", "2026-08-17", "2026-11-16"]);
        const yearly = order({ every: 12, executionDay: 20, firstDate: "2020-03-20" });
        expect(standingOrderDates(yearly, "2026-01-01", "2028-12-31")).toEqual(["2026-03-20", "2027-03-22", "2028-03-20"]);
    });

    it("starts at the first matching day on or after the first date", () => {
        expect(standingOrderDates(order({ executionDay: 1, firstDate: "2026-11-10" }), "2026-11-01", "2027-01-31")).toEqual(["2026-12-01", "2027-01-04"]);
        expect(standingOrderDates(order({ firstDate: "2027-03-01" }), "2026-11-01", "2027-01-31")).toEqual([]);
    });

    it("handles short months, leap years and the end of the month", () => {
        const on30th = order({ executionDay: 30, firstDate: "2024-01-30" });
        expect(standingOrderDates(on30th, "2027-02-01", "2027-03-31")).toEqual(["2027-02-01", "2027-03-01", "2027-03-30"]); // 30 Jan 2027 is a Saturday, 28 Feb a Sunday
        expect(standingOrderDates(on30th, "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
        const ultimo = order({ executionDay: 99, firstDate: "2024-01-31" });
        // An order at the end of the month stays in its month: 31 Oct 2026 is a Saturday
        expect(standingOrderDates(ultimo, "2026-10-01", "2026-12-31")).toEqual(["2026-10-30", "2026-11-30", "2026-12-31"]);
        expect(standingOrderDates(order({ executionDay: 98, firstDate: "2024-01-01" }), "2027-02-01", "2027-02-28")).toEqual(["2027-02-26"]);
    });

    it("ends with the last date", () => {
        expect(standingOrderDates(order({ lastDate: "2026-12-31" }), "2026-11-01", "2027-06-30")).toEqual(["2026-11-02", "2026-12-01"]);
        expect(standingOrderDates(order({ lastDate: "2026-01-01" }), "2026-11-01", "2027-06-30")).toEqual([]);
    });

    it("runs weekly on the given weekday", () => {
        const fridays = order({ unit: "week", every: 2, executionDay: 5, firstDate: "2026-11-06" });
        expect(standingOrderDates(fridays, "2026-11-01", "2026-12-31")).toEqual(["2026-11-06", "2026-11-20", "2026-12-04", "2026-12-18"]);
        // Far from the first date the rhythm still holds
        expect(standingOrderDates(fridays, "2030-01-01", "2030-01-31")).toEqual(["2030-01-11", "2030-01-25"]);
        const mondays = order({ unit: "week", executionDay: 1, firstDate: "2026-11-04" });
        expect(standingOrderDates(mondays, "2026-11-01", "2026-11-30")).toEqual(["2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
        // Christmas Day 2026 is a Friday: the run moves to Monday
        expect(standingOrderDates(order({ unit: "week", executionDay: 5, firstDate: "2026-12-04" }), "2026-12-20", "2026-12-31")).toEqual(["2026-12-28"]);
    });

    it("gives nothing for a rule it cannot read", () => {
        expect(standingOrderDates(order({ every: 0 }), "2026-11-01", "2026-12-01")).toEqual([]);
        expect(standingOrderDates(order({}), "2026-12-01", "2026-11-01")).toEqual([]);
    });
});

describe("nextStandingOrderDate", () => {
    it("finds the next run, also of a yearly order", () => {
        expect(nextStandingOrderDate(order({}), "2026-11-17")).toBe("2026-12-01");
        expect(nextStandingOrderDate(order({ every: 12, executionDay: 20, firstDate: "2020-03-20" }), "2026-03-21")).toBe("2027-03-22");
        expect(nextStandingOrderDate(order({ unit: "week", every: 52, executionDay: 3, firstDate: "2026-01-07" }), "2026-01-08")).toBe("2027-01-06");
        expect(nextStandingOrderDate(order({ lastDate: "2026-11-30" }), "2026-11-17")).toBeNull();
    });
});

describe("recurrenceLabel", () => {
    it("names the rhythm", () => {
        expect(recurrenceLabel({ unit: "month", every: 1, executionDay: 1 })).toBe("monatlich am 1.");
        expect(recurrenceLabel({ unit: "month", every: 3, executionDay: 99 })).toBe("vierteljährlich am Monatsende");
        expect(recurrenceLabel({ unit: "month", every: 2, executionDay: 15 })).toBe("alle 2 Monate am 15.");
        expect(recurrenceLabel({ unit: "month", every: 12, executionDay: 98 })).toBe("jährlich am vorletzten Tag des Monats");
        expect(recurrenceLabel({ unit: "week", every: 1, executionDay: 1 })).toBe("wöchentlich montags");
        expect(recurrenceLabel({ unit: "week", every: 2, executionDay: 5 })).toBe("alle 2 Wochen freitags");
        expect(recurrenceLabel({ unit: "week", every: 4, executionDay: 7 })).toBe("alle 4 Wochen sonntags");
    });
});
