import { describe, expect, it } from "vitest";
import type { Transaction } from "@mbm/shared";
import { buildRows, dayRowAtOrBefore, listOrder } from "./rows";

const tx = (id: number, date: string, amount: number, status: "booked" | "pending" = "booked"): Transaction => ({
    id, accountId: 1, bookingDate: date, valueDate: date, amount, currency: "EUR", counterpartyName: `T${id}`, ultimateParty: "", counterpartyIban: null, bookingText: "", reference: "", customerReference: "", bankReference: "", mandateId: "", creditorId: "", counterpartyBic: "", counterpartyAccount: "", counterpartyBankCode: "",
    remittance: "", status, source: "manual", importId: null, counterTransactionId: null, isReturn: false, returnReason: "", returnOfId: null, returnedById: null, fundingOfId: null, fundedById: null, categoryId: null, categorySource: null, createdAt: "", unread: false, edits: { counterparty: null, remittance: null }, original: null, deletedAt: null,
});

describe("buildRows", () => {
    it("bundles pending bookings on top and groups booked ones by day with sums", () => {
        const rows = buildRows([tx(1, "2026-11-10", -100), tx(2, "2026-11-10", -50, "pending"), tx(3, "2026-11-10", 30), tx(4, "2026-11-08", -5)]);
        expect(rows.map((r) => (r.type === "head" ? `${r.label}:${r.sum}${r.booked ? ":b" : ""}` : `t${r.tx.id}`))).toEqual([
            "Vorgemerkt:-50",
            "t2",
            expect.stringMatching(/:-70:b$/),
            "t1",
            "t3",
            expect.stringMatching(/:-5$/),
            "t4",
        ]);
    });

    it("gives a day its balance at the end of the day, not the pending header", () => {
        const rows = buildRows([tx(1, "2026-11-10", -100), tx(2, "2026-11-10", -50, "pending"), tx(3, "2026-11-08", -5)], new Map([["2026-11-10", 900]]));
        expect(rows.filter((r) => r.type === "head").map((r) => r.type === "head" && r.balance)).toEqual([undefined, 900, undefined]);
    });

    it("orders bookings for the keyboard like the list", () => {
        expect(listOrder([tx(1, "2026-11-10", 1), tx(2, "2026-11-09", 1, "pending")]).map((t) => t.id)).toEqual([2, 1]);
    });
});

describe("dayRowAtOrBefore", () => {
    const rows = buildRows([tx(1, "2026-11-10", -1, "pending"), tx(2, "2026-11-10", -1), tx(3, "2026-10-31", -1), tx(4, "2026-10-02", -1), tx(5, "2026-09-15", -1)]);
    const dayOf = (i: number) => (i < 0 ? null : rows[i]!.key);

    it("finds the newest day of the period, not the pending header", () => {
        expect(dayOf(dayRowAtOrBefore(rows, "2026-11-30"))).toBe("h2026-11-10");
        expect(dayOf(dayRowAtOrBefore(rows, "2026-10-31"))).toBe("h2026-10-31");
    });

    it("falls back to the next older day when the period has no bookings", () => {
        expect(dayOf(dayRowAtOrBefore(rows, "2026-09-30"))).toBe("h2026-09-15");
        expect(dayOf(dayRowAtOrBefore(rows, "2026-10-30"))).toBe("h2026-10-02");
    });

    it("gives a period before every booking the oldest day", () => {
        expect(dayOf(dayRowAtOrBefore(rows, "2026-09-14"))).toBe("h2026-09-15");
    });

    it("finds nothing without booked days", () => {
        expect(dayRowAtOrBefore(buildRows([tx(1, "2026-11-10", -1, "pending")]), "2026-11-30")).toBe(-1);
    });
});
