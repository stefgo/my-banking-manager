// Routes for bank accesses: directory, connections, the own login, TAN method, taking over
// accounts, and bank operations waiting for an approval.

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { routes, type ConnectorAccount, type ConnectorChallenge, type Psd2Credentials } from "@mbm/shared";
import { ConnectorCallError } from "../connectors/client.js";
import type { Db } from "../db/database.js";
import { HttpError } from "../http/errors.js";
import { originAllowed } from "../http/origin.js";
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

/** An approval at the bank the user started; the redirect brings its state back. Memory only. */
interface PendingConsent {
    userId: number;
    loginId: number;
    connectionId: number;
    expires: number;
}

/** How long the user has for the approval at the bank. */
const CONSENT_MS = 15 * 60_000;
/** Path of the client page the bank sends the browser back to. */
const CALLBACK_PATH = "/bank-callback";
/** Always allowed as redirect: nothing listens there, the user pastes the address by hand. */
const LOCALHOST_CALLBACK = "https://localhost";

type ConnectorOutcome = { status: "done"; data: unknown; state: string } | { status: "approval"; operationId: string; challenge: ConnectorChallenge } | { status: "confirm"; operationId: string };

export function registerBankRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { events } = ctx;
    const pending = new Map<string, PendingOperation>();
    /** Last account list per login, for taking over accounts; memory only. */
    // The last account list per login, in memory only: taking over picks from it
    const offered = new Map<number, { accounts: ConnectorAccount[]; fetchedAt: string }>();
    /** TAN methods per login from the last login set-up, for their names. */
    const methodNames = new Map<number, Map<string, string>>();
    const consents = new Map<string, PendingConsent>();

    /** Maps a connector error to an answer for the client; a wrong PIN (or key) and an ended approval mark the login. */
    const fromConnector = (db: Db, loginId: number | null, e: unknown, psd2 = false): never => {
        if (!(e instanceof ConnectorCallError)) throw e;
        const bankText = e.bankCodes.length ? ` (${e.bankCodes.map((c) => `${c.code} ${c.text}`).join("; ")})` : "";
        switch (e.code) {
            case "pin_wrong":
                if (psd2) {
                    if (loginId) bank.setLoginStatus(db, loginId, "pin_wrong", "Application-ID oder Schlüssel abgelehnt");
                    events.changed("connections");
                    throw new HttpError(422, "pin_wrong", `${e.message} Bitte Application-ID und Schlüssel prüfen.`);
                }
                if (loginId) bank.setLoginStatus(db, loginId, "pin_wrong", "PIN abgelehnt");
                events.changed("connections");
                throw new HttpError(422, "pin_wrong", `Die Bank hat die PIN abgelehnt oder den Zugang gesperrt${bankText}. Bitte die PIN prüfen, bevor du es noch einmal versuchst.`);
            case "consent_expired":
                if (loginId) bank.setLoginStatus(db, loginId, "consent_needed", e.message.slice(0, 300));
                events.changed("connections");
                throw new HttpError(409, "consent_needed", e.message);
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

    /** FinTS-only steps refuse a PSD2 access. */
    const requireFints = (conn: { connector: string }) => {
        if (bank.isPsd2(conn)) throw new HttpError(409, "not_fints", "Dieser Bankzugang läuft über PSD2 (Enable Banking), nicht über FinTS.");
    };
    const requirePsd2 = (conn: { connector: string }) => {
        if (!bank.isPsd2(conn)) throw new HttpError(409, "not_psd2", "Dieser Bankzugang läuft über FinTS, nicht über PSD2.");
    };
    const psd2 = () => ctx.connectors.get(bank.PSD2_CONNECTOR);

    /** Typed-in credentials, or those of the own login at another PSD2 access. */
    const psd2Credentials = (db: Db, userId: number, key: () => Buffer, body: { credentials?: Psd2Credentials; fromConnection?: number }): Psd2Credentials => {
        if (body.credentials) return body.credentials;
        const conn = bank.requireConnection(db, body.fromConnection!);
        requirePsd2(conn);
        return bank.readPsd2Credentials(bank.requireLogin(db, conn.id, userId), key());
    };

    /** Ends the session of a PSD2 login at Enable Banking; never fails the step it belongs to. */
    const closePsd2Session = async (row: bank.LoginRow, key: Buffer) => {
        if (!row.sealed_connector_state) return;
        try {
            await psd2().call("psd2CloseSession", { body: { login: bank.psd2Login(row, key) } });
        } catch {
            // Enable Banking ends it on its own when the approval runs out
        }
    };

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

    handle(app, ctx, routes.deleteConnection, async ({ db, session, actor, params, query, userKey }) => {
        const conn = bank.requireConnection(db, params.id);
        const name = conn.name;
        // As with detaching: a run holds the accounts it fetches, a transfer the account it pays from
        if (ctx.sync.active()) throw new HttpError(409, "sync_running", "Während eines Abrufs geht das nicht. Bitte warte, bis er fertig ist.");
        if (ctx.transfers.activeFor({ connectionId: params.id })) throw new HttpError(409, "transfer_running", "Während eine Überweisung läuft, geht das nicht. Bitte warte, bis sie fertig ist.");
        // Only the own login can be opened; the approvals of other users run out on their own
        const own = bank.isPsd2(conn) ? bank.findLogin(db, conn.id, session.userId) : undefined;
        if (own) await closePsd2Session(own, userKey());
        bank.deleteConnection(db, params.id, query.accounts);
        logActivity(db, actor, "bank_connection_deleted", name, query.accounts === "keep" ? "Konten als Offline-Konten behalten" : "Konten gelöscht");
        events.changed("connections", "accounts", "transactions", "rules", "activity");
        return { ok: true as const };
    });

    // ---------- The own login ----------

    handle(app, ctx, routes.setLogin, async ({ db, session, actor, params, body, userKey }) => {
        const key = userKey();
        const conn = bank.requireConnection(db, params.id);
        requireFints(conn);
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
        requireFints(bank.requireConnection(db, params.id));
        const row = bank.requireLogin(db, params.id, session.userId);
        const creds = bank.readCredentials(row, key);
        const savePin = body.savePin ?? row.save_pin === 1;
        bank.writeCredentials(db, row, key, { ...creds, pin: savePin ? body.pin : null });
        db.prepare("UPDATE bank_logins SET save_pin = ? WHERE id = ?").run(savePin ? 1 : 0, row.id);
        if (row.status === "pin_wrong") bank.setLoginStatus(db, row.id, row.tan_method ? "ready" : "setup");
        events.changed("connections");
        return bank.loginToApi(db, row.id);
    });

    handle(app, ctx, routes.deleteLogin, async ({ db, session, actor, params, userKey }) => {
        const row = bank.requireLogin(db, params.id, session.userId);
        if (bank.isPsd2(bank.requireConnection(db, params.id))) await closePsd2Session(row, userKey());
        db.prepare("DELETE FROM bank_logins WHERE id = ?").run(row.id);
        offered.delete(row.id);
        logActivity(db, actor, "bank_login_deleted", bank.requireConnection(db, params.id).name);
        events.changed("connections", "activity");
        return { ok: true as const };
    });

    handle(app, ctx, routes.chooseTanMethod, ({ db, session, params, body }) => {
        requireFints(bank.requireConnection(db, params.id));
        const row = bank.requireLogin(db, params.id, session.userId);
        const name = methodNames.get(row.id)?.get(body.tanMethod) ?? row.tan_method_name ?? body.tanMethod;
        db.prepare("UPDATE bank_logins SET tan_method = ?, tan_method_name = ?, tan_medium = ? WHERE id = ?").run(body.tanMethod, name, body.tanMedium ?? null, row.id);
        events.changed("connections");
        return bank.loginToApi(db, row.id);
    });

    handle(app, ctx, routes.tanMedia, async ({ db, session, params, body, userKey }) => {
        const key = userKey();
        const conn = bank.requireConnection(db, params.id);
        requireFints(conn);
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
            const out = bank.isPsd2(conn)
                ? await psd2().call("psd2Accounts", { body: { bank: bank.psd2Bank(conn), login: bank.psd2Login(row, key) } })
                : await ctx.connectors.get(conn.connector).call("accounts", { body: { bank: { blz: conn.blz, url: conn.fints_url }, login: bank.connectorLogin(row, key, body.pin) } });
            return settle(db, key, session.userId, row.id, conn.connector, out, finish);
        } catch (e) {
            return fromConnector(db, row.id, e, bank.isPsd2(conn));
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
        events.changed("accounts", "connections", "transactions", "categories", "rules", "activity");
        return { ok: true as const };
    });

    // ---------- PSD2 through Enable Banking ----------

    handle(app, ctx, routes.psd2Banks, async ({ db, session, body, userKey }) => {
        try {
            return await psd2().call("psd2Banks", { body: { credentials: psd2Credentials(db, session.userId, userKey, body), country: body.country } });
        } catch (e) {
            return fromConnector(db, null, e, true);
        }
    });

    handle(app, ctx, routes.createPsd2Connection, ({ db, session, actor, body }) => {
        // Only with the connector at hand: otherwise the access could never fetch
        try {
            psd2();
        } catch (e) {
            fromConnector(db, null, e, true);
        }
        const { id, created } = bank.createPsd2Connection(db, body);
        if (created) logActivity(db, actor, "bank_connection_created", body.aspsp, "PSD2 über Enable Banking");
        events.changed("connections", "activity");
        return bank.getConnection(db, id, session.userId);
    });

    handle(app, ctx, routes.setPsd2Login, async ({ db, session, actor, params, body, userKey }) => {
        const key = userKey();
        const conn = bank.requireConnection(db, params.id);
        requirePsd2(conn);
        const creds = psd2Credentials(db, session.userId, () => key, body);
        // Checks application and key, and that Enable Banking offers this bank
        let banks: { name: string }[];
        try {
            banks = (await psd2().call("psd2Banks", { body: { credentials: creds, country: conn.country } })).banks;
        } catch (e) {
            return fromConnector(db, null, e, true);
        }
        if (!banks.some((b) => b.name === conn.aspsp)) throw new HttpError(422, "not_supported", `Enable Banking bietet „${conn.aspsp}“ (${conn.country}) nicht mehr an.`);
        // A new application ends the approval of the old one
        const previous = bank.findLogin(db, conn.id, session.userId);
        if (previous) await closePsd2Session(previous, key);
        const row = bank.setPsd2Login(db, conn.id, session.userId, key, creds);
        offered.delete(row.id);
        logActivity(db, actor, "bank_login_set", conn.name);
        events.changed("connections", "activity");
        return bank.loginToApi(db, row.id);
    });

    handle(app, ctx, routes.startConsent, async ({ db, session, params, body, userKey, request }) => {
        const conn = bank.requireConnection(db, params.id);
        requirePsd2(conn);
        const row = bank.requireLogin(db, conn.id, session.userId);
        // Back only to MBM itself, or to localhost for the address pasted by hand
        const target = new URL(body.redirectUrl);
        if (target.pathname !== CALLBACK_PATH || target.search || target.hash || (target.origin !== LOCALHOST_CALLBACK && !originAllowed(target.origin, request.host, ctx.config.allowedOrigins))) {
            throw new HttpError(422, "redirect_not_allowed", `Die Rückleitung muss auf ${CALLBACK_PATH} dieser MBM-Adresse oder von ${LOCALHOST_CALLBACK} zeigen.`);
        }
        const now = Date.now();
        for (const [k, c] of consents) if (c.expires < now || (c.userId === session.userId && c.loginId === row.id)) consents.delete(k);
        const state = randomBytes(24).toString("base64url");
        let url: string;
        try {
            url = (await psd2().call("psd2Consent", { body: { bank: bank.psd2Bank(conn), login: bank.readPsd2Credentials(row, userKey()), redirectUrl: target.href, state } })).url;
        } catch (e) {
            return fromConnector(db, row.id, e, true);
        }
        consents.set(state, { userId: session.userId, loginId: row.id, connectionId: conn.id, expires: now + CONSENT_MS });
        return { url };
    });

    handle(app, ctx, routes.completeConsent, async ({ db, session, actor, body, userKey }) => {
        const pendingConsent = consents.get(body.state);
        // Once only, and only by the user who started it
        if (!pendingConsent || pendingConsent.expires < Date.now() || pendingConsent.userId !== session.userId) {
            throw new HttpError(404, "consent_unknown", "Diese Freigabe ist unbekannt oder abgelaufen. Bitte noch einmal freigeben.");
        }
        consents.delete(body.state);
        const key = userKey();
        const conn = bank.requireConnection(db, pendingConsent.connectionId);
        const row = bank.loginById(db, pendingConsent.loginId);
        if (!row || row.user_id !== session.userId) throw new HttpError(404, "consent_unknown", "Diese Freigabe ist unbekannt oder abgelaufen. Bitte noch einmal freigeben.");
        let out: { state: string; validUntil: string; accounts: ConnectorAccount[] };
        try {
            // With the approvals so far: the new one joins them (several PayPal accounts at one access)
            out = await psd2().call("psd2Session", { body: { bank: bank.psd2Bank(conn), login: bank.psd2Login(row, key), code: body.code } });
        } catch (e) {
            return fromConnector(db, row.id, e, true);
        }
        bank.setConsent(db, row.id, key, out);
        const until = out.accounts.map((a) => a.consentUntil).find(Boolean) ?? out.validUntil;
        logActivity(db, actor, "bank_consent_given", conn.name, `gültig bis ${until.slice(0, 10)}`);
        events.changed("connections", "accounts", "activity");
        return { ...bank.getConnection(db, conn.id, session.userId), newAccounts: bank.newAccountCount(db, row.id, out.accounts) };
    });

    // ---------- Fetching ----------

    /** The browser of the user who starts a fetch: PSD2 banks then count it as attended. */
    const psuOf = (request: { ip: string; headers: Record<string, string | string[] | undefined> }) => {
        const ua = request.headers["user-agent"];
        return { ipAddress: request.ip.slice(0, 45), userAgent: ((Array.isArray(ua) ? ua[0] : ua) ?? "").slice(0, 500) };
    };

    handle(app, ctx, routes.startSync, ({ db, session, body, userKey, request }) => {
        const key = userKey();
        try {
            return ctx.sync.start(db, { id: session.userId, name: session.userName }, key, { ...body, psu: psuOf(request) });
        } finally {
            key.fill(0);
        }
    });

    handle(app, ctx, routes.fetchOrders, ({ db, session, body, userKey, request }) => {
        const key = userKey();
        try {
            return ctx.sync.start(db, { id: session.userId, name: session.userName }, key, { ...body, ordersOnly: true, psu: psuOf(request) });
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
