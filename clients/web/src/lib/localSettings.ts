import { useSyncExternalStore } from "react";
import { z } from "zod";
import { AccountScope, Id } from "@mbm/shared";
import { TxFilters, TxView } from "./search";
import { CHART_STYLE_IDS, SERIES_GROUP_IDS } from "./seriesGroups";

/**
 * Settings this browser keeps for itself in localStorage. Only operating values without any bank
 * or personal data belong here: ids, fixed choices, yes/no; never names, amounts or search texts
 * (an approved exception to "nothing in browser storage"). Without storage (private window,
 * blocked site data) or with a broken value the system default applies.
 */
export const LOCAL_SETTINGS = {
    sidebarWidth: { schema: z.number().int().min(220).max(440), default: 272 },
    /** Sidebar reduced to a column of symbols (wide layout only). */
    sidebarCollapsed: { schema: z.boolean(), default: false },
    /** Account groups folded in the sidebar. */
    collapsedGroups: { schema: z.array(Id).max(1000), default: [] as number[] },
    /** Categories unfolded in the sidebar. */
    expandedCategories: { schema: z.array(Id).max(1000), default: [] as number[] },
    /** "Verlauf" (balance chart) in the header of the transaction list. */
    showBalanceChart: { schema: z.boolean(), default: false },
    /** Grouping of that chart: daily balances or averages per month, quarter or year. */
    balanceChartGroup: { schema: z.enum(SERIES_GROUP_IDS), default: "day" as (typeof SERIES_GROUP_IDS)[number] },
    /** That chart as bars or as a line. */
    balanceChartStyle: { schema: z.enum(CHART_STYLE_IDS), default: "bar" as (typeof CHART_STYLE_IDS)[number] },
    /** "Infos" (own information of the node) in the header of the transaction list. */
    showInfo: { schema: z.boolean(), default: false },
    /** Account, group or "all" shown on the orders page. */
    ordersScope: { schema: AccountScope, default: "all" },
    /** Filters of the transaction list per account, group or "all" (no search text). */
    txFilters: { schema: TxFilters, default: {} as TxFilters },
    /** The last account, group or category shown in the transaction list (see `txHome`). */
    lastTxView: { schema: TxView.nullable(), default: null as TxView | null },
} as const;

export type LocalSettingKey = keyof typeof LOCAL_SETTINGS;
export type LocalSettings = { [K in LocalSettingKey]: z.infer<(typeof LOCAL_SETTINGS)[K]["schema"]> };

const PREFIX = "mbm.";
const listeners = new Set<() => void>();
const cache = new Map<LocalSettingKey, unknown>();

function storage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

export function readLocalSetting<K extends LocalSettingKey>(key: K): LocalSettings[K] {
    if (cache.has(key)) return cache.get(key) as LocalSettings[K];
    const def = LOCAL_SETTINGS[key];
    let value: LocalSettings[K] = def.default as LocalSettings[K];
    try {
        const raw = storage()?.getItem(PREFIX + key);
        if (raw != null) {
            const parsed = def.schema.safeParse(JSON.parse(raw));
            if (parsed.success) value = parsed.data as LocalSettings[K];
        }
    } catch {
        // unreadable or no storage: keep the default
    }
    cache.set(key, value);
    return value;
}

/** Stores a value in this browser; an invalid value is ignored. */
export function writeLocalSetting<K extends LocalSettingKey>(key: K, value: LocalSettings[K]): void {
    const parsed = LOCAL_SETTINGS[key].schema.safeParse(value);
    if (!parsed.success) return;
    cache.set(key, parsed.data);
    try {
        storage()?.setItem(PREFIX + key, JSON.stringify(parsed.data));
    } catch {
        // full or blocked storage: the value lasts until the page reloads
    }
    for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    // Another tab of this browser changed a value
    const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key.startsWith(PREFIX)) {
            cache.clear();
            listener();
        }
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.("storage", onStorage);
    };
}

export function useLocalSetting<K extends LocalSettingKey>(key: K): LocalSettings[K] {
    return useSyncExternalStore(subscribe, () => readLocalSetting(key));
}

/** Only for tests: forget the values read so far. */
export function resetLocalSettingsCache(): void {
    cache.clear();
}
