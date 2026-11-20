import { describe, expect, it } from "vitest";
import { findCachedTx } from "./txCache";

const list = (items: { id: number; name: string }[], updatedAt: number, invalidated = false) => ({ data: { items }, updatedAt, invalidated });

describe("findCachedTx", () => {
    it("takes the booking from the most current list, not from an outdated one", () => {
        // An old list of another account still holds the booking that had this id before the fetch
        const old = list([{ id: 7, name: "vorgemerkt" }], 1000, true);
        const fresh = list([{ id: 7, name: "gebucht" }], 2000);
        expect(findCachedTx<{ id: number; name: string }>([old, fresh], 7)?.name).toBe("gebucht");
    });

    it("prefers a list loaded since the last change over a newer outdated one", () => {
        const outdated = list([{ id: 3, name: "alt" }], 3000, true);
        const current = list([{ id: 3, name: "neu" }], 2000);
        expect(findCachedTx<{ id: number; name: string }>([outdated, current], 3)?.name).toBe("neu");
    });

    it("falls back to the newest outdated list and skips entries without items", () => {
        const a = list([{ id: 5, name: "älter" }], 1000, true);
        const b = list([{ id: 5, name: "jünger" }], 2000, true);
        expect(findCachedTx<{ id: number; name: string }>([{ data: 42, updatedAt: 5000, invalidated: false }, a, b], 5)?.name).toBe("jünger");
        expect(findCachedTx([a, b], 9)).toBeUndefined();
    });
});
