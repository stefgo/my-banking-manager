import { QueryClient, useMutation, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer } from "react";
import {
    routes,
    type AccountScope,
    type Card,
    type ClientKind,
    type Profile,
    type SettingKey,
    type Settings,
    type Topic,
    type TransactionQuery,
    type TxRange,
    type TxDateBounds,
} from "@mbm/shared";
import { ApiFailure, call, errorText } from "./api";
import { indexCategories } from "./tree";
import { findCachedTx } from "./txCache";
import { ui } from "./ui";

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiFailure && err.status >= 400 && err.status < 500) && count < 2,
        },
    },
});

/** Query keys per topic of a server event. */
const TOPIC_KEYS: Record<Topic, string[][]> = {
    accounts: [["accounts"], ["stats"], ["transfers", "accounts"]],
    groups: [["groups"]],
    // Not the rules: counting their hits goes through every booking. The rules page fetches
    // them again when opened (`useRules({ fresh: true })`).
    // Deleting bookings also changes what is new
    transactions: [["transactions"], ["stats"], ["payees"], ["transfer-payees"], ["transfers"], ["unread"]],
    categories: [["categories"]],
    rules: [["rules"]],
    imports: [["imports"]],
    importFormats: [["import-formats"]],
    users: [["users"]],
    devices: [["devices"]],
    activity: [["activity"]],
    connections: [["connections"], ["transfers", "accounts"]],
    // The forecast of the balance series is made from the orders
    orders: [["orders"], ["stats", "series"]],
    transfers: [["transfers"]],
    payees: [["transfer-payees"]],
    bankDirectory: [["bank-directory"], ["banks"], ["bank-of"]],
    // Marked on another device of this user: the counts and the marks in the lists
    unread: [["unread"], ["transactions"]],
};

export function invalidate(...topics: Topic[]): void {
    for (const t of topics) for (const key of TOPIC_KEYS[t]) void queryClient.invalidateQueries({ queryKey: key });
}

// ---------- Reads ----------

/** Asked again on every return to the window: a new web client may wait on the server (see Gate). */
export const useStatus = () => useQuery({ queryKey: ["status"], queryFn: () => call(routes.status), staleTime: 0, retry: 1, refetchOnWindowFocus: true });

export const useMe = (enabled: boolean) =>
    useQuery({ queryKey: ["me"], queryFn: () => call(routes.me), enabled, retry: false, staleTime: Infinity });

export const useProfile = (enabled = true) =>
    useQuery({ queryKey: ["profile"], queryFn: () => call(routes.profile, { query: { client: "web" } }), enabled, staleTime: Infinity });

export const useAccounts = () => useQuery({ queryKey: ["accounts"], queryFn: () => call(routes.listAccounts) });
export const useGroups = () => useQuery({ queryKey: ["groups"], queryFn: () => call(routes.listGroups) });
export const useCategories = () => useQuery({ queryKey: ["categories"], queryFn: () => call(routes.listCategories) });
/** `fresh`: fetch again on mount, for current hit counts (bookings do not refetch the rules). */
export const useRules = (opts: { fresh?: boolean } = {}) =>
    useQuery({ queryKey: ["rules"], queryFn: () => call(routes.listRules), refetchOnMount: opts.fresh ? "always" : true });
export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => call(routes.listUsers) });
export const useDevices = () => useQuery({ queryKey: ["devices"], queryFn: () => call(routes.listDevices) });
export const useActivity = () => useQuery({ queryKey: ["activity"], queryFn: () => call(routes.activity, { query: { limit: 200 } }) });
export const useImports = () => useQuery({ queryKey: ["imports"], queryFn: () => call(routes.listImports) });
export const useImportFormats = () => useQuery({ queryKey: ["import-formats"], queryFn: () => call(routes.listImportFormats) });
export const usePayees = () => useQuery({ queryKey: ["payees"], queryFn: () => call(routes.payees, { query: {} }) });

// ---------- Transfers ----------

export const useTransferAccounts = () => useQuery({ queryKey: ["transfers", "accounts"], queryFn: () => call(routes.transferAccounts) });
export const useTransfers = () => useQuery({ queryKey: ["transfers", "list"], queryFn: () => call(routes.listTransfers, { query: {} }) });
export const useTransfer = (id: number | null) =>
    useQuery({
        queryKey: ["transfers", "one", id],
        queryFn: () => call(routes.getTransfer, { params: { id: id! } }),
        enabled: id !== null,
        staleTime: 0,
        // Server events announce every change; this only covers a lost connection
        refetchInterval: (q) => (q.state.data && !q.state.data.finishedAt ? 3000 : false),
    });
export const useTransferPayees = () => useQuery({ queryKey: ["transfer-payees"], queryFn: () => call(routes.listPayees) });

export const useTransactions = (q: TransactionQuery, enabled = true) =>
    useQuery({
        queryKey: ["transactions", q],
        queryFn: () => call(routes.listTransactions, { query: q }),
        placeholderData: keepPreviousData,
        enabled,
    });

/** `forecastDays`: also the balance of that many days after today, from the known orders. */
export const useSeries = (scope: AccountScope, days: number, range?: TxRange, span?: TxDateBounds, forecastDays = 0) =>
    useQuery({
        queryKey: ["stats", "series", scope, days, range, span?.from, span?.to, forecastDays],
        queryFn: () => call(routes.series, { query: { scope, days, range, from: span?.from, to: span?.to, forecastDays } }),
    });

/** What narrows the income and expenses of `useFlows`, as the filters of the list do. */
export type FlowFilter = { category?: string; dir?: "all" | "in" | "out" };

/** Income and expenses per day over the days of the balance series, narrowed by `filter`; `enabled` false leaves it unasked. */
export const useFlows = (scope: AccountScope, days: number, range?: TxRange, span?: TxDateBounds, filter?: FlowFilter, enabled = true) =>
    useQuery({
        queryKey: ["stats", "flows", scope, days, range, span?.from, span?.to, filter?.category, filter?.dir],
        queryFn: () =>
            call(routes.flows, {
                query: { scope, days, range, from: span?.from, to: span?.to, category: filter?.category, dir: filter?.dir },
            }),
        enabled,
    });

export const useOrders = (scope: AccountScope = "all") => useQuery({ queryKey: ["orders", "list", scope], queryFn: () => call(routes.listOrders, { query: { scope } }) });

export const useUpcomingOrders = (scope: AccountScope, days: number, count: number) =>
    useQuery({ queryKey: ["orders", "upcoming", scope, days, count], queryFn: () => call(routes.upcomingOrders, { query: { scope, days, count } }) });

export const useCashflow = (scope: AccountScope, from: string, to: string) =>
    useQuery({ queryKey: ["stats", "cashflow", scope, from, to], queryFn: () => call(routes.cashflow, { query: { scope, from, to } }) });

export const useCategorySums = (scope: AccountScope, from: string, to: string) =>
    useQuery({ queryKey: ["stats", "categories", scope, from, to], queryFn: () => call(routes.categorySums, { query: { scope, from, to } }) });

/** Categories with lookup by id, children per parent, top-level order. */
export function useCategoryIndex() {
    const q = useCategories();
    const index = useMemo(() => indexCategories(q.data?.items ?? [], q.data?.none), [q.data]);
    return { ...q, index, uncategorized: q.data?.uncategorized ?? 0 };
}

// ---------- Profile ----------

export function useSettings(): Settings | undefined {
    return useProfile().data?.settings;
}

/** Settings of one device class; the web class comes from the profile of this client. */
export function useClientSettings(client: ClientKind): Settings | undefined {
    const own = useSettings();
    const other = useQuery({
        queryKey: ["profile", "client", client],
        queryFn: () => call(routes.clientSettings, { query: { client } }),
        enabled: client !== "web",
        staleTime: Infinity,
    });
    return client === "web" ? own : other.data;
}

/** Changes one setting of a device class at once in the cache and then on the server. */
export async function saveSetting<K extends SettingKey>(key: K, value: Settings[K], client: ClientKind = "web"): Promise<void> {
    if (client === "web") queryClient.setQueryData<Profile>(["profile"], (p) => (p ? { ...p, settings: { ...p.settings, [key]: value } } : p));
    else queryClient.setQueryData<Settings>(["profile", "client", client], (s) => (s ? { ...s, [key]: value } : s));
    try {
        await call(routes.setSetting, { params: { key }, query: { client }, body: { value } });
    } catch (err) {
        ui.toast(errorText(err), "error");
        void queryClient.invalidateQueries({ queryKey: ["profile"] });
    }
}

export function setCardsInCache(update: (cards: Card[]) => Card[]): void {
    queryClient.setQueryData<Profile>(["profile"], (p) => (p ? { ...p, cards: update(p.cards) } : p));
}

// ---------- Writes ----------

interface ActionOptions<T> {
    ok?: string | ((r: T) => string);
    topics?: Topic[];
    quiet?: boolean;
    /** Handles an error itself (e.g. at a form field); true = no message. */
    onError?: (err: unknown) => boolean;
}

/**
 * Runs a change on the server, shows a toast with the result or the server's message, and
 * refreshes the given topics (the WebSocket event does that for the other clients).
 */
export function useAction() {
    const m = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn() });
    const run = async <T>(fn: () => Promise<T>, opts: ActionOptions<T> = {}): Promise<T | undefined> => {
        try {
            const result = (await m.mutateAsync(fn)) as T;
            if (opts.topics) invalidate(...opts.topics);
            if (opts.ok) ui.toast(typeof opts.ok === "function" ? opts.ok(result) : opts.ok);
            return result;
        } catch (err) {
            if (opts.onError?.(err)) return undefined;
            if (!opts.quiet) ui.toast(errorText(err), "error");
            return undefined;
        }
    };
    return {
        pending: m.isPending,
        run,
        /** Like `run`, but only says whether it worked (for confirmations that stay open on failure). */
        succeeds: async <T>(fn: () => Promise<T>, opts: ActionOptions<T> = {}): Promise<boolean> => (await run(fn, opts)) !== undefined,
    };
}

/** A booking from any loaded list; only when none has it, all bookings are fetched once. */
export function useTxById(id: number | null | undefined) {
    const cached = id == null
        ? undefined
        : findCachedTx<{ id: number }>(
              queryClient
                  .getQueryCache()
                  .findAll({ queryKey: ["transactions"] })
                  .map((q) => ({ data: q.state.data, updatedAt: q.state.dataUpdatedAt, invalidated: q.state.isInvalidated })),
              id,
          );
    const all = useTransactions({ range: "all", limit: 20000 }, id != null && !cached);
    // Re-read the cache on every list change so edits show at once
    useTransactionsVersion();
    return (cached ?? all.data?.items.find((t) => t.id === id)) as import("@mbm/shared").Transaction | undefined;
}

/** Renders again whenever a list of bookings got new data, which the cache lookup above cannot see. */
function useTransactionsVersion(): void {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(
        () =>
            queryClient.getQueryCache().subscribe((e) => {
                if (e.type === "updated" && e.action.type === "success" && e.query.queryKey[0] === "transactions") bump();
            }),
        [],
    );
}
