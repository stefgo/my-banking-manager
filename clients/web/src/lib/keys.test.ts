import { describe, expect, it } from "vitest";
import { GO_KEYS, KEYS, keyText, withKeys } from "./keys";

describe("keyboard shortcuts", () => {
    it("lists every page shortcut, and only those that exist", () => {
        const listed = KEYS.flatMap((k) => ("go" in k ? [k.go] : []));
        expect(listed.sort()).toEqual(Object.keys(GO_KEYS).sort());
        for (const k of KEYS) {
            if ("go" in k) expect(k.keys).toEqual(["G", k.go.toUpperCase()]);
        }
    });

    it("gives no two entries the same keys", () => {
        const combos = KEYS.map((k) => k.keys.join("+"));
        expect(new Set(combos).size).toBe(combos.length);
    });

    it("has unique ids", () => {
        expect(new Set(KEYS.map((k) => k.id)).size).toBe(KEYS.length);
    });

    it("formats keys for display", () => {
        expect(keyText("goSettings")).toBe("G E");
        expect(withKeys("Sperren", "lock")).toBe("Sperren (L)");
    });
});
