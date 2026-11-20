// Finding one booking among the cached booking lists.

export interface CachedList {
    data: unknown;
    /** When the list was loaded (ms). */
    updatedAt: number;
    /** Marked outdated by a server event and not loaded again yet (e.g. a list not on screen). */
    invalidated: boolean;
}

/**
 * The booking with `id` from the most current list that holds it: lists loaded since the last
 * change first, then by load time. An outdated list may still hold an older state of it.
 */
export function findCachedTx<T extends { id: number }>(lists: CachedList[], id: number): T | undefined {
    const ordered = [...lists].sort((a, b) => Number(a.invalidated) - Number(b.invalidated) || b.updatedAt - a.updatedAt);
    for (const l of ordered) {
        const items = (l.data as { items?: unknown } | undefined)?.items;
        if (!Array.isArray(items)) continue;
        const hit = (items as T[]).find((t) => t.id === id);
        if (hit) return hit;
    }
    return undefined;
}
