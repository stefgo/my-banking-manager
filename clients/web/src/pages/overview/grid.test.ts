import { describe, expect, it } from "vitest";
import { dragSize, pxToRows, rowsToPx, sizeLabel, spanOfSix, unitSpan } from "./grid";

describe("overview grid", () => {
    it("maps widths to the medium grid of 6", () => {
        expect([1, 3, 5, 6, 8, 12].map(spanOfSix)).toEqual([3, 3, 3, 6, 6, 6]);
    });

    it("converts rows and pixels both ways", () => {
        expect(rowsToPx(1)).toBe(56);
        expect(rowsToPx(3)).toBe(208);
        expect(pxToRows(rowsToPx(5))).toBe(5);
        expect(pxToRows(10)).toBe(1);
        expect(sizeLabel(8, null)).toBe("8 × auto");
        expect(sizeLabel(4, 3)).toBe("4 × 3");
    });

    it("spans fine rows so fixed heights line up and auto heights leave the gap", () => {
        // A fixed card of 3 rows takes exactly 3 × 19 units
        expect(unitSpan(rowsToPx(3))).toBe(57);
        expect(unitSpan(rowsToPx(3) + 0.3)).toBe(57);
        // 301 px of content plus the 20 px gap need 81 units of 4 px
        expect(unitSpan(301)).toBe(81);
        expect(unitSpan(0)).toBe(5);
    });

    it("snaps a drag to grid units and keeps the type's minimum", () => {
        // 12 columns of 60 px with 20 px gaps: one unit is 80 px
        const grid = 12 * 60 + 11 * 20;
        const start = { width: 4, height: null, measuredRows: 3 };
        expect(dragSize("groups", start, 170, 10, grid)).toEqual({ width: 6, height: null });
        expect(dragSize("groups", start, 0, 40, grid)).toEqual({ width: 4, height: 4 });
        expect(dragSize("groups", start, -400, 0, grid)).toEqual({ width: 3, height: null });
        expect(dragSize("groups", start, 2000, 0, grid)).toEqual({ width: 12, height: null });
        expect(dragSize("balance", { width: 8, height: 6, measuredRows: 6 }, 0, -400, grid)).toEqual({ width: 8, height: 5 });
    });
});
