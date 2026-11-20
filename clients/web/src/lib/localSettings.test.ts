import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLocalSetting, resetLocalSettingsCache, writeLocalSetting } from "./localSettings";

function memoryStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));
    return {
        get length() {
            return data.size;
        },
        clear: () => data.clear(),
        getItem: (k) => data.get(k) ?? null,
        key: (i) => [...data.keys()][i] ?? null,
        removeItem: (k) => void data.delete(k),
        setItem: (k, v) => void data.set(k, v),
    };
}

beforeEach(() => resetLocalSettingsCache());
afterEach(() => vi.unstubAllGlobals());

describe("local settings", () => {
    it("falls back to the system defaults without stored values", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        expect(readLocalSetting("sidebarWidth")).toBe(272);
        expect(readLocalSetting("sidebarCollapsed")).toBe(false);
        expect(readLocalSetting("showBalanceChart")).toBe(false);
        expect(readLocalSetting("balanceChartGroup")).toBe("day");
        expect(readLocalSetting("balanceChartStyle")).toBe("bar");
        expect(readLocalSetting("txFilters")).toEqual({});
    });

    it("reads valid values and ignores broken ones", () => {
        vi.stubGlobal("localStorage", memoryStorage({
            "mbm.sidebarWidth": "300",
            "mbm.sidebarCollapsed": "true",
            "mbm.collapsedGroups": "[3,4]",
            "mbm.expandedCategories": "[0]",
            "mbm.balanceChartGroup": "\"quarter\"",
            "mbm.balanceChartStyle": "\"line\"",
            "mbm.txFilters": JSON.stringify({ "account:2": { dir: "out" }, "group:1": { q: "rewe" } }),
        }));
        expect(readLocalSetting("sidebarWidth")).toBe(300);
        expect(readLocalSetting("sidebarCollapsed")).toBe(true);
        expect(readLocalSetting("collapsedGroups")).toEqual([3, 4]);
        expect(readLocalSetting("expandedCategories")).toEqual([]);
        expect(readLocalSetting("balanceChartGroup")).toBe("quarter");
        expect(readLocalSetting("balanceChartStyle")).toBe("line");
        // Unknown fields such as a search text are dropped
        expect(readLocalSetting("txFilters")).toEqual({ "account:2": { dir: "out" }, "group:1": {} });
        resetLocalSettingsCache();
        vi.stubGlobal("localStorage", memoryStorage({ "mbm.sidebarWidth": "{kaputt", "mbm.sidebarCollapsed": "\"ja\"" }));
        expect(readLocalSetting("sidebarWidth")).toBe(272);
        expect(readLocalSetting("sidebarCollapsed")).toBe(false);
    });

    it("stores valid values and rejects invalid ones", () => {
        const storage = memoryStorage();
        vi.stubGlobal("localStorage", storage);
        writeLocalSetting("showBalanceChart", true);
        writeLocalSetting("sidebarWidth", 5000);
        writeLocalSetting("balanceChartGroup", "week" as never);
        writeLocalSetting("balanceChartStyle", "pie" as never);
        writeLocalSetting("txFilters", { "konto:1": { dir: "in" } } as never);
        expect(storage.getItem("mbm.showBalanceChart")).toBe("true");
        expect(storage.getItem("mbm.sidebarWidth")).toBeNull();
        expect(storage.getItem("mbm.balanceChartGroup")).toBeNull();
        expect(storage.getItem("mbm.balanceChartStyle")).toBeNull();
        expect(storage.getItem("mbm.txFilters")).toBeNull();
        resetLocalSettingsCache();
        expect(readLocalSetting("showBalanceChart")).toBe(true);
    });

    it("keeps working when the storage throws", () => {
        const throwing = memoryStorage();
        throwing.getItem = () => {
            throw new Error("blocked");
        };
        throwing.setItem = () => {
            throw new Error("blocked");
        };
        vi.stubGlobal("localStorage", throwing);
        expect(readLocalSetting("sidebarWidth")).toBe(272);
        writeLocalSetting("sidebarWidth", 320);
        expect(readLocalSetting("sidebarWidth")).toBe(320);
    });
});
