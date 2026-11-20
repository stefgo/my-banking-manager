import { describe, expect, it } from "vitest";
import type { Account, AccountGroup, Category } from "@mbm/shared";
import { accountTree, accountsInScope, categoryColor, categoryPath, categorySubtree, childRows, countsInStats, dropPosition, indexCategories, inScope, isInSubtree, scopeName, subtreeHasNone } from "./tree";

const NO_INFO = { attributes: [], notes: "" };
const group = (id: number, parentId: number | null, position: number, name = `G${id}`): AccountGroup => ({ id, parentId, name, icon: "folder", color: "neutral", position, info: NO_INFO });
const account = (id: number, groupId: number | null, position: number, balance = 0): Account => ({
    id, kind: "offline", connectionId: null, name: `A${id}`, icon: "wallet", color: "green", groupId, position, hidden: false, iban: null, cardNumber: null,
    currency: "EUR", openingBalance: 0, balance, pendingSum: 0, pendingCount: 0, transactionCount: 0, createdAt: "", info: NO_INFO,
});

const groups = [group(1, null, 0, "Privat"), group(2, 1, 0, "Alltag"), group(3, null, 1)];
const accounts = [account(10, 2, 0, 500), account(11, 1, 1, 200), account(12, null, 2, 50)];

describe("accountTree", () => {
    it("mixes groups and accounts in their shared order", () => {
        const tree = accountTree(groups, accounts);
        expect(tree.map((n) => (n.kind === "group" ? `g${n.group.id}` : `a${n.account.id}`))).toEqual(["g1", "g3", "a12"]);
        const privat = tree[0]!;
        expect(privat.kind === "group" && privat.children.map((n) => (n.kind === "group" ? `g${n.group.id}` : `a${n.account.id}`))).toEqual(["g2", "a11"]);
    });
});

describe("scopes", () => {
    it("collects accounts of a group and its subgroups", () => {
        expect(accountsInScope("group:1", groups, accounts).map((a) => a.id).sort()).toEqual([10, 11]);
        expect(accountsInScope("account:12", groups, accounts).map((a) => a.id)).toEqual([12]);
        expect(accountsInScope("all", groups, accounts)).toHaveLength(3);
        expect(scopeName("group:2", groups, accounts)).toBe("Alltag");
    });

    it("marks nodes below the selected group", () => {
        expect(inScope("group:2", "group:1", groups, accounts)).toBe(true);
        expect(inScope("account:10", "group:1", groups, accounts)).toBe(true);
        expect(inScope("account:12", "group:1", groups, accounts)).toBe(false);
        expect(inScope("group:1", "group:1", groups, accounts)).toBe(false);
    });
});

describe("categories", () => {
    const cat = (id: number, parentId: number | null, color: string | null, excluded = false): Category => ({
        id, parentId, name: `C${id}`, icon: "tag", color, position: id, excludedFromStats: excluded, counterDefault: false, count: 0, info: NO_INFO,
    });
    const idx = indexCategories([cat(1, null, "amber"), cat(2, 1, null), cat(3, 1, "red"), cat(4, null, "neutral", true), cat(5, 4, null)]);

    it("takes the parent's colour until a subcategory has its own", () => {
        expect(categoryColor(idx, 2)).toBe("amber");
        expect(categoryColor(idx, 3)).toBe("red");
        expect(categoryColor(idx, null)).toBe("neutral");
    });

    it("names the path and leaves own transfers out of figures", () => {
        expect(categoryPath(idx, 2)).toBe("C1 › C2");
        expect(countsInStats(idx, 5)).toBe(false);
        expect(countsInStats(idx, 2)).toBe(true);
    });

    describe("at any depth", () => {
        // 1 › 2 › 6 › 7, and 4 (excluded) › 5 › 8
        const deep = indexCategories([
            cat(1, null, "amber"), cat(2, 1, null), cat(3, 1, "red"), cat(4, null, "neutral", true), cat(5, 4, null),
            cat(6, 2, null), cat(7, 6, null), cat(8, 5, "blue"),
        ]);

        it("names the whole path", () => {
            expect(categoryPath(deep, 7)).toBe("C1 › C2 › C6 › C7");
        });

        it("takes the colour of the nearest ancestor that has one", () => {
            expect(categoryColor(deep, 7)).toBe("amber");
            expect(categoryColor(deep, 8)).toBe("blue");
        });

        it("collects the whole subtree and knows what lies inside it", () => {
            expect(categorySubtree(deep, 1).sort()).toEqual([1, 2, 3, 6, 7]);
            expect(isInSubtree(deep, 2, 7)).toBe(true);
            expect(isInSubtree(deep, 2, 2)).toBe(true);
            expect(isInSubtree(deep, 2, 3)).toBe(false);
        });

        it("leaves every level below an excluded category out of figures", () => {
            expect(countsInStats(deep, 8)).toBe(false);
            expect(countsInStats(deep, 7)).toBe(true);
        });
    });
});

describe("dropPosition", () => {
    it("drops into the middle of a row that takes children, before or after at its edges", () => {
        expect(dropPosition(2, 30, true)).toBe("before");
        expect(dropPosition(15, 30, true)).toBe("into");
        expect(dropPosition(28, 30, true)).toBe("after");
        expect(dropPosition(15, 30, false)).toBe("after");
    });
});

describe("Ohne Kategorie in the tree", () => {
    const cat = (id: number, parentId: number | null, position: number, excluded = false): Category => ({
        id, parentId, name: `C${id}`, icon: "tag", color: "green", position, excludedFromStats: excluded, counterDefault: false, count: 0, info: NO_INFO,
    });
    // 1 › (2, 3), 4 (excluded) › 5
    const items = [cat(1, null, 0), cat(2, 1, 0), cat(3, 1, 2), cat(4, null, 1, true), cat(5, 4, 0)];
    const ids = (rows: ReturnType<typeof childRows>) => rows.map((r) => (r === "none" ? r : r.id));

    it("sits last on the top level by default", () => {
        const idx = indexCategories(items);
        expect(ids(childRows(idx, null))).toEqual([1, 4, "none"]);
        expect(ids(childRows(idx, 1))).toEqual([2, 3]);
        expect(countsInStats(idx, null)).toBe(true);
    });

    it("sits at its position below a parent and belongs to its ancestors", () => {
        const idx = indexCategories(items, { parentId: 1, position: 1 });
        expect(ids(childRows(idx, null))).toEqual([1, 4]);
        expect(ids(childRows(idx, 1))).toEqual([2, "none", 3]);
        expect(ids(childRows(indexCategories(items, { parentId: 1, position: 0 }), 1))).toEqual(["none", 2, 3]);
        expect(ids(childRows(indexCategories(items, { parentId: 1, position: null }), 1))).toEqual([2, 3, "none"]);
        expect(subtreeHasNone(idx, 1)).toBe(true);
        expect(subtreeHasNone(idx, 2)).toBe(false);
        expect(subtreeHasNone(idx, 4)).toBe(false);
    });

    it("leaves its bookings out of figures below an excluded category", () => {
        expect(countsInStats(indexCategories(items, { parentId: 5, position: null }), null)).toBe(false);
        expect(countsInStats(indexCategories(items, { parentId: 2, position: null }), null)).toBe(true);
    });

    it("falls back to the top level when its parent is unknown", () => {
        expect(ids(childRows(indexCategories(items, { parentId: 99, position: 0 }), null))).toEqual([1, 4, "none"]);
    });
});
