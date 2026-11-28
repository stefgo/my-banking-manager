// Bank accesses and fetch runs in the web client. PINs live only in the state of an open dialog
// and in the request that carries them; nothing of it goes into browser storage.

import { useQuery } from "@tanstack/react-query";
import { routes, type BankConnection, type SyncRun } from "@mbm/shared";
import { ApiFailure, call, errorText } from "./api";
import { invalidate, queryClient } from "./queries";
import { plural } from "./format";
import { currentDialog, ui } from "./ui";

export const useConnections = () => useQuery({ queryKey: ["connections"], queryFn: () => call(routes.listConnections) });
export const useBankDirectory = () => useQuery({ queryKey: ["bank-directory"], queryFn: () => call(routes.bankDirectory) });
export const useConnectorStatus = () => useQuery({ queryKey: ["connectors"], queryFn: () => call(routes.connectorStatus), staleTime: 60_000 });

/**
 * The account list the own login last fetched from the bank, with the state of each account; the
 * server keeps it in memory. Under "connections", so taking over or detaching refreshes it.
 */
export const useOfferedAccounts = (connectionId: number, enabled: boolean) =>
    useQuery({ queryKey: ["connections", "offered", connectionId], queryFn: () => call(routes.lastOfferedAccounts, { params: { id: connectionId } }), enabled });

/** Fetch runs of the signed-in user; the server keeps them current with "sync" events. */
const syncQuery = { queryKey: ["sync"], queryFn: () => call(routes.listSync), staleTime: Infinity };
export const useSyncRuns = () => useQuery(syncQuery);

export const setSyncRuns = (runs: SyncRun[]): void => {
    queryClient.setQueryData(["sync"], runs);
};

export const isActive = (r: SyncRun): boolean => r.status === "running" || r.status === "approval";

/**
 * The accounts running fetches are updating. A run for the orders alone changes neither balances
 * nor bookings, and an account the bank no longer reports is skipped by its run.
 */
export const syncingAccountIds = (runs: SyncRun[]): Set<number> =>
    new Set(runs.filter((r) => isActive(r) && !r.ordersOnly).flatMap((r) => r.accountIds.filter((id) => !r.missingAccounts.includes(id))));

/** Is a fetch updating one of these accounts? A row re-renders only when the answer changes. */
export const useIsSyncing = (accountIds: number[]): boolean =>
    useQuery({
        ...syncQuery,
        select: (runs) => {
            const syncing = syncingAccountIds(runs);
            return accountIds.some((id) => syncing.has(id));
        },
    }).data ?? false;

/**
 * Takes the runs of a "sync" event. A run that needs an approval or failed opens the fetch panel
 * (or, while another dialog is open, says so in a toast); a finished one that brought new bookings says so in a toast.
 */
export function receiveSyncRuns(runs: SyncRun[]): void {
    const known = queryClient.getQueryData<SyncRun[]>(["sync"]);
    setSyncRuns(runs);
    // Without a previous list every run would look new, also old finished ones
    if (!known) return;
    const before = new Map(known.map((r) => [r.id, r]));
    const changed = runs.filter((r) => before.get(r.id)?.status !== r.status);
    const failed = changed.filter((r) => r.status === "error" && r.error !== "cancelled");
    if (changed.some((r) => r.status === "approval") || failed.length > 0) {
        if (!currentDialog()) ui.open({ kind: "sync" });
        else for (const r of failed) ui.toast(`${r.connectionName}: Abruf fehlgeschlagen`, "error");
    }
    for (const r of changed) {
        // Only new bookings are worth a toast. New accounts at the bank are not named here: the
        // bank card and the fetch panel list them
        if (r.status !== "done") continue;
        if (r.ordersMessage) ui.toast(`${r.connectionName}: ${r.ordersMessage}`, "error");
        if (r.foreignCurrency > 0) ui.toast(`${r.connectionName}: ${plural(r.foreignCurrency, "Umsatz", "Umsätze")} in Fremdwährung nicht übernommen`, "error");
        if (r.consentEndedAccounts.length > 0) ui.toast(`${r.connectionName}: Freigabe für ${plural(r.consentEndedAccounts.length, "Konto", "Konten")} abgelaufen, bitte erneuern`, "error");
        if (r.ordersOnly) ui.toast(`${r.connectionName}: Aufträge abgerufen`);
        else if (r.newTransactions > 0) ui.toast(`${r.connectionName}: ${plural(r.newTransactions, "neuer Umsatz", "neue Umsätze")}`);
    }
}

/**
 * Starts a fetch in the background; only an approval or an error opens the fetch panel. "Keine
 * eigene Anmeldung" offers to add one. `ordersOnly` fetches just the standing orders and
 * scheduled transfers.
 */
export async function startSync(target: { accountId?: number; connectionId?: number; groupId?: number }, pins?: Record<string, string>, ordersOnly = false): Promise<void> {
    try {
        const runs = await call(ordersOnly ? routes.fetchOrders : routes.startSync, { body: { ...target, pins } });
        const others = (queryClient.getQueryData<SyncRun[]>(["sync"]) ?? []).filter((r) => !runs.some((n) => n.id === r.id));
        setSyncRuns([...runs, ...others]);
        if (runs.length === 0) ui.toast("Es gibt keine Bankkonten mit eigener Anmeldung zum Abrufen.", "error");
    } catch (err) {
        if (err instanceof ApiFailure && err.code === "no_own_login") {
            const accountId = target.accountId;
            const connectionId = accountId !== undefined ? connectionOfAccount(accountId) : undefined;
            ui.confirm({
                title: "Keine eigene Anmeldung",
                text: `${err.message} Abrufen kannst du nur über deine eigene Anmeldung.`,
                confirm: "Anmeldung hinzufügen",
                onConfirm: () => openLoginSetup(connectionId),
            });
            return;
        }
        ui.toast(errorText(err), "error");
    }
}

function connectionOfAccount(accountId: number): number | undefined {
    const accounts = queryClient.getQueryData<{ id: number; connectionId: number | null }[]>(["accounts"]);
    return accounts?.find((a) => a.id === accountId)?.connectionId ?? undefined;
}

/** Whether the own login at an access can fetch: set up, and for PSD2 with a running approval. */
export function canFetch(c: BankConnection): boolean {
    const l = c.myLogin;
    if (!l || l.status === "setup" || l.status === "credentials_lost") return false;
    return c.kind !== "psd2" || (l.status !== "consent_needed" && !!l.consentUntil);
}

/** Sets up the own login at an access: FinTS or PSD2, by the kind of the access; a new FinTS access without one. */
export function openLoginSetup(connectionId: number | undefined): void {
    const conn = connectionId === undefined ? undefined : queryClient.getQueryData<BankConnection[]>(["connections"])?.find((c) => c.id === connectionId);
    if (conn?.kind === "psd2") ui.open({ kind: "psd2Setup", connectionId });
    else ui.open({ kind: "bankSetup", connectionId });
}

export const refreshBank = (): void => invalidate("connections", "accounts", "transactions", "orders");
