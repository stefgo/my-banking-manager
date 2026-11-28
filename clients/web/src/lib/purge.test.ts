import type { Transaction } from "@mbm/shared";
import { describe, expect, it } from "vitest";
import { canPurge } from "./purge";

const tx = (over: Partial<Transaction>) => ({ deletedAt: null, source: "import", fundedById: null, ...over }) as Transaction;

describe("deleting for good", () => {
    it("is offered only for a deleted booking from an import", () => {
        expect(canPurge(tx({ deletedAt: "2026-11-12T19:14:33Z" }))).toBe(true);
        expect(canPurge(tx({}))).toBe(false);
        expect(canPurge(tx({ deletedAt: "2026-11-12T19:14:33Z", source: "bank" }))).toBe(false);
        expect(canPurge(tx({ deletedAt: "2026-11-12T19:14:33Z", source: "manual" }))).toBe(false);
    });

    it("is not offered while an added booking (PayPal) that is not deleted hangs on it", () => {
        expect(canPurge(tx({ deletedAt: "2026-11-12T19:14:33Z", fundedById: 7 }))).toBe(false);
    });
});
