import { describe, expect, it } from "vitest";
import { dateBounds, parseTxQuery } from "@mbm/shared";
import { searchDate, withDateRange, withoutDate } from "./dateQuery";

describe("date conditions in the search text", () => {
    it("removes date conditions of every form", () => {
        expect(withoutDate("rewe datum:3.2026")).toBe("rewe");
        expect(withoutDate("datum>=1.3.2026 datum<=31.3.2026 rewe")).toBe("rewe");
        expect(withoutDate("datum:-30t")).toBe("");
        expect(withoutDate("rewe NICHT datum:vormonat")).toBe("rewe");
    });

    it("leaves no dangling operators or empty parentheses", () => {
        expect(withoutDate("rewe UND datum:2026")).toBe("rewe");
        expect(withoutDate("datum:2026 ODER rewe")).toBe("rewe");
        expect(withoutDate("rewe UND (datum:2026) UND edeka")).toBe("rewe UND edeka");
        expect(withoutDate("(rewe ODER datum:2026) edeka")).toBe("(rewe) edeka");
    });

    it("keeps other fields that contain the word", () => {
        expect(withoutDate('zweck:"datum ist egal"')).toBe('zweck:"datum ist egal"');
    });

    it("writes dates the way the search reads them", () => {
        expect(searchDate("2026-03-01")).toBe("1.3.2026");
    });

    it("sets a period the parser reads back with both ends included", () => {
        const q = withDateRange("rewe datum:2025", "2026-03-01", "2026-03-31");
        expect(q).toBe("rewe datum>=1.3.2026 datum<=31.3.2026");
        const parsed = parseTxQuery(q);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
            expect(parsed.hasDate).toBe(true);
            expect(dateBounds(parsed.query)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
        }
    });

    it("keeps the result valid for the parser", () => {
        for (const q of ["rewe UND datum:2026", "(rewe ODER datum:2026) edeka", "NICHT datum:2026 rewe"]) {
            const r = parseTxQuery(withoutDate(q));
            expect(r.ok, q).toBe(true);
        }
    });
});
