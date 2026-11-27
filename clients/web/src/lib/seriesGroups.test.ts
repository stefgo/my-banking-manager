import { describe, expect, it } from "vitest";
import { addDaysIso } from "@mbm/shared";
import { axisLayout, groupFlows, groupPointLabel, groupSeries, niceScale, periodLabel, periodOf } from "./seriesGroups";

/** Daily points from `from` to `to` with the balance given per day (default: day index × 100). */
function days(from: string, to: string, balance: (i: number, date: string) => number = (i) => i * 100) {
    const out: { date: string; balance: number }[] = [];
    for (let d = from, i = 0; d <= to; d = addDaysIso(d, 1), i++) out.push({ date: d, balance: balance(i, d) });
    return out;
}

describe("periodOf", () => {
    it("finds month, quarter and year bounds", () => {
        expect(periodOf("2024-02-14", "month")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
        expect(periodOf("2026-11-18", "quarter")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
        expect(periodOf("2026-03-31", "quarter")).toEqual({ start: "2026-01-01", end: "2026-03-31" });
        expect(periodOf("2026-07-01", "year")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    });
});

describe("groupSeries", () => {
    it("returns nothing for an empty series", () => {
        expect(groupSeries([], "month")).toEqual([]);
    });

    it("averages the days of each month and marks cut months", () => {
        // 30.10. … 02.12.: October and December are cut, November is whole
        const pts = days("2026-10-30", "2026-12-02", (_i, d) => (d.startsWith("2026-11") ? 3000 : d.startsWith("2026-10") ? (d.endsWith("30") ? 100 : 200) : 50));
        expect(groupSeries(pts, "month")).toEqual([
            { date: "2026-10-01", from: "2026-10-30", to: "2026-10-31", partial: true, balance: 150 },
            { date: "2026-11-01", from: "2026-11-01", to: "2026-11-30", partial: false, balance: 3000 },
            { date: "2026-12-01", from: "2026-12-01", to: "2026-12-02", partial: true, balance: 50 },
        ]);
    });

    it("rounds the average to cents", () => {
        const pts = [
            { date: "2026-01-01", balance: 1 },
            { date: "2026-01-02", balance: 2 },
            { date: "2026-01-03", balance: 2 },
        ];
        expect(groupSeries(pts, "month")[0]!.balance).toBe(2);
    });

    it("groups quarters and years across the turn of the year", () => {
        const pts = days("2025-12-01", "2026-01-31", (_i, d) => (d < "2026" ? 1000 : -1000));
        expect(groupSeries(pts, "quarter").map((p) => [p.date, p.balance, p.partial])).toEqual([
            ["2025-10-01", 1000, true],
            ["2026-01-01", -1000, true],
        ]);
        expect(groupSeries(days("2024-01-01", "2025-12-31"), "year").map((p) => [p.date, p.partial])).toEqual([
            ["2024-01-01", false],
            ["2025-01-01", false],
        ]);
    });
});

describe("groupPointLabel", () => {
    it("names the period and the days of a cut one", () => {
        const [whole] = groupSeries(days("2026-10-01", "2026-10-31"), "month");
        expect(groupPointLabel(whole!, "month")).toBe("Ø Oktober 2026");
        const [cut] = groupSeries(days("2026-10-01", "2026-11-18"), "quarter");
        expect(groupPointLabel(cut!, "quarter")).toBe("Ø Q4 2026 (01.10.–18.11.2026)");
        const [one] = groupSeries(days("2026-01-05", "2026-01-05"), "year");
        expect(groupPointLabel(one!, "year")).toBe("Ø 2026 (05.01.2026)");
    });
});

describe("groupFlows", () => {
    // 30.10. … 02.12.: income on the 1st of each month, an expense every day
    const flows = days("2026-10-30", "2026-12-02").map((p) => ({ date: p.date, income: p.date.endsWith("-01") ? 250000 : 0, expenses: -1000 }));

    it("keeps each day with its total", () => {
        expect(groupFlows(flows.slice(2, 4), "day")).toEqual([
            { date: "2026-11-01", from: "2026-11-01", to: "2026-11-01", partial: false, income: 250000, expenses: -1000, net: 249000 },
            { date: "2026-11-02", from: "2026-11-02", to: "2026-11-02", partial: false, income: 0, expenses: -1000, net: -1000 },
        ]);
    });

    it("sums the days of each month and marks cut months", () => {
        expect(groupFlows(flows, "month")).toEqual([
            { date: "2026-10-01", from: "2026-10-30", to: "2026-10-31", partial: true, income: 0, expenses: -2000, net: -2000 },
            { date: "2026-11-01", from: "2026-11-01", to: "2026-11-30", partial: false, income: 250000, expenses: -30000, net: 220000 },
            { date: "2026-12-01", from: "2026-12-01", to: "2026-12-02", partial: true, income: 250000, expenses: -2000, net: 248000 },
        ]);
    });

    it("sums a quarter and a year", () => {
        expect(groupFlows(flows, "quarter").map((p) => [p.date, p.net])).toEqual([["2026-10-01", 466000]]);
        expect(groupFlows(flows, "year")).toHaveLength(1);
        expect(groupFlows([], "month")).toEqual([]);
    });

    it("names the period without the average sign", () => {
        const [, whole, cut] = groupFlows(flows, "month");
        expect(periodLabel(whole!, "month")).toBe("November 2026");
        expect(periodLabel(cut!, "month")).toBe("Dezember 2026 (01.12.–02.12.2026)");
    });
});

describe("niceScale", () => {
    it("spans the values with round steps", () => {
        const s = niceScale(123_45, 987_65);
        expect(s.domain[0]).toBeLessThanOrEqual(123_45);
        expect(s.domain[1]).toBeGreaterThanOrEqual(987_65);
        expect(s.ticks[0]).toBe(s.domain[0]);
        expect(s.ticks.at(-1)).toBe(s.domain[1]);
        const step = s.ticks[1]! - s.ticks[0]!;
        expect(s.ticks.every((t, i) => i === 0 || t - s.ticks[i - 1]! === step)).toBe(true);
        expect(s).toEqual({ domain: [0, 1_000_00], ticks: [0, 250_00, 500_00, 750_00, 1_000_00] });
    });

    it("widens a flat line and steps at least one euro", () => {
        const flat = niceScale(500_00, 500_00);
        expect(flat.domain[0]).toBeLessThan(500_00);
        expect(flat.domain[1]).toBeGreaterThan(500_00);
        const tiny = niceScale(10, 30);
        expect(tiny.ticks.every((t) => t % 100 === 0)).toBe(true);
    });

    it("handles negative balances", () => {
        const s = niceScale(-2_300_00, -400_00);
        expect(s.domain[0]).toBeLessThanOrEqual(-2_300_00);
        expect(s.domain[1]).toBeGreaterThanOrEqual(-400_00);
    });
});

describe("axisLayout", () => {
    /** First days of `n` months from `from` on. */
    const months = (from: string, n: number) =>
        Array.from({ length: n }, (_v, i) => {
            const m = Number(from.slice(5, 7)) - 1 + i;
            return `${Number(from.slice(0, 4)) + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`;
        });
    const named = (layout: ReturnType<typeof axisLayout>, dates: string[]) => dates.filter((d) => layout.tick(d) !== "");

    it("names only the 1st and 15th of narrow days", () => {
        const dates = days("2026-10-10", "2026-11-20").map((p) => p.date);
        const layout = axisLayout("day", dates);
        expect(layout).toMatchObject({ slot: 14, edge: 17, sparse: true });
        expect(named(layout, dates)).toEqual(["2026-10-15", "2026-11-01", "2026-11-15"]);
    });

    it("names each quarter start of narrow months", () => {
        const dates = months("2025-11-01", 14);
        const layout = axisLayout("month", dates);
        expect(layout).toMatchObject({ slot: 20, edge: 12, sparse: true });
        expect(named(layout, dates)).toEqual(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
    });

    it("names the first quarter of each year", () => {
        const dates = ["2025-07-01", "2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01"];
        const layout = axisLayout("quarter", dates);
        expect(layout).toMatchObject({ slot: 24, edge: 12, sparse: true });
        expect(named(layout, dates)).toEqual(["2026-01-01"]);
    });

    it("names every value with room for it when the range holds no picked one", () => {
        expect(axisLayout("day", days("2026-11-02", "2026-11-12").map((p) => p.date))).toMatchObject({ slot: 48, edge: 0, sparse: false });
        const dates = ["2026-02-01", "2026-03-01"];
        const layout = axisLayout("month", dates);
        expect(layout).toMatchObject({ slot: 44, edge: 0, sparse: false });
        expect(named(layout, dates)).toEqual(dates);
        expect(axisLayout("quarter", ["2026-04-01", "2026-07-01"])).toMatchObject({ slot: 48, sparse: false });
    });

    it("names every year", () => {
        const dates = ["2024-01-01", "2025-01-01", "2026-01-01"];
        const layout = axisLayout("year", dates);
        expect(layout).toMatchObject({ slot: 36, edge: 0, sparse: false });
        expect(named(layout, dates)).toEqual(dates);
    });
});
