// Items for the pickers: the account tree and the category tree as flat, indented lists.

import { useMemo, type ReactNode } from "react";
import { isOffline, type Account, type AccountScope, type Category } from "@mbm/shared";
import { useAccounts, useCategoryIndex, useGroups } from "../lib/queries";
import { accountTree, type TreeNode } from "../lib/tree";
import { CatTile, Tile } from "./icons";

export interface PickItem {
    value: string;
    label: string;
    depth?: number;
    top?: boolean;
    icon?: ReactNode;
    hint?: ReactNode;
    search?: string;
}

/** Items "Alle Konten", groups and accounts in tree order. */
export function useScopeItems(withAll = true): PickItem[] {
    const groupsData = useGroups().data;
    const accountsData = useAccounts().data;
    return useMemo(() => {
        const groups = groupsData ?? [];
        const accounts = accountsData ?? [];
        const out: PickItem[] = withAll ? [{ value: "all", label: "Alle Konten", top: true }] : [];
        const walk = (nodes: TreeNode[], d: number) => {
            for (const n of nodes) {
                if (n.kind === "group") {
                    out.push({ value: `group:${n.group.id}`, label: n.group.name, depth: d, top: d === 0, icon: <Tile icon={n.group.icon} color={n.group.color} size={12} className="ti-s" /> });
                    walk(n.children, d + 1);
                } else {
                    out.push({ value: `account:${n.account.id}`, label: n.account.name, depth: d, icon: <Tile icon={n.account.icon} color={n.account.color} size={12} className="ti-s" /> });
                }
            }
        };
        walk(accountTree(groups, accounts), 0);
        return out;
    }, [groupsData, accountsData, withAll]);
}

/** Items of the category tree; optional "Alle" and "Ohne Kategorie". */
export function useCategoryItems(opts: { all?: boolean; none?: boolean; topOnly?: boolean } = {}): PickItem[] {
    const { index } = useCategoryIndex();
    return useMemo(() => {
        const out: PickItem[] = [];
        if (opts.all) out.push({ value: "all", label: "Alle Kategorien", top: true });
        if (opts.none) out.push({ value: "none", label: "Ohne Kategorie", icon: <CatTile idx={index} id={null} size={12} className="ti-s" /> });
        // Searching finds a category also by the names above it
        const walk = (cats: Category[], depth: number, above: string[]) => {
            for (const c of cats) {
                out.push({
                    value: String(c.id),
                    label: c.name,
                    depth,
                    top: depth === 0,
                    search: above.length ? above.join(" ") : undefined,
                    icon: <CatTile idx={index} id={c.id} size={12} className="ti-s" />,
                });
                if (!opts.topOnly) walk(index.children.get(c.id) ?? [], depth + 1, [...above, c.name]);
            }
        };
        walk(index.top, 0, []);
        return out;
    }, [index, opts.all, opts.none, opts.topOnly]);
}

/** Single accounts as a flat list, value = account id. Offline accounts are marked in a mixed list. */
export function accountPickItems(accounts: Account[]): PickItem[] {
    const mixed = accounts.some((a) => isOffline(a)) && accounts.some((a) => !isOffline(a));
    return accounts.map((a) => ({
        value: String(a.id),
        label: a.name,
        top: true,
        hint: mixed && isOffline(a) ? "Offline-Konto" : undefined,
        icon: <Tile icon={a.icon} color={a.color} size={12} className="ti-s" />,
    }));
}

export function scopeLabel(scope: AccountScope | string, items: PickItem[]): string {
    return items.find((x) => x.value === scope)?.label ?? "Alle Konten";
}
