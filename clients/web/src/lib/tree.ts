// Pure helpers for the account tree (groups and accounts) and the category tree.

import type { Account, AccountGroup, AccountScope, Category, ColorKey, UncategorizedSlot } from "@mbm/shared";

export type TreeNode = { kind: "group"; group: AccountGroup; children: TreeNode[] } | { kind: "account"; account: Account };

/** Groups and accounts as one tree, each level in its shared order. */
export function accountTree(groups: AccountGroup[], accounts: Account[], parentId: number | null = null): TreeNode[] {
    const nodes: (TreeNode & { position: number; order: number })[] = [
        ...groups
            .filter((g) => g.parentId === parentId)
            .map((g) => ({ kind: "group" as const, group: g, children: accountTree(groups, accounts, g.id), position: g.position, order: 0 })),
        ...accounts.filter((a) => a.groupId === parentId).map((a) => ({ kind: "account" as const, account: a, position: a.position, order: 1 })),
    ];
    return nodes.sort((a, b) => a.position - b.position || a.order - b.order).map(({ position: _p, order: _o, ...n }) => n as TreeNode);
}

/** All accounts in the order the sidebar shows them: the tree walked top to bottom. Accounts the tree
 *  does not reach (groups not loaded yet) follow at the end. */
export function accountsInTreeOrder(groups: AccountGroup[], accounts: Account[]): Account[] {
    const out: Account[] = [];
    const walk = (nodes: TreeNode[]) => nodes.forEach((n) => (n.kind === "group" ? walk(n.children) : out.push(n.account)));
    walk(accountTree(groups, accounts));
    const seen = new Set(out.map((a) => a.id));
    return [...out, ...accounts.filter((a) => !seen.has(a.id))];
}

/** Ids of a group and all groups below it. */
export function groupSubtree(groups: AccountGroup[], id: number): number[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const g of groups) if (g.parentId === out[i]) out.push(g.id);
    return out;
}

/** Accounts a scope ("all", "group:3", "account:7") stands for. */
export function accountsInScope(scope: AccountScope, groups: AccountGroup[], accounts: Account[]): Account[] {
    if (scope === "all") return accounts;
    const [kind, raw] = scope.split(":") as ["group" | "account", string];
    const id = Number(raw);
    if (kind === "account") return accounts.filter((a) => a.id === id);
    const ids = new Set(groupSubtree(groups, id));
    return accounts.filter((a) => a.groupId !== null && ids.has(a.groupId));
}

export const sumBalance = (accounts: Account[]): number => accounts.reduce((s, a) => s + a.balance, 0);

export function scopeName(scope: AccountScope, groups: AccountGroup[], accounts: Account[]): string {
    if (scope === "all") return "Alle Konten";
    const [kind, raw] = scope.split(":");
    const id = Number(raw);
    return (kind === "group" ? groups.find((g) => g.id === id)?.name : accounts.find((a) => a.id === id)?.name) ?? "Unbekannt";
}

/** Is `scope` inside the selected scope (for the light marking of child nodes)? */
export function inScope(node: AccountScope, selected: AccountScope, groups: AccountGroup[], accounts: Account[]): boolean {
    if (selected === "all" || selected === node || !selected.startsWith("group:")) return false;
    const ids = new Set(groupSubtree(groups, Number(selected.slice(6))));
    const [kind, raw] = node.split(":");
    const id = Number(raw);
    if (kind === "group") return ids.has(id);
    const acc = accounts.find((a) => a.id === id);
    return !!acc && acc.groupId !== null && ids.has(acc.groupId);
}

// ---------- Categories ----------

export interface CategoryIndex {
    byId: Map<number, Category>;
    top: Category[];
    children: Map<number, Category[]>;
    /** Where "Ohne Kategorie" sits; its bookings belong to that parent like a subcategory's. */
    none: UncategorizedSlot;
}

const TOP_LAST: UncategorizedSlot = { parentId: null, position: null };

export function indexCategories(items: Category[], none: UncategorizedSlot = TOP_LAST): CategoryIndex {
    const sorted = [...items].sort((a, b) => a.position - b.position || a.id - b.id);
    const children = new Map<number, Category[]>();
    for (const c of sorted) if (c.parentId !== null) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
    const byId = new Map(sorted.map((c) => [c.id, c]));
    // A slot below a category that is gone falls back to the top level
    const slot = none.parentId !== null && !byId.has(none.parentId) ? TOP_LAST : none;
    return { byId, top: sorted.filter((c) => c.parentId === null), children, none: slot };
}

/** A row of the category tree: a category, or "none" for "Ohne Kategorie". */
export type CategoryRowItem = Category | "none";

/** Children of a parent (`null` = top level) in display order, "Ohne Kategorie" included where it sits. */
export function childRows(idx: CategoryIndex, parentId: number | null): CategoryRowItem[] {
    const cats = parentId === null ? idx.top : (idx.children.get(parentId) ?? []);
    const out: CategoryRowItem[] = [...cats];
    if (idx.none.parentId === parentId) {
        const p = idx.none.position;
        const at = p === null ? -1 : cats.findIndex((c) => c.position >= p);
        out.splice(at < 0 ? out.length : at, 0, "none");
    }
    return out;
}

/** Does "Ohne Kategorie" sit in the subtree of `id` (below it, at any depth)? */
export function subtreeHasNone(idx: CategoryIndex, id: number): boolean {
    const p = idx.none.parentId;
    return p !== null && isInSubtree(idx, id, p);
}

/** Tree levels below this one keep its indent, so deep paths still fit. */
export const MAX_INDENT = 6;

/** A category's ancestors, the parent first; stops at a broken or circular link. */
export function categoryAncestors(idx: CategoryIndex, id: number): Category[] {
    const out: Category[] = [];
    const seen = new Set([id]);
    let p = idx.byId.get(id)?.parentId ?? null;
    while (p !== null && !seen.has(p)) {
        const c = idx.byId.get(p);
        if (!c) break;
        out.push(c);
        seen.add(p);
        p = c.parentId;
    }
    return out;
}

export function categoryColor(idx: CategoryIndex, id: number | null): ColorKey {
    if (id === null) return "neutral";
    const c = idx.byId.get(id);
    if (!c) return "neutral";
    if (c.color) return c.color as ColorKey;
    return (categoryAncestors(idx, id).find((a) => a.color)?.color as ColorKey | undefined) ?? "neutral";
}

export function categoryPath(idx: CategoryIndex, id: number | null): string {
    if (id === null) return "Ohne Kategorie";
    const c = idx.byId.get(id);
    if (!c) return "Unbekannt";
    return [...categoryAncestors(idx, id).reverse(), c].map((x) => x.name).join(" › ");
}

/** Ids of a category and all its descendants, the category first. */
export function categorySubtree(idx: CategoryIndex, id: number): number[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const c of idx.children.get(out[i]!) ?? []) if (!out.includes(c.id)) out.push(c.id);
    return out;
}

/** Is `id` the category `root` itself or one of its descendants? */
export const isInSubtree = (idx: CategoryIndex, root: number, id: number): boolean => id === root || categoryAncestors(idx, id).some((a) => a.id === root);

/** Is a category counted in figures (not an own transfer)? Excluding a category excludes all below it. */
export function countsInStats(idx: CategoryIndex, id: number | null): boolean {
    // Bookings without a category count unless "Ohne Kategorie" sits below an excluded category
    if (id === null) return idx.none.parentId === null || countsInStats(idx, idx.none.parentId);
    const c = idx.byId.get(id);
    if (!c) return true;
    return !c.excludedFromStats && !categoryAncestors(idx, id).some((a) => a.excludedFromStats);
}

/** Where a dragged node lands relative to a target row: into it, or before it. */
export function dropPosition(offsetY: number, height: number, canInto: boolean): "into" | "before" | "after" {
    const f = offsetY / height;
    if (canInto) return f < 0.28 ? "before" : f > 0.72 ? "after" : "into";
    return f < 0.5 ? "before" : "after";
}

