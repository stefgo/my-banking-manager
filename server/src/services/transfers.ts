// Transfers: submitted through the connector with the own bank login, in the background, only when
// a user starts them. The state lives in `transfers`; what exists only while a transfer runs (the
// user key, a PIN that is not stored, the challenge) lives here in memory.
//
//   submitting ─┬─ confirm ──▶ awaiting_vop_confirm ── user confirms ──┐
//               ├─ approval ─▶ awaiting_tan ◀────────────────────────────┘
//               └─ done ─────▶ executed
//   awaiting_tan ── approved ─▶ executed | rejected | unknown (answer lost)
//   any waiting state ── cancel ─▶ cancelled
//
// Only the run itself talks to the connector about its operation (also to cancel it), so two
// requests for the same operation never cross. A TAN on its way cannot be cancelled.
//
// Nothing is ever sent twice on its own: when it is unclear whether the bank executed a transfer,
// it ends as "unknown" and the user checks the bookings. A fetch that brings the booking (found by
// the end-to-end ID) turns "unknown" into "executed".

import { randomBytes } from "node:crypto";
import {
    formatCents,
    type ConnectorAccountCapabilities,
    type ConnectorAccountRef,
    type ConnectorChallenge,
    type ConnectorVop,
    type TransferPayee,
    type Transfer,
    type TransferData,
    type TransferStatus,
} from "@mbm/shared";
import type { z } from "zod";
import type { routes } from "@mbm/shared";
import { ConnectorCallError, type ConnectorClient } from "../connectors/client.js";
import type { Db } from "../db/database.js";
import { HttpError, notFound } from "../http/errors.js";
import type { AppContext } from "../http/route.js";
import * as bank from "./bankaccess.js";
import { logActivity, passwordEnteredAt, type Session } from "./users.js";

type Outcome =
    | { status: "done"; data: unknown; state: string }
    | { status: "approval"; operationId: string; challenge: ConnectorChallenge; vop?: ConnectorVop }
    | { status: "confirm"; operationId: string; vop: ConnectorVop };

type CreateRequest = z.output<(typeof routes)["createTransfer"]["body"]>;

interface Run {
    transferId: number;
    userId: number;
    userName: string;
    deviceId: number;
    accountId: number;
    loginId: number;
    connectionId: number;
    connector: string;
    key: Buffer;
    pin: string | undefined;
    status: TransferStatus;
    operationId: string | null;
    challenge: ConnectorChallenge | null;
    /** Set while the run waits for the user: a TAN, or the confirmation of a differing name. */
    waiter: { kind: "tan" | "confirm"; resolve: (o: Outcome | null) => void; reject: (e: unknown) => void; stop: () => void } | null;
    /** A TAN is on its way to the bank. */
    busy: boolean;
    cancelled: boolean;
    /** The bank asked for an approval (a push message may be on the user's phone). */
    approvalAsked: boolean;
    /** What was stored and reported last, so that repeated status queries stay quiet. */
    reported: string;
}

export interface TransferOptions {
    /** Between status queries of an approval in the app. */
    pollMs?: number;
    /** How long a run waits for the user. */
    waitMs?: number;
}

interface TransferRow {
    id: number;
    request_id: string;
    account_id: number;
    login_id: number | null;
    created_by: number | null;
    created_by_name: string;
    payee_name: string;
    payee_iban: string;
    payee_bic: string | null;
    amount: number;
    remittance: string;
    end_to_end_id: string;
    instant: number;
    status: TransferStatus;
    vop_result: ConnectorVop["result"] | null;
    vop_name: string | null;
    vop_reason: string | null;
    vop_text: string | null;
    vop_structured: number;
    bank_message: string | null;
    bank_reference: string | null;
    unconfirmed: number;
    transaction_id: number | null;
    created_at: string;
    finished_at: string | null;
}

class Cancelled extends Error {}
class Expired extends Error {}

const ACTIVE: TransferStatus[] = ["submitting", "awaiting_vop_confirm", "awaiting_tan"];
/** How long a run waits for the user; the connector drops the operation after five minutes. */
const WAIT_MS = 5 * 60_000 + 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/** "MBM-" and 31 letters and digits: 35 characters, the most an end-to-end ID may have. */
export function newEndToEndId(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return `MBM-${[...randomBytes(31)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

const toApi = (r: TransferRow, userId: number, challenge: ConnectorChallenge | null): Transfer => ({
    id: r.id,
    accountId: r.account_id,
    createdBy: r.created_by_name,
    mine: r.created_by === userId,
    payeeName: r.payee_name,
    payeeIban: r.payee_iban,
    payeeBic: r.payee_bic,
    amount: r.amount,
    remittance: r.remittance,
    endToEndId: r.end_to_end_id,
    instant: r.instant === 1,
    status: r.status,
    vop: r.vop_result ? { result: r.vop_result, payeeName: r.vop_name, reason: r.vop_reason, explanation: r.vop_text ?? "", structured: r.vop_structured === 1 } : null,
    challenge: r.status === "awaiting_tan" && r.created_by === userId ? challenge : null,
    bankMessage: r.bank_message,
    bankReference: r.bank_reference,
    unconfirmed: r.unconfirmed === 1,
    transactionId: r.transaction_id,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
});

const requireRow = (db: Db, id: number): TransferRow => {
    const row = db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as TransferRow | undefined;
    if (!row) throw notFound("Überweisung");
    return row;
};

export class TransferManager {
    private readonly runs = new Map<number, Run>();
    /** Requests being started, by request ID: a second one with the same ID waits for the first. */
    private readonly starting = new Map<string, { userId: number; accountId: number; done: Promise<unknown> }>();
    private readonly pollMs: number;
    private readonly waitMs: number;

    constructor(
        private readonly ctx: AppContext,
        opts: TransferOptions = {},
    ) {
        this.pollMs = opts.pollMs ?? 2000;
        this.waitMs = opts.waitMs ?? WAIT_MS;
    }

    /** True while a transfer of this user (or of anybody) waits or runs. */
    active(userId?: number): boolean {
        return [...this.runs.values()].some((r) => userId === undefined || r.userId === userId);
    }

    /** True while a transfer through this bank connection waits or runs. */
    activeFor(f: { connectionId: number }): boolean {
        return [...this.runs.values()].some((r) => r.connectionId === f.connectionId);
    }

    // ---------- Reading ----------

    view(db: Db, id: number, userId: number): Transfer {
        return toApi(requireRow(db, id), userId, this.runs.get(id)?.challenge ?? null);
    }

    list(db: Db, userId: number, q: { accountId?: number; limit: number }): Transfer[] {
        const rows = (
            q.accountId === undefined
                ? db.prepare("SELECT * FROM transfers ORDER BY created_at DESC, id DESC LIMIT ?").all(q.limit)
                : db.prepare("SELECT * FROM transfers WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(q.accountId, q.limit)
        ) as TransferRow[];
        return rows.map((r) => toApi(r, userId, this.runs.get(r.id)?.challenge ?? null));
    }

    /** Accounts the user reaches with an own login that allows transfers there. */
    accounts(db: Db, userId: number) {
        const rows = db
            .prepare(
                `SELECT a.id, a.name, a.iban, c.name AS connection_name, bla.allowed_operations, l.save_pin
                 FROM bank_login_accounts bla
                 JOIN bank_logins l ON l.id = bla.login_id
                 JOIN accounts a ON a.id = bla.account_id
                 JOIN bank_connections c ON c.id = a.connection_id
                 WHERE l.user_id = ? AND bla.missing_since IS NULL AND l.tan_method IS NOT NULL AND l.status != 'credentials_lost'
                 ORDER BY a.hidden, a.name COLLATE NOCASE, a.id`,
            )
            .all(userId) as { id: number; name: string; iban: string | null; connection_name: string; allowed_operations: string; save_pin: number }[];
        return rows
            .map((r) => ({ r, caps: JSON.parse(r.allowed_operations) as Partial<ConnectorAccountCapabilities> }))
            .filter(({ caps }) => caps.transfer || caps.instantTransfer)
            .map(({ r, caps }) => ({
                id: r.id,
                name: r.name,
                iban: r.iban,
                connectionName: r.connection_name,
                instant: caps.instantTransfer === true,
                payeeVerification: caps.payeeVerification === true,
                pinRequired: r.save_pin === 0,
            }));
    }

    // ---------- Starting ----------

    async start(db: Db, session: Session, userKey: Buffer, req: CreateRequest): Promise<Transfer> {
        // The same request twice at once (double click, retry): the second gets the first one's transfer
        for (let p = this.starting.get(req.requestId); p; p = this.starting.get(req.requestId)) await p.done.catch(() => undefined);
        // Nothing awaits between the check above and here, so no other start slips in between
        const done = this.begin(db, session, userKey, req);
        const entry = { userId: session.userId, accountId: req.accountId, done };
        this.starting.set(req.requestId, entry);
        try {
            return await done;
        } finally {
            if (this.starting.get(req.requestId) === entry) this.starting.delete(req.requestId);
        }
    }

    private async begin(db: Db, session: Session, userKey: Buffer, req: CreateRequest): Promise<Transfer> {
        const same = db.prepare("SELECT * FROM transfers WHERE request_id = ?").get(req.requestId) as TransferRow | undefined;
        if (same) {
            if (same.created_by !== session.userId) throw new HttpError(409, "request_id_taken", "Diese Anfrage gehört zu einer anderen Überweisung.");
            const differs =
                same.account_id !== req.accountId ||
                same.payee_name !== req.payeeName ||
                same.payee_iban !== req.payeeIban ||
                same.payee_bic !== req.payeeBic ||
                same.amount !== req.amount ||
                same.remittance !== req.remittance ||
                (same.instant === 1) !== req.instant;
            if (differs) throw new HttpError(409, "request_id_conflict", "Dieses Formular wurde schon einmal mit anderen Angaben an die Bank gesendet. Bitte zuerst im Verlauf nachsehen, bevor du erneut sendest.");
            return toApi(same, session.userId, this.runs.get(same.id)?.challenge ?? null);
        }
        this.requireRecentPassword(db, session);

        const target = db
            .prepare(
                `SELECT l.*, bla.account_ref, bla.allowed_operations, a.iban AS account_iban, a.name AS account_name
                 FROM bank_login_accounts bla JOIN bank_logins l ON l.id = bla.login_id JOIN accounts a ON a.id = bla.account_id
                 WHERE bla.account_id = ? AND l.user_id = ? AND bla.missing_since IS NULL`,
            )
            .get(req.accountId, session.userId) as (bank.LoginRow & { account_ref: string; allowed_operations: string; account_iban: string | null; account_name: string }) | undefined;
        if (!target) {
            const exists = db.prepare("SELECT connection_id FROM accounts WHERE id = ?").get(req.accountId) as { connection_id: number | null } | undefined;
            if (!exists) throw notFound("Konto");
            if (exists.connection_id === null) throw new HttpError(422, "not_bank_account", "Von Offline-Konten gibt es keine Überweisungen.");
            throw new HttpError(409, "no_own_login", "Für dieses Konto hast du keine eigene Bank-Anmeldung.");
        }
        const caps = JSON.parse(target.allowed_operations) as Partial<ConnectorAccountCapabilities>;
        if (req.instant ? !caps.instantTransfer : !caps.transfer) {
            throw new HttpError(422, "not_allowed", req.instant ? "Die Bank erlaubt von diesem Konto keine Echtzeitüberweisung." : "Die Bank erlaubt von diesem Konto keine Überweisung.");
        }
        if (target.account_iban && target.account_iban === req.payeeIban) throw new HttpError(422, "same_account", "Empfänger und Auftraggeber sind dasselbe Konto.");
        if (target.tan_method === null) throw new HttpError(409, "no_tan_method", "Bitte zuerst ein TAN-Verfahren wählen.");
        const running = (r: { userId: number; accountId: number }) => r.userId === session.userId && r.accountId === req.accountId;
        if ([...this.runs.values()].some(running) || [...this.starting.values()].some(running)) {
            throw new HttpError(409, "transfer_running", "Von diesem Konto läuft schon eine Überweisung. Bitte erst abschließen oder abbrechen.");
        }
        // Checks credentials and PIN now, before anything is stored
        bank.connectorLogin(target, userKey, req.pin);
        const conn = bank.requireConnection(db, target.connection_id);
        const client = this.ctx.connectors.get(conn.connector);
        // An unreachable connector now means: nothing was sent. Later it would leave the outcome open.
        try {
            await client.call("info");
        } catch (e) {
            throw new HttpError(503, "connector_unavailable", e instanceof Error ? e.message : "Der Konnektor ist nicht erreichbar.");
        }

        const now = nowIso();
        const id = Number(
            db
                .prepare(
                    `INSERT INTO transfers (request_id, account_id, login_id, created_by, created_by_name, payee_name, payee_iban, payee_bic, amount, remittance, end_to_end_id, instant, status, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?)`,
                )
                .run(req.requestId, req.accountId, target.id, session.userId, session.userName, req.payeeName, req.payeeIban, req.payeeBic, req.amount, req.remittance, newEndToEndId(), req.instant ? 1 : 0, now, now).lastInsertRowid,
        );
        logActivity(db, { userId: session.userId, userName: session.userName, deviceId: session.deviceId }, "transfer_submitted", target.account_name, `${req.instant ? "Echtzeitüberweisung" : "Überweisung"} an ${req.payeeName}, ${formatCents(req.amount)}`);

        const run: Run = {
            transferId: id,
            userId: session.userId,
            userName: session.userName,
            deviceId: session.deviceId,
            accountId: req.accountId,
            loginId: target.id,
            connectionId: conn.id,
            connector: conn.connector,
            key: Buffer.from(userKey),
            pin: req.pin,
            status: "submitting",
            operationId: null,
            challenge: null,
            waiter: null,
            busy: false,
            cancelled: false,
            approvalAsked: false,
            reported: "",
        };
        this.runs.set(id, run);
        void this.execute(run, JSON.parse(target.account_ref) as ConnectorAccountRef);
        this.ctx.events.changed("transfers", "activity");
        return this.view(db, id, session.userId);
    }

    private requireRecentPassword(db: Db, session: Session): void {
        const minutes = this.ctx.config.transferConfirmMinutes;
        if (minutes === 0) return;
        const at = passwordEnteredAt(db, session.deviceId);
        if (!at || Date.now() - Date.parse(at) > minutes * 60_000) {
            throw new HttpError(403, "confirm_required", "Bitte vor der Überweisung das Passwort noch einmal eingeben.");
        }
    }

    // ---------- What the user does while it waits ----------

    private own(id: number, userId: number): Run {
        const run = this.runs.get(id);
        if (!run || run.userId !== userId) {
            const row = requireRow(this.ctx.vault.database, id);
            if (row.created_by !== userId) throw new HttpError(403, "not_yours", "Diese Überweisung hat ein anderer Benutzer gestartet.");
            throw new HttpError(409, "transfer_finished", "Diese Überweisung wartet auf nichts mehr.");
        }
        return run;
    }

    async confirm(id: number, userId: number): Promise<Transfer> {
        const run = this.own(id, userId);
        const w = run.waiter;
        if (!w || w.kind !== "confirm") throw new HttpError(409, "nothing_to_confirm", "Diese Überweisung wartet auf keine Bestätigung.");
        run.waiter = null;
        w.resolve(null);
        await sleep(0);
        return this.view(this.ctx.vault.database, id, userId);
    }

    async tan(id: number, userId: number, tan: string): Promise<Transfer> {
        const run = this.own(id, userId);
        const w = run.waiter;
        if (!w || w.kind !== "tan" || !run.operationId) throw new HttpError(409, "no_tan_needed", "Diese Überweisung wartet auf keine TAN.");
        run.waiter = null;
        // The time limit is for the user; the bank's answer to the TAN may take longer
        w.stop();
        run.busy = true;
        try {
            w.resolve((await this.client(run).call("operationTan", { id: run.operationId, body: { tan } })) as Outcome);
        } catch (e) {
            w.reject(e);
        } finally {
            run.busy = false;
        }
        await sleep(10);
        return this.view(this.ctx.vault.database, id, userId);
    }

    /** Asks the run to stop; the run ends the operation at the connector itself (see execute). */
    async cancel(id: number, userId: number): Promise<Transfer> {
        const run = this.own(id, userId);
        if (run.busy) throw new HttpError(409, "tan_in_flight", "Die TAN ist schon unterwegs zur Bank. Bitte einen Moment warten.");
        run.cancelled = true;
        const w = run.waiter;
        run.waiter = null;
        w?.reject(new Cancelled());
        await sleep(10);
        return this.view(this.ctx.vault.database, id, userId);
    }

    // ---------- Inside a run ----------

    private client(run: Run): ConnectorClient {
        return this.ctx.connectors.get(run.connector);
    }

    /** Waits for the user; gives up after the connector's time limit. */
    private waitFor(run: Run, kind: "tan" | "confirm"): Promise<Outcome | null> {
        return new Promise<Outcome | null>((resolve, reject) => {
            const timer = setTimeout(() => {
                run.waiter = null;
                reject(new Expired());
            }, this.waitMs);
            const stop = () => clearTimeout(timer);
            const done = <T>(f: (v: T) => void) => (v: T) => {
                stop();
                f(v);
            };
            run.waiter = { kind, resolve: done(resolve), reject: done(reject), stop };
        });
    }

    /** Stores and reports a new state; a status query that changed nothing stays quiet. */
    private update(run: Run, status: TransferStatus, vop?: ConnectorVop): void {
        run.status = status;
        const reported = JSON.stringify([status, vop ?? null, run.challenge]);
        if (reported === run.reported) return;
        run.reported = reported;
        try {
            const db = this.ctx.vault.database;
            db.prepare("UPDATE transfers SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), run.transferId);
            if (vop) {
                db.prepare("UPDATE transfers SET vop_result = ?, vop_name = ?, vop_reason = ?, vop_text = ?, vop_structured = ? WHERE id = ?").run(vop.result, vop.payeeName, vop.reason, vop.explanation || null, vop.structured ? 1 : 0, run.transferId);
            }
        } catch {
            // the database was locked meanwhile; the run goes on and reports at the end
        }
        this.ctx.events.changed("transfers");
    }

    private async execute(run: Run, account: ConnectorAccountRef): Promise<void> {
        let final: { status: TransferStatus; message: string; data?: TransferData };
        try {
            const data = await this.submit(run, account);
            final = { status: "executed", message: data.bankMessage, data };
        } catch (e) {
            // Cancelled or ran out while waiting for the user: end the operation (and its dialog) at the connector
            if ((e instanceof Cancelled || e instanceof Expired) && run.operationId) {
                await this.client(run).call("cancelOperation", { id: run.operationId }).catch(() => undefined);
            }
            final = this.failure(run, e);
        }
        run.key.fill(0);
        run.pin = undefined;
        run.waiter = null;
        run.challenge = null;
        this.runs.delete(run.transferId);
        try {
            this.finish(run, final);
        } catch {
            // the database was locked meanwhile: the next opening ends the transfer as unknown
        }
        this.ctx.events.changed("transfers", "payees", "activity");
    }

    private async submit(run: Run, account: ConnectorAccountRef): Promise<TransferData> {
        const db = () => this.ctx.vault.database;
        const client = this.client(run);
        const conn = bank.requireConnection(db(), run.connectionId);
        const row = requireRow(db(), run.transferId);
        const login = bank.connectorLogin(bank.loginById(db(), run.loginId), run.key, run.pin);
        let out = (await client.call("transfer", {
            body: {
                bank: { blz: conn.blz, url: conn.fints_url },
                login,
                account,
                transfer: { payeeName: row.payee_name, payeeIban: row.payee_iban, payeeBic: row.payee_bic, amount: row.amount, remittance: row.remittance, endToEndId: row.end_to_end_id, instant: row.instant === 1 },
            },
        })) as Outcome;
        for (;;) {
            // A finished payment counts even if the user cancelled meanwhile
            if (out.status === "done") break;
            run.operationId = out.operationId;
            if (out.status === "approval") run.approvalAsked = true;
            if (run.cancelled) throw new Cancelled();
            if (out.status === "confirm") {
                run.challenge = null;
                this.update(run, "awaiting_vop_confirm", out.vop);
                await this.waitFor(run, "confirm");
                if (run.cancelled) throw new Cancelled();
                out = (await client.call("confirmOperation", { id: out.operationId })) as Outcome;
                continue;
            }
            run.challenge = out.challenge;
            this.update(run, "awaiting_tan", out.vop);
            if (out.challenge.decoupled) {
                await sleep(this.pollMs);
                if (run.cancelled) throw new Cancelled();
                out = (await client.call("operation", { id: out.operationId })) as Outcome;
            } else {
                out = (await this.waitFor(run, "tan"))!;
            }
        }
        run.operationId = null;
        bank.saveConnectorState(db(), run.loginId, run.key, out.state);
        return out.data as TransferData;
    }

    /** What an error means for the transfer. In doubt: unknown. */
    private failure(run: Run, e: unknown): { status: TransferStatus; message: string } {
        if (e instanceof Cancelled) {
            return { status: "cancelled", message: run.approvalAsked ? "Abgebrochen. Bitte die Anfrage in der App jetzt nicht mehr freigeben." : "Abgebrochen." };
        }
        if (e instanceof Expired) {
            return run.status === "awaiting_tan"
                ? { status: "cancelled", message: "Abgebrochen: Es kam keine TAN." }
                : { status: "cancelled", message: "Abgebrochen: Die Bestätigung kam nicht rechtzeitig." };
        }
        const unknown = "Die Antwort der Bank ist nicht angekommen. Ob die Überweisung ausgeführt wurde, ist unbekannt. Bitte nach dem nächsten Abruf in den Umsätzen prüfen, bevor du neu überweist.";
        if (e instanceof HttpError) return { status: run.status === "submitting" && !run.operationId ? "failed" : "unknown", message: e.message };
        if (!(e instanceof ConnectorCallError)) return { status: "unknown", message: unknown };
        const bankText = e.bankCodes.length ? e.bankCodes.map((c) => `${c.code} ${c.text}`).join("; ") : e.message;
        switch (e.code) {
            case "outcome_unknown":
                return { status: "unknown", message: unknown };
            case "operation_unknown":
                return run.status === "awaiting_vop_confirm"
                    ? { status: "cancelled", message: "Abgebrochen: Die Bestätigung ist abgelaufen." }
                    : { status: "unknown", message: `Die Freigabe ist abgelaufen oder der Konnektor wurde neu gestartet. ${unknown}` };
            case "bank_error":
                return { status: "rejected", message: `Die Bank hat abgelehnt: ${bankText}` };
            case "pin_wrong":
                try {
                    bank.setLoginStatus(this.ctx.vault.database, run.loginId, "pin_wrong", "PIN abgelehnt");
                    this.ctx.events.changed("connections");
                } catch {
                    // locked meanwhile
                }
                return { status: "rejected", message: `Die Bank hat die PIN abgelehnt oder den Zugang gesperrt (${bankText}).` };
            case "unreachable":
            case "timeout":
            case "not_supported":
            case "no_tan_method":
            case "product_id_missing":
            case "invalid":
                // Before the payment was on its way: the connector reports lost answers after that as outcome_unknown
                return { status: "failed", message: e.message };
            default:
                return { status: "unknown", message: unknown };
        }
    }

    private finish(run: Run, f: { status: TransferStatus; message: string; data?: TransferData }): void {
        const db = this.ctx.vault.database;
        const d = f.data;
        db.prepare("UPDATE transfers SET status = ?, bank_message = ?, bank_reference = ?, unconfirmed = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(
            f.status, f.message, d?.reference ?? null, d?.unconfirmed ? 1 : 0, nowIso(), nowIso(), run.transferId,
        );
        if (d) db.prepare("UPDATE transfers SET vop_result = ?, vop_name = ?, vop_reason = ?, vop_text = COALESCE(NULLIF(?, ''), vop_text), vop_structured = ? WHERE id = ?").run(d.vop.result, d.vop.payeeName, d.vop.reason, d.vop.explanation, d.vop.structured ? 1 : 0, run.transferId);
        const row = requireRow(db, run.transferId);
        if (f.status === "executed") upsertPayee(db, row.payee_name, row.payee_iban, row.payee_bic);
        const account = (db.prepare("SELECT name FROM accounts WHERE id = ?").get(row.account_id) as { name: string } | undefined)?.name ?? null;
        const action = { executed: "transfer_executed", rejected: "transfer_rejected", failed: "transfer_failed", cancelled: "transfer_cancelled", unknown: "transfer_unknown" }[f.status as "executed"] ?? "transfer_failed";
        logActivity(db, { userId: run.userId, userName: run.userName, deviceId: run.deviceId }, action, account, `an ${row.payee_name}, ${formatCents(row.amount)}`);
    }

    /** At opening the database: transfers that were waiting when the server stopped. */
    recover(db: Db): void {
        const stale = (db.prepare(`SELECT id, status FROM transfers WHERE status IN (${ACTIVE.map(() => "?").join(",")})`).all(...ACTIVE) as { id: number; status: TransferStatus }[]).filter((r) => !this.runs.has(r.id));
        const now = nowIso();
        for (const r of stale) {
            // Without the confirmation the bank holds the order but never executes it
            const [status, message] =
                r.status === "awaiting_vop_confirm"
                    ? ["cancelled", "Abgebrochen: Der Server wurde neu gestartet, bevor du die Abweichung bestätigt hast."]
                    : ["unknown", "Der Server wurde neu gestartet, während die Überweisung lief. Ob sie ausgeführt wurde, ist unbekannt. Bitte nach dem nächsten Abruf in den Umsätzen prüfen."];
            db.prepare("UPDATE transfers SET status = ?, bank_message = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(status, message, now, now, r.id);
        }
    }
}

// ---------- Bookings ----------

/**
 * Links transfers of the account to the booking a fetch brought, by the end-to-end ID. A transfer
 * whose outcome was unknown is executed after all: its payee joins the list and the activity log
 * says so. Call after the account's bookings changed.
 */
export function linkBookedTransfers(db: Db, accountId: number): number {
    const rows = db
        .prepare(
            `SELECT tr.*, (SELECT t.id FROM transactions t WHERE t.account_id = tr.account_id AND t.end_to_end_id = tr.end_to_end_id AND t.is_return = 0 ORDER BY t.status = 'booked' DESC, t.id LIMIT 1) AS tx,
                    (SELECT a.name FROM accounts a WHERE a.id = tr.account_id) AS account_name
             FROM transfers tr WHERE tr.account_id = ? AND tr.transaction_id IS NULL AND tr.status IN ('executed', 'unknown')`,
        )
        .all(accountId) as (TransferRow & { tx: number | null; account_name: string | null })[];
    let linked = 0;
    for (const r of rows) {
        if (r.tx === null) continue;
        linked++;
        if (r.status !== "unknown") {
            db.prepare("UPDATE transfers SET transaction_id = ? WHERE id = ?").run(r.tx, r.id);
            continue;
        }
        db.prepare("UPDATE transfers SET transaction_id = ?, status = 'executed', bank_message = 'Die Buchung ist angekommen: Die Überweisung wurde ausgeführt.', updated_at = ? WHERE id = ?").run(r.tx, nowIso(), r.id);
        upsertPayee(db, r.payee_name, r.payee_iban, r.payee_bic);
        logActivity(db, { userId: r.created_by, userName: r.created_by_name, deviceId: null }, "transfer_executed", r.account_name, `an ${r.payee_name}, ${formatCents(r.amount)}, durch die Buchung bestätigt`);
    }
    return linked;
}

// ---------- Payees ----------

interface PayeeRow {
    id: number;
    name: string;
    iban: string;
    bic: string | null;
    last_used_at: string | null;
}

const payeeToApi = (r: PayeeRow): TransferPayee => ({ id: r.id, name: r.name, iban: r.iban, bic: r.bic, lastUsedAt: r.last_used_at });

/** Adds the payee of an executed transfer, or brings it to the top with the name last used. */
export function upsertPayee(db: Db, name: string, iban: string, bic: string | null): void {
    const now = nowIso();
    db.prepare(
        `INSERT INTO payees (name, iban, bic, last_used_at, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (iban) DO UPDATE SET name = excluded.name, bic = COALESCE(excluded.bic, payees.bic), last_used_at = excluded.last_used_at`,
    ).run(name, iban, bic, now, now);
}

export function listPayees(db: Db) {
    const payees = (db.prepare("SELECT * FROM payees ORDER BY last_used_at IS NULL, last_used_at DESC, name COLLATE NOCASE").all() as PayeeRow[]).map(payeeToApi);
    // Counterparties of debits with an IBAN, with the name of their latest booking
    const suggestions = db
        .prepare(
            `SELECT t.counterparty_name AS name, t.counterparty_iban AS iban, MAX(t.booking_date) AS lastDate
             FROM transactions t
             WHERE t.amount < 0 AND t.counterparty_iban IS NOT NULL AND t.counterparty_iban != '' AND t.counterparty_name != ''
               AND t.counterparty_iban NOT IN (SELECT iban FROM payees)
             GROUP BY t.counterparty_iban ORDER BY lastDate DESC LIMIT 200`,
        )
        .all() as { name: string; iban: string; lastDate: string }[];
    return { payees, suggestions: suggestions.map((s) => ({ ...s, bic: null })) };
}

export function deletePayee(db: Db, id: number): void {
    const r = db.prepare("DELETE FROM payees WHERE id = ?").run(id);
    if (r.changes === 0) throw notFound("Empfänger");
}
