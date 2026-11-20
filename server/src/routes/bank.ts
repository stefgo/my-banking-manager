// Routes for bank accesses: directory, connections, the own login, TAN method, taking over
// accounts, and bank operations waiting for an approval.

import type { FastifyInstance } from "fastify";
import { routes, type ConnectorAccount, type ConnectorChallenge } from "@mbm/shared";
import { ConnectorCallError } from "../connectors/client.js";
import type { Db } from "../db/database.js";
import { HttpError } from "../http/errors.js";
import { handle, type AppContext } from "../http/route.js";
import * as bank from "../services/bankaccess.js";
import * as orders from "../services/orders.js";
import { logActivity } from "../services/users.js";

/** An operation the connector paused for an approval; only its user may follow it. */
interface PendingOperation {
    userId: number;
    loginId: number;
    connector: string;
    /** Turns the connector's result into the answer for the client. */
    finish: (db: Db, data: unknown) => unknown;
}

type ConnectorOutcome = { status: "done"; data: unknown; state: string } | { status: "approval"; operationId: string; challenge: ConnectorChallenge } | { status: "confirm"; operationId: string };

export function registerBankRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { events } = ctx;
    const pending = new Map<string, PendingOperation>();
    /** Last account list per login, for taking over accounts; memory only. */
    // The last account list per login, in memory only: taking over picks from it
    const offered = new Map<number, { accounts: ConnectorAccount[]; fetchedAt: string }>();
    /** TAN methods per login from the last login set-up, for their names. */
    const methodNames = new Map<number, Map<string, string>>();

    /** Maps a connector error to an answer for the client; a wrong PIN marks the login. */
    const fromConnector = (db: Db, loginId: number | null, e: unknown): never => {
        if (!(e instanceof ConnectorCallError)) throw e;
        const bankText = e.bankCodes.length ? ` (${e.bankCodes.map((c) => `${c.code} ${c.text}`).join("; ")})` : "";
        switch (e.code) {
            case "pin_wrong":
                if (loginId) bank.setLoginStatus(db, loginId, "pin_wrong", "PIN abgelehnt");
                events.changed("connections");
                throw new HttpError(422, "pin_wrong", `Die Bank hat die PIN abgelehnt oder den Zugang gesperrt${bankText}. Bitte die PIN prüfen, bevor du es noch einmal versuchst.`);
            case "connector_unavailable":
            case "product_id_missing":
                throw new HttpError(503, e.code, e.message);
            case "timeout":
                throw new HttpError(504, "bank_timeout", e.message);
            case "unreachable":
            case "bank_answer_invalid":
                throw new HttpError(502, "bank_unreachable", e.message);
            case "operation_unknown":
                throw new HttpError(404, "operation_unknown", "Der Vorgang ist abgelaufen. Bitte noch einmal starten.");
            case "no_tan_method":
                throw new HttpError(409, "no_tan_method", e.message);
            case "not_supported":
                throw new HttpError(422, "not_supported", e.message);
            case "bank_error":
                if (loginId) bank.setLoginStatus(db, loginId, "error", e.message.slice(0, 300));
                throw new HttpError(502, "bank_error", `Die Bank hat abgelehnt: ${e.message}`);
            default:
                throw new HttpError(502, "connector_error", e.message);
        }
    };

    /** Stores the state of a finished call, or registers the paused operation. */
    const settle = <T>(db: Db, userKey: Buffer, userId: number, loginId: number, connector: string, out: ConnectorOutcome, finish: (db: Db, data: unknown) => T) => {
        if (out.status === "approval") {
            pending.set(out.operationId, { userId, loginId, connector, finish });
            return { status: "approval" as const, operationId: out.operationId, challenge: out.challenge };
        }
        if (out.status === "confirm") throw new HttpError(502, "connector_error", "Der Konnektor wartet unerwartet auf eine Bestätigung.");
        bank.saveConnectorState(db, loginId, userKey, out.state);
        return { status: "done" as const, data: finish(db, out.data) };
    };

    const toOffered = (db: Db, connectionId: number, loginId: number, { accounts, fetchedAt }: { accounts: ConnectorAccount[]; fetchedAt: string }) => ({
        fetchedAt,
        accounts: accounts.map((a) => {
            const accountId = bank.accountIdOf(db, connectionId, a.externalId);
            return {
                externalId: a.externalId,
                name: a.name,
                iban: a.iban,
                cardNumber: a.kind === "credit_card" ? a.accountNumber : null,
                owner: a.owner,
                currency: a.currency,
                kind: a.kind,
                supported: bank.isSupportedKind(a.kind),
                capabilities: a.capabilities,
                accountId,
                linked: accountId !== null && bank.isLinked(db, loginId, accountId),
                ignored: bank.isIgnored(db, connectionId, a.externalId),
            };
        }),
    });

    // ---------- Directory and connections ----------

    handle(app, ctx, routes.searchBanks, ({ query }) => ctx.bankDirectory.search(query.q));

    handle(app, ctx, routes.bankDirectory, () => ctx.bankDirectory.status());

    handle(app, ctx, routes.checkBankDirectory, async () => {
        if (!ctx.bankDirectory.status().autoUpdate) throw new HttpError(409, "disabled", "Der Abruf des BLZ-Verzeichnisses ist abgeschaltet (bankDirectoryUpdate).");
        await ctx.bankDirectory.check();
        events.changed("bankDirectory");
        return ctx.bankDirectory.status();
    });

    handle(app, ctx, routes.connectorStatus, async () => {
        await ctx.connectors.refresh();
        return ctx.connectors.status();
    });

    handle(app, ctx, routes.listConnections, ({ db, session }) => bank.listConnections(db, session.userId));

    handle(app, ctx, routes.createConnection, async ({ db, session, actor, body }) => {
        let checked: { bankName: string; pinTan: boolean };
        try {
            checked = await ctx.connectors.get("fints").call("checkBank", { body: { bank: { blz: body.blz, url: body.fintsUrl } } });
        } catch (e) {
            fromConnector(db, null, e);
            throw e;
        }
        if (!checked.pinTan) throw new HttpError(422, "not_supported", "Diese Bank bietet über FinTS kein PIN/TAN-Verfahren an.");
        const { id, created } = bank.createConnection(db, { ...body, bankName: checked.bankName }, ctx.bankDirectory.byBlz(body.blz));
        if (created) logActivity(db, actor, "bank_connection_created", checked.bankName);
        events.changed("connections", "activity");
        return bank.getConnection(db, id, session.userId);
    });

    handle(app, ctx, routes.deleteConnection, ({ db, actor, params, query }) => {
        const name = bank.requireConnection(db, params.id).name;
        // As with detaching: a run holds the accounts it fetches, a transfer the account it pays from
        if (ctx.sync.active()) throw new HttpError(409, "sync_running", "Während eines Abrufs geht das nicht. Bitte warte, bis er fertig ist.");
        if (ctx.transfers.activeFor({ connectionId: params.id })) throw new HttpError(409, "transfer_running", "Während eine Überweisung läuft, geht das nicht. Bitte warte, bis sie fertig ist.");
        bank.deleteConnection(db, params.id, query.accounts);
        logActivity(db, actor, "bank_connection_deleted", name, query.accounts === "keep" ? "Konten als Offline-Konten behalten" : "Konten gelöscht");
        events.changed("connections", "accounts", "transactions", "activity");
        return { ok: true as const };
    });

    // ---------- The own login ----------

    handle(app, ctx, routes.setLogin, async ({ db, session, actor, params, body, userKey }) => {
        const key = userKey();
        const conn = bank.requireConnection(db, params.id);
        // A PIN that should not be stored is used for this call only
        const row = bank.setLogin(db, conn.id, session.userId, key, { loginName: body.loginName, customerId: body.customerId, pin: body.savePin ? body.pin : null }, body.savePin);
        let out: ConnectorOutcome;
        try {
            out = await ctx.connectors.get(conn.connector).call("tanMethods", { body: { bank: { blz: conn.blz, url: conn.fints_url }, login: bank.connectorLogin(row, key, body.pin) } });
        } catch (e) {
            return fromConnector(db, row.id, e);
        }
        if (out.status !== "done") throw new HttpError(502, "connector_error", "Unerwartete Freigabe beim Abruf der TAN-Verfahren.");
        bank.saveConnectorState(db, row.id, key, out.state);
        const methods = (out.data as { methods: { id: string; name: string; decoupled: boolean; needsMedium: boolean }[] }).methods;
        methodNames.set(row.id, new Map(methods.map((m) => [m.id, m.name])));
        logActivity(db, actor, "bank_login_set", conn.name);
        events.changed("connections", "activity");
        return { login: bank.loginToApi(db, row.id), tanMethods: methods };
    });

    handle(app, ctx, routes.changePin, ({ db, session, params, body, userKey }) => {
        const key = userKey();
        const row = bank.requireLogin(db, params.id, session.userId);
        const creds = bank.readCredentials(row, key);
        const savePin = body.savePin ?? row.save_pin === 1;
        bank.writeCredentials(db, row, key, { ...creds, pin: savePin ? body.pin : null });
        db.prepare("UPDATE bank_logins SET save_pin = ? WHERE id = ?").run(savePin ? 1 : 0, row.id);
        if (row.status === "pin_wrong") bank.setLoginStatus(db, row.id, row.tan_method ? "ready" : "setup");
        events.changed("connections");
        return bank.loginToApi(db, row.id);
    });

    handle(app, ctx, routes.deleteLogin, ({ db, session, actor, params }) => {
        const row = bank.requireLogin(db, params.id, session.userId);
        db.prepare("DELETE FROM bank_logins WHERE id = ?").run(row.id);
        offered.delete(row.id);
        logActivity(db, actor, "bank_login_deleted", bank.requireConnection(db, params.id).name);
        events.changed("connections", "activity");
        return { ok: true as const };
    });

    handle(app, ctx, routes.chooseTanMethod, ({ db, session, params, body }) => {
        const row = bank.requireLogin(db, params.id, session.userId);
        const name = methodNames.get(row.id)?.get(body.tanMethod) ?? row.tan_method_name ?? body.tanMethod;
        db.prepare("UPDATE bank_logins SET tan_method = ?, tan_method_name = ?, tan_medium = ? WHERE id = ?").run(body.tanMethod, name, body.tanMedium ?? null, row.id);
        events.changed("connections");
        return bank.loginToApi(db, row.id);
    });

    handle(app, ctx, routes.tanMedia, async ({ db, session, params, body, userKey }) => {
        const key = userKey();
        const conn = bank.requireConnection(db, params.id);
        const row = bank.requireLogin(db, conn.id, session.userId);
        try {
            const out = await ctx.connectors.get(conn.connector).call("tanMedia", { body: { bank: { blz: conn.blz, url: conn.fints_url }, login: bank.connectorLogin(row, key, body.pin) } });
            return settle(db, key, session.userId, row.id, conn.connector, out, (_db, data) => data as { media: { name: string; active: boolean }[] });
        } catch (e) {
            return fromConnector(db, row.id, e);
        }
    });

    handle(app, ctx, routes.lastOfferedAccounts, ({ db, session, params }) => {
        const row = bank.findLogin(db, bank.requireConnection(db, params.id).id, session.userId);
        const list = row && offered.get(row.id);
        return list ? toOffered(db, params.id, row.id, list) : null;
    });

    handle(app, ctx, routes.offeredAccounts, async ({ db, session, params, body, userKey }) => {
        const key = userKey();
        const conn = bank.requireConnection(db, params.id);
        const row = bank.requireLogin(db, conn.id, session.userId);
        const finish = (d: Db, data: unknown) => {
            const list = { accounts: (data as { accounts: ConnectorAccount[] }).accounts, fetchedAt: new Date().toISOString() };
            offered.set(row.id, list);
            return toOffered(d, conn.id, row.id, list);
        };
        try {
            const out = await ctx.connectors.get(conn.connector).call("accounts", { body: { bank: { blz: conn.blz, url: conn.fints_url }, login: bank.connectorLogin(row, key, body.pin) } });
            return settle(db, key, session.userId, row.id, conn.connector, out, finish);
        } catch (e) {
            return fromConnector(db, row.id, e);
        }
    });

    handle(app, ctx, routes.importAccounts, ({ db, session, actor, params, body }) => {
        const conn = bank.requireConnection(db, params.id);
        const row = bank.requireLogin(db, conn.id, session.userId);
        const list = offered.get(row.id)?.accounts;
        if (!list) throw new HttpError(409, "accounts_not_fetched", "Bitte zuerst die Konten bei der Bank abrufen.");
        const created: number[] = [];
        const linked: number[] = [];
        db.transaction(() => {
            for (const choice of body.accounts) {
                const acc = list.find((a) => a.externalId === choice.externalId);
                if (!acc) throw new HttpError(404, "not_found", "Dieses Konto hat die Bank nicht gemeldet.");
                const r = bank.takeOverAccount(db, conn.id, row.id, acc, choice);
                (r.created ? created : linked).push(r.accountId);
            }
            for (const externalId of body.ignore) {
                if (!list.some((a) => a.externalId === externalId)) throw new HttpError(404, "not_found", "Dieses Konto hat die Bank nicht gemeldet.");
                // An account in MBM is detached on its own, with the choice what happens to it
                if (bank.accountIdOf(db, conn.id, externalId) === null) bank.ignoreAccount(db, conn.id, externalId);
            }
            bank.setLoginStatus(db, row.id, "ready");
        })();
        if (created.length) logActivity(db, actor, "accounts_taken_over", conn.name, `${created.length} Konto/Konten`);
        events.changed("accounts", "connections", "activity");
        return { created, linked };
    });

    handle(app, ctx, routes.detachAccount, ({ db, actor, params, body }) => {
        // A run holds the accounts it fetches; detaching one under it would write into an offline account
        if (ctx.sync.active()) throw new HttpError(409, "sync_running", "Während eines Abrufs geht das nicht. Bitte warte, bis er fertig ist.");
        if (ctx.transfers.active()) throw new HttpError(409, "transfer_running", "Während eine Überweisung läuft, geht das nicht. Bitte warte, bis sie fertig ist.");
        const r = db.transaction(() => bank.detachAccount(db, params.id, body.mode))();
        logActivity(db, actor, body.mode === "keep" ? "account_detached" : "account_deleted", r.name, body.mode === "keep" ? `von ${r.connectionName} gelöst, als Offline-Konto behalten` : `von ${r.connectionName} gelöst und gelöscht`);
        events.changed("accounts", "connections", "transactions", "categories", "activity");
        return { ok: true as const };
    });

    // ---------- Fetching ----------

    handle(app, ctx, routes.startSync, ({ db, session, body, userKey }) => {
        const key = userKey();
        try {
            return ctx.sync.start(db, { id: session.userId, name: session.userName }, key, body);
        } finally {
            key.fill(0);
        }
    });

    handle(app, ctx, routes.fetchOrders, ({ db, session, body, userKey }) => {
        const key = userKey();
        try {
            return ctx.sync.start(db, { id: session.userId, name: session.userName }, key, { ...body, ordersOnly: true });
        } finally {
            key.fill(0);
        }
    });

    handle(app, ctx, routes.listOrders, ({ db, session, query }) => orders.listOrders(db, session.userId, query.scope));
    handle(app, ctx, routes.upcomingOrders, ({ db, query }) => ({ items: orders.upcomingOrders(db, query.scope, query.days, query.count) }));

    handle(app, ctx, routes.listSync, ({ session }) => ctx.sync.list(session.userId));
    handle(app, ctx, routes.syncTan, ({ session, params, body }) => ctx.sync.tan(params.id, session.userId, body.tan));
    handle(app, ctx, routes.cancelSync, async ({ session, params }) => {
        await ctx.sync.cancel(params.id, session.userId);
        return { ok: true as const };
    });

    // ---------- Operations waiting for an approval ----------

    const operationOf = (id: string, userId: number): PendingOperation => {
        const op = pending.get(id);
        if (!op || op.userId !== userId) throw new HttpError(404, "operation_unknown", "Der Vorgang ist unbekannt oder abgelaufen.");
        return op;
    };

    const advance = async (db: Db, userKey: Buffer, id: string, op: PendingOperation, call: () => Promise<ConnectorOutcome>) => {
        let out: ConnectorOutcome;
        try {
            out = await call();
        } catch (e) {
            pending.delete(id);
            return fromConnector(db, op.loginId, e);
        }
        if (out.status === "approval") return { status: "approval" as const, operationId: id, challenge: out.challenge };
        pending.delete(id);
        if (out.status === "confirm") throw new HttpError(502, "connector_error", "Der Konnektor wartet unerwartet auf eine Bestätigung.");
        bank.saveConnectorState(db, op.loginId, userKey, out.state);
        return { status: "done" as const, data: op.finish(db, out.data) };
    };

    handle(app, ctx, routes.bankOperation, ({ db, session, params, userKey }) => {
        const op = operationOf(params.id, session.userId);
        return advance(db, userKey(), params.id, op, () => ctx.connectors.get(op.connector).call("operation", { id: params.id }));
    });

    handle(app, ctx, routes.bankOperationTan, ({ db, session, params, body, userKey }) => {
        const op = operationOf(params.id, session.userId);
        return advance(db, userKey(), params.id, op, () => ctx.connectors.get(op.connector).call("operationTan", { id: params.id, body: { tan: body.tan } }));
    });

    handle(app, ctx, routes.cancelBankOperation, async ({ session, params }) => {
        const op = operationOf(params.id, session.userId);
        pending.delete(params.id);
        try {
            await ctx.connectors.get(op.connector).call("cancelOperation", { id: params.id });
        } catch {
            // expired at the connector already: nothing to cancel
        }
        return { ok: true as const };
    });
}
