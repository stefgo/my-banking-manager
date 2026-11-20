// Filters of the transaction view live in the URL: back/forward and bookmarks work. The search
// text does not: it often holds bank data and stays in memory (`ui.search`).

import { z } from "zod";
import { AccountScope, TxRange } from "@mbm/shared";

export interface TxSearch {
    scope: AccountScope;
    /** "all", or a comma-separated list of category ids and "none". */
    cat: string;
    dir: "all" | "in" | "out";
    range?: TxRange;
    /** Which header shows: the account node or the category node. */
    ctx: "acc" | "cat";
    /** "none": no view picked yet; the page asks to pick one in the sidebar instead of a list. */
    view?: "none";
}

// Same format as `category` of the transaction query
const CAT_LIST = /^(all|(none|\d+)(,(none|\d+)){0,99})$/;

/** The picked categories of a `cat` value; empty for all. */
export function catList(cat: string): string[] {
    return cat === "all" ? [] : cat.split(",");
}

/** The `cat` value of a list for the URL; undefined (all) when empty. */
export function catParam(list: string[]): string | undefined {
    return list.length ? [...new Set(list)].join(",") : undefined;
}

/** Shows the view of one category (picked in the sidebar) instead of the account view. */
export function isCategoryView(s: TxSearch): boolean {
    return s.ctx === "cat" && /^(none|\d+)$/.test(s.cat);
}

export const DEFAULT_TX_SEARCH: TxSearch = { scope: "all", cat: "all", dir: "all", ctx: "acc" };

export function parseTxSearch(raw: Record<string, unknown>): TxSearch {
    const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
    const scope = s(raw.scope);
    const cat = s(raw.cat);
    const dir = s(raw.dir);
    const range = TxRange.safeParse(s(raw.range));
    return {
        scope: /^(all|group:\d+|account:\d+)$/.test(scope) ? (scope as AccountScope) : "all",
        cat: CAT_LIST.test(cat) ? cat : "all",
        dir: dir === "in" || dir === "out" ? dir : "all",
        range: range.success ? range.data : undefined,
        ctx: raw.ctx === "cat" ? "cat" : "acc",
        view: raw.view === "none" ? "none" : undefined,
    };
}

/** Only what differs from the defaults goes into the URL. */
export function compactTxSearch(s: Partial<TxSearch>): Partial<TxSearch> {
    const out: Partial<TxSearch> = {};
    if (s.scope && s.scope !== "all") out.scope = s.scope;
    if (s.cat && s.cat !== "all") out.cat = s.cat;
    if (s.dir && s.dir !== "all") out.dir = s.dir;
    if (s.range) out.range = s.range;
    if (s.ctx === "cat") out.ctx = "cat";
    if (s.view === "none") out.view = "none";
    return out;
}

// ---------- Ways into the list ----------

/**
 * How the list is entered; every place that opens it says which kind it is:
 * - `account` / `category`: picked in the sidebar. The search stays (look up "rewe" in several
 *   accounts); an account brings its kept filters, a category starts without filters.
 * - `show`: from outside the list (overview, settings, new account). The search is cleared, the
 *   list shows what was asked for, an account without filters its kept ones.
 * - `query`: with a search of its own (palette, rule). It replaces the search, and the list shows
 *   what that search looked through: all accounts, all dates, no other filters.
 */
export type TxEntry =
    | { kind: "account"; scope: AccountScope }
    | { kind: "category"; cat: string }
    | { kind: "show"; search?: Partial<TxSearch> }
    | { kind: "query"; q: string };

/**
 * The URL filters of an entry and the new search text (undefined: the search stays). `kept` are
 * the filters this browser keeps per account; an entry never changes them.
 */
export function txEntry(e: TxEntry, kept: TxFilters = {}): { search: Partial<TxSearch>; q?: string } {
    // An account view without filters of its own shows the kept ones
    const withKept = (s: Partial<TxSearch>) => {
        const full = parseTxSearch(s as Record<string, unknown>);
        return compactTxSearch(keepsFilters(full) && !filterOf(full) ? { ...full, ...kept[full.scope] } : full);
    };
    switch (e.kind) {
        case "account":
            return { search: withKept({ scope: e.scope }) };
        case "category":
            return { search: compactTxSearch({ cat: e.cat, ctx: "cat" }) };
        case "show":
            return { search: withKept(e.search ?? {}), q: "" };
        case "query":
            return { search: { range: "all" }, q: e.q.trim() };
    }
}

// ---------- Last view ----------

/**
 * A view the sidebar marks: an account, a group or a category ("category:none" is "Ohne
 * Kategorie"). "Umsätze" in the navigation returns to the last one shown; "Alle Konten" has no
 * node in the sidebar and is never one.
 */
export const TxView = z.string().regex(/^(account:\d+|group:\d+|category:(\d+|none))$/);
export type TxView = z.infer<typeof TxView>;

/** The view a search shows, when the sidebar marks it. */
export function txViewOf(s: TxSearch): TxView | undefined {
    if (s.view === "none") return undefined;
    if (isCategoryView(s)) return `category:${s.cat}`;
    return s.scope === "all" ? undefined : s.scope;
}

/** What exists to show; undefined while it is still loading. */
export interface KnownNodes {
    accounts?: ReadonlySet<number>;
    groups?: ReadonlySet<number>;
    categories?: ReadonlySet<number>;
}

/**
 * Where "Umsätze" leads: the last view, entered as from the sidebar (an account with its kept
 * filters, the search stays), or the hint to pick one when there is none or it is gone. A view
 * whose list is still loading counts as there.
 */
export function txHome(last: TxView | null, known: KnownNodes, kept: TxFilters = {}): Partial<TxSearch> {
    const m = last ? /^(account|group|category):(\d+|none)$/.exec(last) : null;
    if (!m) return { view: "none" };
    const [, kind, id] = m as unknown as [string, "account" | "group" | "category", string];
    const set = kind === "account" ? known.accounts : kind === "group" ? known.groups : known.categories;
    const exists = id === "none" ? kind === "category" : !set || set.has(Number(id));
    if (!exists) return { view: "none" };
    return kind === "category" ? txEntry({ kind: "category", cat: id }).search : txEntry({ kind: "account", scope: `${kind}:${id}` as AccountScope }, kept).search;
}

// ---------- Filters kept per account ----------

/**
 * The filters of the account view that this browser keeps per account, group or "all": category,
 * direction and range. Never the search text: it often holds bank data (counterparty, amount, IBAN).
 */
export const TxFilter = z.object({
    cat: z.string().regex(CAT_LIST).refine((c) => c !== "all").optional(),
    dir: z.enum(["in", "out"]).optional(),
    range: TxRange.optional(),
});
export type TxFilter = z.infer<typeof TxFilter>;

export const MAX_KEPT_FILTERS = 500;
export const TxFilters = z
    .record(AccountScope, TxFilter)
    .refine((r) => Object.keys(r).length <= MAX_KEPT_FILTERS);
export type TxFilters = z.infer<typeof TxFilters>;

/** Only the account view keeps filters; the view of a category does not. */
export function keepsFilters(s: TxSearch): boolean {
    return s.ctx === "acc";
}

/** The kept filters of a view; undefined when none is set. */
export function filterOf(s: TxSearch): TxFilter | undefined {
    const f: TxFilter = {};
    if (s.cat !== "all") f.cat = s.cat;
    if (s.dir !== "all") f.dir = s.dir;
    if (s.range) f.range = s.range;
    return Object.keys(f).length ? f : undefined;
}

const sameFilter = (a: TxFilter | undefined, b: TxFilter | undefined) =>
    a?.cat === b?.cat && a?.dir === b?.dir && a?.range === b?.range;

/**
 * The kept filters with those of one scope replaced (newest last) or removed when none is set;
 * beyond the limit the oldest entries go. The same object when nothing changes.
 */
export function withFilter(all: TxFilters, scope: AccountScope, f: TxFilter | undefined): TxFilters {
    if (sameFilter(all[scope], f)) return all;
    const next = Object.fromEntries(Object.entries(all).filter(([k]) => k !== scope)) as TxFilters;
    if (!f) return next;
    next[scope] = f;
    const keys = Object.keys(next);
    return keys.length > MAX_KEPT_FILTERS ? Object.fromEntries(keys.slice(-MAX_KEPT_FILTERS).map((k) => [k, next[k as AccountScope]!])) : next;
}

export const RANGE_LABELS: Record<TxRange, string> = {
    month: "Dieser Monat",
    last: "Letzter Monat",
    "30": "30 Tage",
    "90": "90 Tage",
    "365": "12 Monate",
    all: "Alle",
};
