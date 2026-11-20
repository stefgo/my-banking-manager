import { describe, expect, it } from "vitest";
import { badgeText, unreadLabel } from "./unread";

describe("count badges", () => {
    it("show up to 99 and then 99+", () => {
        expect(badgeText(1)).toBe("1");
        expect(badgeText(99)).toBe("99");
        expect(badgeText(100)).toBe("99+");
    });

    it("read as a sentence", () => {
        expect(unreadLabel(1)).toBe("1 neuer Umsatz");
        expect(unreadLabel(3)).toBe("3 neue Umsätze");
    });
});
