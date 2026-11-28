import { describe, expect, it } from "vitest";
import { settingsTabFrom } from "./settingsTabs";

describe("settingsTabFrom", () => {
    it("keeps a known tab", () => {
        expect(settingsTabFrom("profile")).toBe("profile");
        expect(settingsTabFrom("system")).toBe("system");
        expect(settingsTabFrom("deleted")).toBe("deleted");
        expect(settingsTabFrom("versions")).toBe("versions");
    });

    it("sends links of earlier versions to where their content lives now", () => {
        expect(settingsTabFrom("security")).toBe("system");
        expect(settingsTabFrom("devices")).toBe("profile");
    });

    it("knows no other tab", () => {
        for (const raw of ["constructor", "", undefined, null, 1]) expect(settingsTabFrom(raw)).toBeUndefined();
    });
});
