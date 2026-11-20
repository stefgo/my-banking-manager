// New bookings of the signed-in user: counts per account for the badges, and marking as read or
// new again. The lists in the cache change at once; the server tells this user's other devices.

import { useQuery } from "@tanstack/react-query";
import { routes, type AccountScope, type TransactionList, type UnreadCounts } from "@mbm/shared";
import { call, errorText } from "./api";
import { invalidate, queryClient } from "./queries";
import { ui } from "./ui";

const KEY = ["unread"];

export const useUnreadCounts = () => useQuery({ queryKey: KEY, queryFn: () => call(routes.unreadCounts) });

/** New bookings of all accounts. */
export const useUnreadTotal = (): number => useUnreadCounts().data?.total ?? 0;

/** New bookings per account id. */
export function useUnreadByAccount(): ReadonlyMap<number, number> {
    const data = useUnreadCounts().data;
    return data ? countsByAccount(data) : EMPTY;
}

const EMPTY: ReadonlyMap<number, number> = new Map();
const byAccountCache = new WeakMap<UnreadCounts, Map<number, number>>();

function countsByAccount(data: UnreadCounts): Map<number, number> {
    let m = byAccountCache.get(data);
    if (!m) {
        m = new Map(data.accounts.map((a) => [a.accountId, a.count]));
        byAccountCache.set(data, m);
    }
    return m;
}

/** Text of a count badge: up to 99, then "99+". */
export const badgeText = (n: number): string => (n > 99 ? "99+" : String(n));

/** How a count reads to a screen reader. */
export const unreadLabel = (n: number): string => (n === 1 ? "1 neuer Umsatz" : `${n} neue Umsätze`);

/** Sets `unread` on cached bookings; `match` picks which. */
function patchLists(match: (t: { id: number; accountId: number }) => boolean, unread: boolean): void {
    queryClient.setQueriesData<TransactionList>({ queryKey: ["transactions"] }, (list) => {
        if (!list || !Array.isArray((list as { items?: unknown }).items)) return list;
        let changed = false;
        const items = list.items.map((t) => {
            if (t.unread === unread || !match(t)) return t;
            changed = true;
            return { ...t, unread };
        });
        return changed ? { ...list, items } : list;
    });
    // Lets views that read single bookings from the cache (the details) render again
    queryClient.setQueryData(["transactions", "__version"], Date.now());
}

/** Shifts the cached counts at once; the server's numbers follow. */
function patchCounts(txs: { accountId: number; unread: boolean }[], unread: boolean): void {
    queryClient.setQueryData<UnreadCounts>(KEY, (c) => {
        if (!c) return c;
        const m = new Map(countsByAccount(c));
        for (const t of txs) if (t.unread !== unread) m.set(t.accountId, Math.max(0, (m.get(t.accountId) ?? 0) + (unread ? 1 : -1)));
        const accounts = [...m].filter(([, n]) => n > 0).map(([accountId, count]) => ({ accountId, count }));
        return { accounts, total: accounts.reduce((s, a) => s + a.count, 0) };
    });
}

async function send(body: { ids?: number[]; scope?: AccountScope; unread: boolean }, quiet: boolean): Promise<void> {
    try {
        await call(routes.markRead, { body });
    } catch (err) {
        if (!quiet) ui.toast(errorText(err), "error");
        invalidate("unread");
    }
    void queryClient.invalidateQueries({ queryKey: KEY });
}

/** Marks bookings as read (`unread` false) or as new again. `quiet`: no message on failure. */
export function markTxs(txs: { id: number; accountId: number; unread: boolean }[], unread: boolean, quiet = false): Promise<void> | undefined {
    const todo = txs.filter((t) => t.unread !== unread);
    if (!todo.length) return undefined;
    const ids = new Set(todo.map((t) => t.id));
    patchCounts(todo, unread);
    patchLists((t) => ids.has(t.id), unread);
    return send({ ids: [...ids], unread }, quiet);
}

/** Marks every booking of the accounts as read. */
export function markAccountsRead(scope: AccountScope, accountIds: number[]): Promise<void> {
    const set = new Set(accountIds);
    queryClient.setQueryData<UnreadCounts>(KEY, (c) => {
        if (!c) return c;
        const accounts = c.accounts.filter((a) => !set.has(a.accountId));
        return { accounts, total: accounts.reduce((s, a) => s + a.count, 0) };
    });
    patchLists((t) => set.has(t.accountId), false);
    return send({ scope, unread: false }, false);
}
