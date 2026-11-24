// Fetch runs: one per bank login, in the background, only when a user starts them. A run lists
// the accounts (to notice new and missing ones), fetches balances and bookings and takes them
// over. When the bank asks for an approval, the run waits: for a decoupled approval it asks the
// connector every few seconds; for a TAN it waits for the user. Standing orders and scheduled
// transfers come along, unless the bank wants an approval for them every time: then only a run
// for the orders alone fetches them. Progress goes to the user's
// clients as a "sync" event. The user key and a PIN that is not stored live in memory only,
// for as long as the run does.

import { randomUUID } from "node:crypto";
import { ConnectorTransaction, type ConnectorAccount, type ConnectorAccountRef, type ConnectorBalance, type ConnectorChallenge, type ConnectorLogin, type ConnectorScheduledTransfer, type ConnectorStandingOrder, type SyncRun } from "@mbm/shared";
import { ConnectorCallError, type ConnectorClient } from "../connectors/client.js";
import type { Db } from "../db/database.js";
import { HttpError } from "../http/errors.js";
import type { AppContext } from "../http/route.js";
import * as bank from "./bankaccess.js";
import { accountsInScope, requireGroup } from "./accounts.js";
import { applyFetch } from "./fetchimport.js";
import { markOrdersFetched, replaceScheduledTransfers, replaceStandingOrders } from "./orders.js";
import { logActivity } from "./users.js";

type Outcome = { status: "done"; data: unknown; state: string } | { status: "approval"; operationId: string; challenge: ConnectorChallenge } | { status: "confirm"; operationId: string };

interface Run {
    api: SyncRun;
    userId: number;
    userName: string;
    loginId: number;
    key: Buffer;
    pin: string | undefined;
    cancelled: boolean;
    /** Set while waiting for a TAN. */
    tanWaiter: { operationId: string; resolve: (o: Outcome) => void; reject: (e: unknown) => void } | null;
    /** Operation the connector holds while the run waits, to cancel it. */
    operationId: string | null;
}

class Cancelled extends Error {}

/** Days a fetch reaches back before its starting point: banks book some payments late. */
const OVERLAP_DAYS = 14;

/**
 * Where a fetch of an account starts: the more recent of its last fetch and its newest booked
 * booking, less the overlap. With neither, nothing: as far back as the bank goes. The last fetch
 * keeps an account with rare bookings from reaching months back (and the bank from asking for an
 * approval each time); the newest booking stands in until an account was fetched once.
 */
export function fetchFrom(newestBooking: string | null, fetchedAt: string | null): string | undefined {
    const points = [newestBooking, fetchedAt].filter((p): p is string => !!p).map((p) => Date.parse(p));
    if (points.length === 0) return undefined;
    return new Date(Math.max(...points) - OVERLAP_DAYS * 86_400_000).toISOString().slice(0, 10);
}

const KEEP_FINISHED_MS = 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SyncManager {
    private readonly runs = new Map<string, Run>();

    constructor(
        private readonly ctx: AppContext,
        private readonly pollMs = 2000,
    ) {}

    /** True while a run of this user (or of anybody) is going on. */
    active(userId?: number): boolean {
        return [...this.runs.values()].some((r) => (r.api.status === "running" || r.api.status === "approval") && (userId === undefined || r.userId === userId));
    }

    list(userId: number): SyncRun[] {
        this.prune();
        return [...this.runs.values()].filter((r) => r.userId === userId).map((r) => r.api);
    }

    /** Starts runs for the logins the request covers; a login with a run going on keeps it. */
    start(db: Db, user: { id: number; name: string }, userKey: Buffer, req: { accountId?: number; connectionId?: number; groupId?: number; pins?: Record<string, string>; ordersOnly?: boolean }): SyncRun[] {
        const targets = this.targets(db, user.id, req);
        return targets.map(({ login, accountIds }) => {
            const going = [...this.runs.values()].find((r) => r.loginId === login.id && (r.api.status === "running" || r.api.status === "approval"));
            if (going) return going.api;
            const conn = bank.requireConnection(db, login.connection_id);
            const run: Run = {
                api: {
                    id: randomUUID(), connectionId: conn.id, connectionName: conn.name, status: "running", challenge: null, accountIds,
                    newTransactions: 0, newAccounts: [], missingAccounts: [], ordersOnly: req.ordersOnly === true, ordersMessage: null, error: null, message: null, startedAt: new Date().toISOString(), finishedAt: null,
                },
                userId: user.id,
                userName: user.name,
                loginId: login.id,
                key: Buffer.from(userKey),
                pin: req.pins?.[String(conn.id)],
                cancelled: false,
                tanWaiter: null,
                operationId: null,
            };
            this.runs.set(run.api.id, run);
            void this.execute(run);
            return run.api;
        });
    }

    async tan(id: string, userId: number, tan: string): Promise<SyncRun> {
        const run = this.own(id, userId);
        const w = run.tanWaiter;
        if (!w) throw new HttpError(409, "no_tan_needed", "Dieser Abruf wartet auf keine TAN.");
        run.tanWaiter = null;
        try {
            w.resolve(await this.client(run).call("operationTan", { id: w.operationId, body: { tan } }));
        } catch (e) {
            w.reject(e);
        }
        await sleep(0);
        return run.api;
    }

    async cancel(id: string, userId: number): Promise<void> {
        const run = this.own(id, userId);
        run.cancelled = true;
        run.tanWaiter?.reject(new Cancelled());
        run.tanWaiter = null;
        if (run.operationId) await this.client(run).call("cancelOperation", { id: run.operationId }).catch(() => undefined);
    }

    // ---------- Inside a run ----------

    private own(id: string, userId: number): Run {
        const run = this.runs.get(id);
        if (!run || run.userId !== userId) throw new HttpError(404, "not_found", "Abruf nicht gefunden");
        return run;
    }

    private client(run: Run): ConnectorClient {
        const db = this.ctx.vault.database;
        return this.ctx.connectors.get(bank.requireConnection(db, run.api.connectionId).connector);
    }

    private emit(run: Run): void {
        this.ctx.events.toUser(run.userId, { type: "sync", runs: this.list(run.userId) });
    }

    /** Which logins and accounts a request covers; refuses accounts without an own login. */
    private targets(db: Db, userId: number, req: { accountId?: number; connectionId?: number; groupId?: number }): { login: bank.LoginRow; accountIds: number[] }[] {
        const linked = (loginId: number) =>
            (db.prepare("SELECT account_id FROM bank_login_accounts WHERE login_id = ? AND missing_since IS NULL ORDER BY account_id").all(loginId) as { account_id: number }[]).map((r) => r.account_id);
        if (req.accountId !== undefined) {
            const row = db
                .prepare("SELECT l.* FROM bank_login_accounts bla JOIN bank_logins l ON l.id = bla.login_id WHERE bla.account_id = ? AND l.user_id = ?")
                .get(req.accountId, userId) as bank.LoginRow | undefined;
            if (!row) {
                const conn = db.prepare("SELECT c.name FROM accounts a JOIN bank_connections c ON c.id = a.connection_id WHERE a.id = ?").get(req.accountId) as { name: string } | undefined;
                if (!conn) throw new HttpError(422, "not_bank_account", "Offline-Konten haben keinen Abruf.");
                throw new HttpError(409, "no_own_login", `Keine eigene Anmeldung bei ${conn.name}.`);
            }
            return [{ login: row, accountIds: [req.accountId] }];
        }
        const logins =
            req.connectionId !== undefined
                ? [bank.requireLogin(db, req.connectionId, userId)]
                : (db.prepare("SELECT * FROM bank_logins WHERE user_id = ? AND tan_method IS NOT NULL AND status != 'credentials_lost' ORDER BY id").all(userId) as bank.LoginRow[]);
        // A group narrows each login to its accounts in the group; bank accounts without an own login stay out
        let inGroup: (id: number) => boolean = () => true;
        if (req.groupId !== undefined && req.connectionId === undefined) {
            requireGroup(db, req.groupId);
            const ids = new Set(accountsInScope(db, `group:${req.groupId}`));
            inGroup = (id) => ids.has(id);
        }
        return logins.map((login) => ({ login, accountIds: linked(login.id).filter(inGroup) })).filter((t) => t.accountIds.length > 0);
    }

    private async execute(run: Run): Promise<void> {
        let failed: { code: string; message: string } | null = null;
        try {
            await this.fetch(run);
        } catch (e) {
            failed = e instanceof Cancelled || run.cancelled ? { code: "cancelled", message: "Abgebrochen." } : errorOf(e);
        }
        run.key.fill(0);
        run.pin = undefined;
        run.tanWaiter = null;
        run.operationId = null;
        Object.assign(run.api, { status: failed ? "error" : "done", challenge: null, error: failed?.code ?? null, message: failed?.message ?? null, finishedAt: new Date().toISOString() });
        try {
            const db = this.ctx.vault.database;
            if (failed && failed.code !== "cancelled") {
                bank.setLoginStatus(db, run.loginId, failed.code === "pin_wrong" ? "pin_wrong" : failed.code === "pin_required" ? bank.loginById(db, run.loginId).status : "error", failed.message.slice(0, 300));
            }
            db.prepare("INSERT INTO sync_runs (connection_id, login_id, user_id, account_id, started_at, finished_at, trigger, result, new_transactions, details) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)").run(
                run.api.connectionId, run.loginId, run.userId, run.api.accountIds.length === 1 ? run.api.accountIds[0] : null,
                run.api.startedAt, run.api.finishedAt, failed ? failed.code : "ok", run.api.newTransactions, failed?.message ?? null,
            );
            logActivity(db, { userId: run.userId, userName: run.userName, deviceId: null }, failed ? "sync_failed" : "sync", run.api.connectionName, failed ? failed.message.slice(0, 200) : run.api.ordersOnly ? "Aufträge abgerufen" : `${run.api.newTransactions} neue Umsätze`);
            this.ctx.events.changed("accounts", "transactions", "connections", "activity", "orders", "unread");
        } catch {
            // the database was locked meanwhile; the run's state is still reported
        }
        this.emit(run);
    }

    private async fetch(run: Run): Promise<void> {
        const db = () => this.ctx.vault.database;
        const conn = bank.requireConnection(db(), run.api.connectionId);
        const client = this.ctx.connectors.get(conn.connector);
        const bankRef = { blz: conn.blz, url: conn.fints_url };
        const login = (): ConnectorLogin => {
            const row = bank.loginById(db(), run.loginId);
            if (row.save_pin === 0 && !run.pin) throw new HttpError(409, "pin_required", "Bitte die PIN eingeben.");
            return bank.connectorLogin(row, run.key, run.pin);
        };

        /** One connector call; waits through approvals; stores the state it returns. */
        const call = async <T>(route: "accounts" | "balances" | "transactions" | "cardTransactions" | "standingOrders" | "scheduledTransfers", extra: object): Promise<T> => {
            if (run.cancelled) throw new Cancelled();
            let out = (await client.call(route, { body: { bank: bankRef, login: login(), ...extra } as never })) as Outcome;
            while (out.status === "approval") out = await this.approval(run, client, out);
            if (out.status === "confirm") throw new HttpError(502, "connector_error", "Der Konnektor wartet unerwartet auf eine Bestätigung.");
            bank.saveConnectorState(db(), run.loginId, run.key, out.state);
            return out.data as T;
        };

        // Accounts: notice new and missing ones, refresh how to address them
        const { accounts } = await call<{ accounts: ConnectorAccount[] }>("accounts", {});
        const now = new Date().toISOString();
        const linkedRows = db()
            .prepare("SELECT bla.account_id, a.external_id FROM bank_login_accounts bla JOIN accounts a ON a.id = bla.account_id WHERE bla.login_id = ?")
            .all(run.loginId) as { account_id: number; external_id: string }[];
        for (const r of linkedRows) {
            const acc = accounts.find((a) => a.externalId === r.external_id);
            if (acc) bank.takeOverAccount(db(), conn.id, run.loginId, acc, { groupId: null });
            else {
                db().prepare("UPDATE bank_login_accounts SET missing_since = COALESCE(missing_since, ?) WHERE login_id = ? AND account_id = ?").run(now, run.loginId, r.account_id);
                run.api.missingAccounts.push(r.account_id);
            }
        }
        run.api.newAccounts = accounts
            .filter((a) => bank.isSupportedKind(a.kind) && bank.accountIdOf(db(), conn.id, a.externalId) === null && !bank.isIgnored(db(), conn.id, a.externalId))
            .map((a) => a.name);
        this.emit(run);

        const targets = run.api.accountIds
            .filter((id) => !run.api.missingAccounts.includes(id))
            .map((id) => {
                const row = db().prepare("SELECT a.kind, a.external_id, bla.account_ref, bla.allowed_operations FROM accounts a JOIN bank_login_accounts bla ON bla.account_id = a.id WHERE a.id = ? AND bla.login_id = ?").get(id, run.loginId) as
                    | { kind: string; external_id: string; account_ref: string; allowed_operations: string }
                    | undefined;
                return row ? { id, kind: row.kind, ref: JSON.parse(row.account_ref) as ConnectorAccountRef, caps: JSON.parse(row.allowed_operations) as ConnectorAccount["capabilities"] } : null;
            })
            .filter((t): t is NonNullable<typeof t> => t !== null);

        // Balances of all accounts in one call
        const withBalance = run.api.ordersOnly ? [] : targets.filter((t) => t.kind !== "credit_card" && t.caps.balance);
        const balances = withBalance.length ? (await call<{ balances: ConnectorBalance[] }>("balances", { accounts: withBalance.map((t) => t.ref) })).balances : [];

        for (const t of run.api.ordersOnly ? [] : targets) {
            const newest = (db().prepare("SELECT MAX(booking_date) AS d FROM transactions WHERE account_id = ? AND source = 'bank' AND status = 'booked'").get(t.id) as { d: string | null }).d;
            const fetchedAt = (db().prepare("SELECT transactions_fetched_at AS f FROM accounts WHERE id = ?").get(t.id) as { f: string | null }).f;
            const from = fetchFrom(newest, fetchedAt);
            let txs: ConnectorTransaction[] = [];
            let balance = balances[withBalance.indexOf(t)] ?? null;
            const fetchesBookings = (t.kind === "credit_card" && !!t.caps.cardTransactions) || !!t.caps.transactions;
            if (t.kind === "credit_card" && t.caps.cardTransactions) {
                const r = await call<{ transactions: ConnectorTransaction[]; balance: ConnectorBalance | null }>("cardTransactions", { account: t.ref, ...(from ? { from } : {}) });
                txs = r.transactions;
                balance = r.balance;
            } else if (t.caps.transactions) {
                txs = (await call<{ transactions: ConnectorTransaction[] }>("transactions", { account: t.ref, ...(from ? { from } : {}) })).transactions;
            }
            // Data that comes after an approval has not been checked against the contract yet
            const checked = ConnectorTransaction.array().safeParse(txs);
            if (!checked.success) throw new ConnectorCallError("internal", "Die Antwort des Konnektors passt nicht zum Vertrag.");
            const result = applyFetch(db(), t.id, checked.data, balance, run.userId);
            // The start of the run: what the bank booked while it waited for an approval is not passed over
            if (fetchesBookings) db().prepare("UPDATE accounts SET transactions_fetched_at = ? WHERE id = ?").run(run.api.startedAt, t.id);
            run.api.newTransactions += result.newTransactions;
            this.emit(run);
        }
        // Orders: the bank's list replaces ours. Along with the bookings only where the bank
        // wants no approval for it, and a failure here does not fail the run.
        const failures: string[] = [];
        for (const t of targets) {
            const lists = [
                { on: !!t.caps.standingOrders && (run.api.ordersOnly || !t.caps.standingOrdersTan), fetch: async () => replaceStandingOrders(db(), t.id, (await call<{ orders: ConnectorStandingOrder[] }>("standingOrders", { account: t.ref })).orders) },
                { on: !!t.caps.scheduledTransfers && (run.api.ordersOnly || !t.caps.scheduledTransfersTan), fetch: async () => replaceScheduledTransfers(db(), t.id, (await call<{ orders: ConnectorScheduledTransfer[] }>("scheduledTransfers", { account: t.ref })).orders) },
            ].filter((l) => l.on);
            if (lists.length === 0) continue;
            try {
                for (const l of lists) await l.fetch();
                markOrdersFetched(db(), t.id);
            } catch (e) {
                if (e instanceof Cancelled || run.cancelled || run.api.ordersOnly) throw e;
                failures.push(errorOf(e).message);
            }
            this.emit(run);
        }
        if (failures.length) run.api.ordersMessage = `Die Aufträge konnten nicht abgerufen werden: ${failures[0]}`;
        const d = db();
        // A run for the orders alone fetched no bookings: the time of the last fetch stays
        if (run.api.ordersOnly) d.prepare("UPDATE bank_logins SET status = 'ready', last_error = NULL WHERE id = ?").run(run.loginId);
        else d.prepare("UPDATE bank_logins SET last_sync_at = ?, status = 'ready', last_error = NULL WHERE id = ?").run(new Date().toISOString(), run.loginId);
    }

    /** Waits for an approval: queries a decoupled one, or waits for the user's TAN. */
    private async approval(run: Run, client: ConnectorClient, out: Extract<Outcome, { status: "approval" }>): Promise<Outcome> {
        run.operationId = out.operationId;
        Object.assign(run.api, { status: "approval", challenge: out.challenge });
        this.emit(run);
        let next: Outcome;
        if (out.challenge.decoupled) {
            await sleep(this.pollMs);
            if (run.cancelled) throw new Cancelled();
            next = (await client.call("operation", { id: out.operationId })) as Outcome;
        } else {
            next = await new Promise<Outcome>((resolve, reject) => (run.tanWaiter = { operationId: out.operationId, resolve, reject }));
        }
        if (next.status === "done") {
            run.operationId = null;
            Object.assign(run.api, { status: "running", challenge: null });
            this.emit(run);
        }
        return next;
    }

    private prune(): void {
        const limit = Date.now() - KEEP_FINISHED_MS;
        for (const [id, r] of this.runs) if (r.api.finishedAt && Date.parse(r.api.finishedAt) < limit) this.runs.delete(id);
    }
}

function errorOf(e: unknown): { code: string; message: string } {
    if (e instanceof HttpError) return { code: e.code, message: e.message };
    if (e instanceof ConnectorCallError) {
        const bankText = e.bankCodes.length ? ` (${e.bankCodes.map((c) => `${c.code} ${c.text}`).join("; ")})` : "";
        if (e.code === "pin_wrong") return { code: "pin_wrong", message: `Die Bank hat die PIN abgelehnt oder den Zugang gesperrt${bankText}.` };
        if (e.code === "operation_unknown") return { code: "expired", message: "Die Freigabe ist abgelaufen." };
        return { code: e.code, message: e.message };
    }
    return { code: "internal", message: "Der Abruf ist fehlgeschlagen." };
}
