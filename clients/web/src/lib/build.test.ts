import { describe, expect, it } from "vitest";
import { isOutdated } from "./build";

describe("new web client", () => {
    it("is there when the server delivers another build", () => {
        expect(isOutdated("a1", "b2")).toBe(true);
        expect(isOutdated("a1", "a1")).toBe(false);
    });

    it("is never assumed without a build on either side", () => {
        expect(isOutdated(null, "b2")).toBe(false);
        expect(isOutdated("a1", null)).toBe(false);
        expect(isOutdated("a1", undefined)).toBe(false);
    });
});
