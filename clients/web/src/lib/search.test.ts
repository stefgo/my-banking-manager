import { describe, expect, it } from "vitest";
import { catList, catParam, compactTxSearch, filterOf, isCategoryView, keepsFilters, MAX_KEPT_FILTERS, parseTxSearch, txEntry, txHome, TxView, txViewOf, withFilter, type TxFilters } from "./search";

describe("transaction filters in the URL", () => {
    it("falls back to defaults for anything unknown", () => {
        expect(parseTxSearch({ scope: "nonsense", cat: "x", dir: "sideways", range: "7" })).toEqual({
            scope: "all", cat: "all", dir: "all", range: undefined, ctx: "acc",
        });
    });

    it("keeps only what differs from the defaults", () => {
        const s = parseTxSearch({ scope: "group:3", cat: "12", q: "rewe", dir: "out", range: "month", ctx: "cat" });
        // The search text never goes into the URL, not even from an old link
        expect(compactTxSearch(s)).toEqual({ scope: "group:3", cat: "12", dir: "out", range: "month", ctx: "cat" });
        expect(compactTxSearch({ ...s, q: "DE89 3704" } as Parameters<typeof compactTxSearch>[0])).not.toHaveProperty("q");
        expect(compactTxSearch(parseTxSearch({}))).toEqual({});
    });

    it("takes several categories", () => {
        expect(parseTxSearch({ cat: "12,none,7" }).cat).toBe("12,none,7");
        for (const bad of ["12,,7", "12,x", ",12", "all,12"]) expect(parseTxSearch({ cat: bad }).cat).toBe("all");
        expect(catList("all")).toEqual([]);
        expect(catList("12,none")).toEqual(["12", "none"]);
        expect(catParam([])).toBeUndefined();
        expect(catParam(["12", "none", "12"])).toBe("12,none");
    });

    it("shows the view of one category only", () => {
        expect(isCategoryView(parseTxSearch({ cat: "12", ctx: "cat" }))).toBe(true);
        expect(isCategoryView(parseTxSearch({ cat: "none", ctx: "cat" }))).toBe(true);
        expect(isCategoryView(parseTxSearch({ cat: "12,7", ctx: "cat" }))).toBe(false);
        expect(isCategoryView(parseTxSearch({ cat: "12" }))).toBe(false);
    });
});

describe("filters kept per account", () => {
    it("takes category, direction and range, never the search text", () => {
        expect(filterOf(parseTxSearch({ scope: "account:2", cat: "12,none", q: "rewe", dir: "out", range: "month" }))).toEqual({ cat: "12,none", dir: "out", range: "month" });
        expect(filterOf(parseTxSearch({ scope: "account:2", q: "rewe" }))).toBeUndefined();
    });

    it("keeps them only in the account view", () => {
        expect(keepsFilters(parseTxSearch({ scope: "group:1" }))).toBe(true);
        expect(keepsFilters(parseTxSearch({ cat: "12", ctx: "cat" }))).toBe(false);
    });

    it("replaces, removes and limits the entries", () => {
        const one: TxFilters = { "account:1": { dir: "in" } };
        expect(withFilter(one, "account:1", { dir: "in" })).toBe(one);
        expect(withFilter(one, "account:1", undefined)).toEqual({});
        expect(withFilter(one, "all", { range: "30" })).toEqual({ "account:1": { dir: "in" }, all: { range: "30" } });
        expect(Object.keys(withFilter({ "account:1": { dir: "in" }, all: { range: "30" } }, "account:1", { dir: "out" }))).toEqual(["all", "account:1"]);
        const full = Object.fromEntries(Array.from({ length: MAX_KEPT_FILTERS }, (_, i) => [`account:${i + 1}`, { dir: "in" as const }])) as TxFilters;
        const next = withFilter(full, "group:9", { dir: "out" });
        expect(Object.keys(next)).toHaveLength(MAX_KEPT_FILTERS);
        expect(next["account:1"]).toBeUndefined();
        expect(next["group:9"]).toEqual({ dir: "out" });
    });
});

describe("ways into the list", () => {
    const kept: TxFilters = { "account:1": { dir: "in", range: "30" }, all: { cat: "5" } };

    it("keeps the search in the sidebar; an account brings its kept filters, a category none", () => {
        expect(txEntry({ kind: "account", scope: "account:1" }, kept)).toEqual({ search: { scope: "account:1", dir: "in", range: "30" } });
        expect(txEntry({ kind: "account", scope: "all" }, kept)).toEqual({ search: { cat: "5" } });
        expect(txEntry({ kind: "account", scope: "group:2" }, kept)).toEqual({ search: { scope: "group:2" } });
        expect(txEntry({ kind: "category", cat: "12" }, kept)).toEqual({ search: { cat: "12", ctx: "cat" } });
    });

    it("clears the search when coming from outside; filters of its own win over the kept ones", () => {
        expect(txEntry({ kind: "show", search: { scope: "account:1" } }, kept)).toEqual({ search: { scope: "account:1", dir: "in", range: "30" }, q: "" });
        expect(txEntry({ kind: "show", search: { scope: "account:1", cat: "7", range: "all" } }, kept)).toEqual({ search: { scope: "account:1", cat: "7", range: "all" }, q: "" });
        expect(txEntry({ kind: "show", search: { cat: "7", ctx: "cat" } }, kept)).toEqual({ search: { cat: "7", ctx: "cat" }, q: "" });
        expect(txEntry({ kind: "show" })).toEqual({ search: {}, q: "" });
    });

    it("shows a search of its own over all accounts and dates, without kept filters", () => {
        expect(txEntry({ kind: "query", q: "  rewe >50 " }, kept)).toEqual({ search: { range: "all" }, q: "rewe >50" });
    });
});

describe("last view", () => {
    it("knows the view the sidebar marks", () => {
        expect(txViewOf(parseTxSearch({ scope: "account:3", range: "month" }))).toBe("account:3");
        expect(txViewOf(parseTxSearch({ scope: "group:2" }))).toBe("group:2");
        expect(txViewOf(parseTxSearch({ cat: "7", ctx: "cat", scope: "account:3" }))).toBe("category:7");
        expect(txViewOf(parseTxSearch({ cat: "none", ctx: "cat" }))).toBe("category:none");
        // "Alle Konten" has no node in the sidebar, a category filter is no view of its own
        expect(txViewOf(parseTxSearch({}))).toBeUndefined();
        expect(txViewOf(parseTxSearch({ cat: "7" }))).toBeUndefined();
        expect(txViewOf(parseTxSearch({ cat: "7,8", ctx: "cat" }))).toBeUndefined();
        expect(txViewOf(parseTxSearch({ view: "none" }))).toBeUndefined();
    });

    it("keeps the hint to pick a view in the URL", () => {
        expect(parseTxSearch({ view: "none" }).view).toBe("none");
        expect(parseTxSearch({ view: "other" }).view).toBeUndefined();
        expect(compactTxSearch(parseTxSearch({ view: "none" }))).toEqual({ view: "none" });
    });

    it("stores only ids of accounts, groups and categories", () => {
        for (const ok of ["account:3", "group:12", "category:7", "category:none"]) expect(TxView.safeParse(ok).success).toBe(true);
        for (const bad of ["all", "account:none", "group:x", "category:", "Girokonto"]) expect(TxView.safeParse(bad).success).toBe(false);
    });

    it("leads to the last view, entered as from the sidebar", () => {
        const known = { accounts: new Set([3]), groups: new Set([2]), categories: new Set([7]) };
        const kept: TxFilters = { "account:3": { dir: "out", range: "month" } };
        expect(txHome("account:3", known, kept)).toEqual({ scope: "account:3", dir: "out", range: "month" });
        expect(txHome("group:2", known, kept)).toEqual({ scope: "group:2" });
        expect(txHome("category:7", known, kept)).toEqual({ cat: "7", ctx: "cat" });
        expect(txHome("category:none", known, kept)).toEqual({ cat: "none", ctx: "cat" });
    });

    it("asks to pick a view when there is none or it is gone", () => {
        const known = { accounts: new Set([3]), groups: new Set<number>(), categories: new Set<number>() };
        expect(txHome(null, known)).toEqual({ view: "none" });
        expect(txHome("account:4", known)).toEqual({ view: "none" });
        expect(txHome("group:2", known)).toEqual({ view: "none" });
        expect(txHome("category:7", known)).toEqual({ view: "none" });
    });

    it("trusts the last view while the lists still load", () => {
        expect(txHome("account:4", {})).toEqual({ scope: "account:4" });
    });
});
