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
//
// Orders run the same way: a scheduled transfer (execution "date") or a standing order
// ("standing") that is created, changed or deleted (`action`). Afterwards the orders of the
// account are fetched again – the bank is the source –, and that fetch also settles an order
// whose outcome was unknown (see resolveOrderTransfers).

import { randomBytes } from "node:crypto";
import {
    formatCents,
    recurrenceLabel,
    scheduledDateProblem,
    standingChangeProblem,
    standingOrderProblem,
    todayIso,
    type ConnectorAccountCapabilities,
    type ConnectorAccountRef,
    type ConnectorChallenge,
    type ConnectorRecurrence,
    type ConnectorVop,
    type OrderSnapshot,
    type OrderWriteData,
    type TransferAction,
    type TransferExecution,
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
import { orderRow, type ScheduledRow, type StandingRow } from "./orders.js";
import { logActivity, passwordEnteredAt, type Session } from "./users.js";

type Outcome =
    | { status: "done"; data: unknown; state: string }
    | { status: "approval"; operationId: string; challenge: ConnectorChallenge; vop?: ConnectorVop }
    | { status: "confirm"; operationId: string; vop: ConnectorVop };

type CreateRequest = z.output<(typeof routes)["createTransfer"]["body"]>;
type ChangeRequest = z.output<(typeof routes)["changeOrder"]["body"]>;
type OrderKind = "standing" | "scheduled";

/** What goes to the bank, before it is stored: a transfer, or an order to create, change or delete. */
interface Draft {
    requestId: string;
    accountId: number;
    payeeName: string;
    payeeIban: string;
    payeeBic: string | null;
    amount: number;
    remittance: string;
    instant: boolean;
    execution: TransferExecution;
    action: TransferAction;
    executionDate: string | null;
    recurrence: ConnectorRecurrence | null;
    orderId: number | null;
    bankOrderId: string | null;
    previous: OrderSnapshot | null;
    pin?: string;
}

/** What the bank answered about a transfer or an order. */
type Result = Pick<TransferData, "bankMessage" | "reference" | "vop"> & { unconfirmed?: boolean; bankOrderId?: string | null };

interface Run {
    transferId: number;
    /** A transfer now, or an order (scheduled transfer, standing order). */
    execution: TransferExecution;
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
    execution: TransferExecution;
    action: TransferAction;
    execution_date: string | null;
    first_date: string | null;
    unit: "month" | "week" | null;
    every: number | null;
    execution_day: number | null;
    last_date: string | null;
    order_id: number | null;
    bank_order_id: string | null;
    previous: string | null;
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

const recurrenceOf = (r: TransferRow): ConnectorRecurrence | null =>
    r.execution === "standing" && r.first_date && r.unit && r.every && r.execution_day
        ? { firstDate: r.first_date, unit: r.unit, every: r.every, executionDay: r.execution_day, lastDate: r.last_date }
        : null;

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
    execution: r.execution,
    action: r.action,
    executionDate: r.execution_date,
    recurrence: recurrenceOf(r),
    orderId: r.order_id,
    bankOrderId: r.bank_order_id,
    previous: r.previous ? (JSON.parse(r.previous) as OrderSnapshot) : null,
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

const de = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** The transfer or order as the activity log and the texts name it. */
export function describe(d: { execution: TransferExecution; action: TransferAction; instant: boolean; executionDate: string | null; recurrence: ConnectorRecurrence | null }): string {
    if (d.execution === "now") return d.instant ? "Echtzeitüberweisung" : "Überweisung";
    const what = d.execution === "date" ? "Terminüberweisung" : "Dauerauftrag";
    if (d.action === "change") return `Änderung ${d.execution === "date" ? "der Terminüberweisung" : "des Dauerauftrags"}`;
    if (d.action === "delete") return `Löschung ${d.execution === "date" ? "der Terminüberweisung" : "des Dauerauftrags"}`;
    if (d.execution === "date" && d.executionDate) return `${what} für ${de(d.executionDate)}`;
    if (d.recurrence) return `${what} (${recurrenceLabel(d.recurrence)})`;
    return what;
}

const describeRow = (r: TransferRow) => describe({ execution: r.execution, action: r.action, instant: r.instant === 1, executionDate: r.execution_date, recurrence: recurrenceOf(r) });

/** The order a change or deletion refers to, as it was. */
function snapshotOf(kind: OrderKind, row: StandingRow | ScheduledRow): OrderSnapshot {
    const base = { bankOrderId: row.bank_order_id ?? "", payeeName: row.payee_name, payeeIban: row.payee_iban, payeeBic: row.payee_bic, amount: row.amount, remittance: row.remittance };
    if (kind === "scheduled") return { ...base, executionDate: (row as ScheduledRow).execution_date, recurrence: null };
    const s = row as StandingRow;
    return { ...base, executionDate: null, recurrence: { firstDate: s.first_date, unit: s.unit, every: s.every, executionDay: s.execution_day, lastDate: s.last_date } };
}

/** The fields that make a request the same one again (double click, retry). */
const fingerprint = (d: Omit<Draft, "requestId" | "pin" | "previous" | "bankOrderId">) =>
    JSON.stringify([d.accountId, d.payeeName, d.payeeIban, d.payeeBic, d.amount, d.remittance, d.instant, d.execution, d.action, d.executionDate, d.recurrence, d.orderId]);

const draftOfRow = (r: TransferRow) => ({
    accountId: r.account_id, payeeName: r.payee_name, payeeIban: r.payee_iban, payeeBic: r.payee_bic, amount: r.amount, remittance: r.remittance,
    instant: r.instant === 1, execution: r.execution, action: r.action, executionDate: r.execution_date, recurrence: recurrenceOf(r), orderId: r.order_id,
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
            .filter(({ caps }) => caps.transfer || caps.instantTransfer || caps.createScheduledTransfer || caps.createStandingOrder)
            .map(({ r, caps }) => ({
                id: r.id,
                name: r.name,
                iban: r.iban,
                connectionName: r.connection_name,
                instant: caps.instantTransfer === true,
                payeeVerification: caps.payeeVerification === true,
                pinRequired: r.save_pin === 0,
                transfer: caps.transfer === true,
                scheduled: caps.createScheduledTransfer === true,
                standing: caps.createStandingOrder === true,
                orderRules: caps.orderRules ?? null,
            }));
    }

    // ---------- Starting ----------

    /** A transfer now, a scheduled transfer or a new standing order. */
    start(db: Db, session: Session, userKey: Buffer, req: CreateRequest): Promise<Transfer> {
        const x = req.execution;
        return this.launch(db, session, userKey, {
            requestId: req.requestId,
            accountId: req.accountId,
            payeeName: req.payeeName,
            payeeIban: req.payeeIban,
            payeeBic: req.payeeBic,
            amount: req.amount,
            remittance: req.remittance,
            instant: req.instant,
            execution: x.kind,
            action: "create",
            executionDate: x.kind === "date" ? x.date : null,
            recurrence: x.kind === "standing" ? { firstDate: x.firstDate, unit: x.unit, every: x.every, executionDay: x.executionDay, lastDate: x.lastDate } : null,
            orderId: null,
            bankOrderId: null,
            previous: null,
            pin: req.pin,
        });
    }

    /** The complete order as it shall be after the change. */
    changeOrder(db: Db, session: Session, userKey: Buffer, kind: OrderKind, id: number, req: ChangeRequest): Promise<Transfer> {
        const { row, previous } = this.orderToWrite(db, kind, id, "change");
        const x = req.execution;
        if ((kind === "standing") !== (x.kind === "standing")) throw new HttpError(422, "wrong_kind", kind === "standing" ? "Ein Dauerauftrag bleibt ein Dauerauftrag." : "Eine Terminüberweisung bleibt eine Terminüberweisung.");
        return this.launch(db, session, userKey, {
            requestId: req.requestId,
            accountId: row.account_id,
            payeeName: req.payeeName,
            payeeIban: req.payeeIban,
            payeeBic: req.payeeBic,
            amount: req.amount,
            remittance: req.remittance,
            instant: false,
            execution: kind === "standing" ? "standing" : "date",
            action: "change",
            executionDate: x.kind === "date" ? x.date : null,
            recurrence: x.kind === "standing" ? { firstDate: x.firstDate, unit: x.unit, every: x.every, executionDay: x.executionDay, lastDate: x.lastDate } : null,
            orderId: row.id,
            bankOrderId: previous.bankOrderId,
            previous,
            pin: req.pin,
        });
    }

    deleteOrder(db: Db, session: Session, userKey: Buffer, kind: OrderKind, id: number, req: { requestId: string; pin?: string }): Promise<Transfer> {
        const { row, previous } = this.orderToWrite(db, kind, id, "delete");
        return this.launch(db, session, userKey, {
            requestId: req.requestId,
            accountId: row.account_id,
            payeeName: previous.payeeName,
            payeeIban: previous.payeeIban,
            payeeBic: previous.payeeBic,
            amount: previous.amount,
            remittance: previous.remittance,
            instant: false,
            execution: kind === "standing" ? "standing" : "date",
            action: "delete",
            executionDate: previous.executionDate,
            recurrence: previous.recurrence,
            orderId: row.id,
            bankOrderId: previous.bankOrderId,
            previous,
            pin: req.pin,
        });
    }

    /** The order to change or delete, if the bank lets it be changed or deleted. */
    private orderToWrite(db: Db, kind: OrderKind, id: number, action: "change" | "delete"): { row: StandingRow | ScheduledRow; previous: OrderSnapshot } {
        const row = orderRow(db, kind, id);
        if (!row) throw notFound("Auftrag");
        if (!row.bank_order_id) throw new HttpError(422, "no_bank_order_id", "Die Bank hat für diesen Auftrag keine Auftragsnummer gemeldet. Ändern und Löschen gehen dann nur im Online-Banking.");
        if (action === "change" && row.can_change === 0) throw new HttpError(422, "not_changeable", "Die Bank erlaubt nicht, diesen Auftrag zu ändern.");
        if (action === "delete" && row.can_delete === 0) throw new HttpError(422, "not_deletable", "Die Bank erlaubt nicht, diesen Auftrag zu löschen.");
        return { row, previous: snapshotOf(kind, row) };
    }

    private async launch(db: Db, session: Session, userKey: Buffer, d: Draft): Promise<Transfer> {
        // The same request twice at once (double click, retry): the second gets the first one's transfer
        for (let p = this.starting.get(d.requestId); p; p = this.starting.get(d.requestId)) await p.done.catch(() => undefined);
        // Nothing awaits between the check above and here, so no other start slips in between
        const done = this.begin(db, session, userKey, d);
        const entry = { userId: session.userId, accountId: d.accountId, done };
        this.starting.set(d.requestId, entry);
        try {
            return await done;
        } finally {
            if (this.starting.get(d.requestId) === entry) this.starting.delete(d.requestId);
        }
    }

    /** Whether the bank allows this from the account, and the rules it sets; throws if not. */
    private checkAllowed(caps: Partial<ConnectorAccountCapabilities>, d: Draft): void {
        const refuse = (text: string) => new HttpError(422, "not_allowed", text);
        if (d.execution === "now") {
            if (d.instant ? !caps.instantTransfer : !caps.transfer) throw refuse(d.instant ? "Die Bank erlaubt von diesem Konto keine Echtzeitüberweisung." : "Die Bank erlaubt von diesem Konto keine Überweisung.");
            return;
        }
        const scheduled = d.execution === "date";
        const allowed = scheduled
            ? { create: caps.createScheduledTransfer, change: caps.changeScheduledTransfer, delete: caps.deleteScheduledTransfer }[d.action]
            : { create: caps.createStandingOrder, change: caps.changeStandingOrder, delete: caps.deleteStandingOrder }[d.action];
        if (!allowed) {
            const verb = { create: "anlegen", change: "ändern", delete: "löschen" }[d.action];
            throw refuse(`Die Bank erlaubt für dieses Konto nicht, ${scheduled ? "Terminüberweisungen" : "Daueraufträge"} über MBM zu ${verb}.`);
        }
        if (d.action === "delete") return;
        const rules = caps.orderRules;
        const missing = () => new HttpError(409, "rules_unknown", "Die Regeln der Bank für Aufträge sind noch nicht bekannt. Bitte das Konto einmal abrufen.");
        const today = todayIso();
        let problem: string | null;
        if (scheduled) {
            const r = d.action === "create" ? rules?.scheduled : rules?.scheduledChange;
            if (!r) throw missing();
            problem = scheduledDateProblem(r, d.executionDate ?? "", today);
        } else if (d.action === "create") {
            if (!rules?.standing) throw missing();
            problem = standingOrderProblem(rules.standing, d.recurrence!, today);
        } else {
            if (!rules?.standingChange) throw missing();
            const before = { ...d.previous!, ...d.previous!.recurrence! };
            problem = standingChangeProblem(rules.standingChange, before, { ...d, ...d.recurrence! }, today);
        }
        if (problem) throw new HttpError(422, "order_rules", problem);
    }

    private async begin(db: Db, session: Session, userKey: Buffer, d: Draft): Promise<Transfer> {
        const same = db.prepare("SELECT * FROM transfers WHERE request_id = ?").get(d.requestId) as TransferRow | undefined;
        if (same) {
            if (same.created_by !== session.userId) throw new HttpError(409, "request_id_taken", "Diese Anfrage gehört zu einer anderen Überweisung.");
            if (fingerprint(draftOfRow(same)) !== fingerprint(d)) {
                throw new HttpError(409, "request_id_conflict", "Dieses Formular wurde schon einmal mit anderen Angaben an die Bank gesendet. Bitte zuerst im Verlauf nachsehen, bevor du erneut sendest.");
            }
            return toApi(same, session.userId, this.runs.get(same.id)?.challenge ?? null);
        }
        this.requireRecentPassword(db, session);

        const target = db
            .prepare(
                `SELECT l.*, bla.account_ref, bla.allowed_operations, a.iban AS account_iban, a.name AS account_name
                 FROM bank_login_accounts bla JOIN bank_logins l ON l.id = bla.login_id JOIN accounts a ON a.id = bla.account_id
                 WHERE bla.account_id = ? AND l.user_id = ? AND bla.missing_since IS NULL`,
            )
            .get(d.accountId, session.userId) as (bank.LoginRow & { account_ref: string; allowed_operations: string; account_iban: string | null; account_name: string }) | undefined;
        if (!target) {
            const exists = db.prepare("SELECT connection_id FROM accounts WHERE id = ?").get(d.accountId) as { connection_id: number | null } | undefined;
            if (!exists) throw notFound("Konto");
            if (exists.connection_id === null) throw new HttpError(422, "not_bank_account", "Von Offline-Konten gibt es keine Überweisungen.");
            throw new HttpError(409, "no_own_login", "Für dieses Konto hast du keine eigene Bank-Anmeldung.");
        }
        this.checkAllowed(JSON.parse(target.allowed_operations) as Partial<ConnectorAccountCapabilities>, d);
        if (d.action !== "delete" && target.account_iban && target.account_iban === d.payeeIban) throw new HttpError(422, "same_account", "Empfänger und Auftraggeber sind dasselbe Konto.");
        if (target.tan_method === null) throw new HttpError(409, "no_tan_method", "Bitte zuerst ein TAN-Verfahren wählen.");
        const running = (r: { userId: number; accountId: number }) => r.userId === session.userId && r.accountId === d.accountId;
        if ([...this.runs.values()].some(running) || [...this.starting.values()].some(running)) {
            throw new HttpError(409, "transfer_running", "Von diesem Konto läuft schon eine Überweisung oder ein Auftrag. Bitte erst abschließen oder abbrechen.");
        }
        // Checks credentials and PIN now, before anything is stored
        bank.connectorLogin(target, userKey, d.pin);
        const conn = bank.requireConnection(db, target.connection_id);
        const client = this.ctx.connectors.get(conn.connector);
        // An unreachable connector now means: nothing was sent. Later it would leave the outcome open.
        try {
            await client.call("info");
        } catch (e) {
            throw new HttpError(503, "connector_unavailable", e instanceof Error ? e.message : "Der Konnektor ist nicht erreichbar.");
        }

        const now = nowIso();
        const r = d.recurrence;
        const id = Number(
            db
                .prepare(
                    `INSERT INTO transfers (request_id, account_id, login_id, created_by, created_by_name, payee_name, payee_iban, payee_bic, amount, remittance, end_to_end_id, instant, status, created_at, updated_at,
                                            execution, action, execution_date, first_date, unit, every, execution_day, last_date, order_id, bank_order_id, previous)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    d.requestId, d.accountId, target.id, session.userId, session.userName, d.payeeName, d.payeeIban, d.payeeBic, d.amount, d.remittance, newEndToEndId(), d.instant ? 1 : 0, now, now,
                    d.execution, d.action, d.executionDate, r?.firstDate ?? null, r?.unit ?? null, r?.every ?? null, r?.executionDay ?? null, r?.lastDate ?? null, d.orderId, d.bankOrderId, d.previous ? JSON.stringify(d.previous) : null,
                ).lastInsertRowid,
        );
        logActivity(db, { userId: session.userId, userName: session.userName, deviceId: session.deviceId }, "transfer_submitted", target.account_name, `${describe(d)} an ${d.payeeName}, ${formatCents(d.amount)}`);

        const run: Run = {
            transferId: id,
            execution: d.execution,
            userId: session.userId,
            userName: session.userName,
            deviceId: session.deviceId,
            accountId: d.accountId,
            loginId: target.id,
            connectionId: conn.id,
            connector: conn.connector,
            key: Buffer.from(userKey),
            pin: d.pin,
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
        let final: { status: TransferStatus; message: string; data?: Result };
        let orderChanged = false;
        try {
            const data = await this.submit(run, account);
            final = { status: "executed", message: data.bankMessage, data };
        } catch (e) {
            // Cancelled or ran out while waiting for the user: end the operation (and its dialog) at the connector
            if ((e instanceof Cancelled || e instanceof Expired) && run.operationId) {
                await this.client(run).call("cancelOperation", { id: run.operationId }).catch(() => undefined);
            }
            orderChanged = e instanceof ConnectorCallError && e.code === "order_changed";
            final = this.failure(run, e);
        }
        run.waiter = null;
        run.challenge = null;
        this.runs.delete(run.transferId);
        try {
            this.finish(run, final);
        } catch {
            // the database was locked meanwhile: the next opening ends the transfer as unknown
        }
        // The bank is the source: its list of orders shows what happened
        if (run.execution !== "now" && (final.status === "executed" || final.status === "unknown" || orderChanged)) this.fetchOrdersAfter(run, run.execution);
        run.key.fill(0);
        run.pin = undefined;
        this.ctx.events.changed("transfers", "payees", "activity", "orders");
    }

    /** Fetches the orders of the account again, unless the bank wants an approval for that. */
    private fetchOrdersAfter(run: Run, execution: TransferExecution): void {
        try {
            const db = this.ctx.vault.database;
            const row = db.prepare("SELECT allowed_operations FROM bank_login_accounts WHERE login_id = ? AND account_id = ?").get(run.loginId, run.accountId) as { allowed_operations: string } | undefined;
            const caps = row ? (JSON.parse(row.allowed_operations) as Partial<ConnectorAccountCapabilities>) : {};
            const listable = execution === "standing" ? caps.standingOrders && !caps.standingOrdersTan : caps.scheduledTransfers && !caps.scheduledTransfersTan;
            if (!listable) return;
            this.ctx.sync.start(db, { id: run.userId, name: run.userName }, run.key, { accountId: run.accountId, ordersOnly: true, ...(run.pin ? { pins: { [String(run.connectionId)]: run.pin } } : {}) });
        } catch {
            // the list shows the old state until the next fetch; the result says what the bank answered
        }
    }

    /** The first call to the connector: which route depends on what the row asks for. */
    private send(client: ConnectorClient, row: TransferRow, base: { bank: { blz: string; url: string }; login: ReturnType<typeof bank.connectorLogin>; account: ConnectorAccountRef }): Promise<unknown> {
        const payment = { payeeName: row.payee_name, payeeIban: row.payee_iban, payeeBic: row.payee_bic, amount: row.amount, remittance: row.remittance, endToEndId: row.end_to_end_id };
        if (row.execution === "now") return client.call("transfer", { body: { ...base, transfer: { ...payment, instant: row.instant === 1 } } });
        const prev = row.previous ? (JSON.parse(row.previous) as OrderSnapshot) : null;
        const expectedBase = prev && { bankOrderId: prev.bankOrderId, payeeName: prev.payeeName, payeeIban: prev.payeeIban, amount: prev.amount, remittance: prev.remittance };
        if (row.execution === "date") {
            const order = { ...payment, executionDate: row.execution_date! };
            const expected = expectedBase && { ...expectedBase, executionDate: prev!.executionDate! };
            if (row.action === "create") return client.call("createScheduledTransfer", { body: { ...base, order } });
            if (row.action === "change") return client.call("changeScheduledTransfer", { body: { ...base, expected: expected!, order } });
            return client.call("deleteScheduledTransfer", { body: { ...base, expected: expected! } });
        }
        const order = { ...payment, recurrence: recurrenceOf(row)! };
        const expected = expectedBase && { ...expectedBase, ...prev!.recurrence! };
        if (row.action === "create") return client.call("createStandingOrder", { body: { ...base, order } });
        if (row.action === "change") return client.call("changeStandingOrder", { body: { ...base, expected: expected!, order } });
        return client.call("deleteStandingOrder", { body: { ...base, expected: expected! } });
    }

    private async submit(run: Run, account: ConnectorAccountRef): Promise<Result> {
        const db = () => this.ctx.vault.database;
        const client = this.client(run);
        const conn = bank.requireConnection(db(), run.connectionId);
        const row = requireRow(db(), run.transferId);
        const login = bank.connectorLogin(bank.loginById(db(), run.loginId), run.key, run.pin);
        let out = (await this.send(client, row, { bank: { blz: conn.blz, url: conn.fints_url }, login, account })) as Outcome;
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
        return out.data as TransferData | OrderWriteData;
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
        const unknown = run.execution !== "now"
            ? "Die Antwort der Bank ist nicht angekommen. Ob der Auftrag ausgeführt wurde, ist unbekannt. MBM ruft die Aufträge neu ab; bitte dort oder im Online-Banking prüfen, bevor du ihn noch einmal sendest."
            : "Die Antwort der Bank ist nicht angekommen. Ob die Überweisung ausgeführt wurde, ist unbekannt. Bitte nach dem nächsten Abruf in den Umsätzen prüfen, bevor du neu überweist.";
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
            case "order_changed":
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

    private finish(run: Run, f: { status: TransferStatus; message: string; data?: Result }): void {
        const db = this.ctx.vault.database;
        const d = f.data;
        db.prepare("UPDATE transfers SET status = ?, bank_message = ?, bank_reference = ?, unconfirmed = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(
            f.status, f.message, d?.reference ?? null, d?.unconfirmed ? 1 : 0, nowIso(), nowIso(), run.transferId,
        );
        if (d) db.prepare("UPDATE transfers SET vop_result = ?, vop_name = ?, vop_reason = ?, vop_text = COALESCE(NULLIF(?, ''), vop_text), vop_structured = ? WHERE id = ?").run(d.vop.result, d.vop.payeeName, d.vop.reason, d.vop.explanation, d.vop.structured ? 1 : 0, run.transferId);
        // A new or changed order may carry a new identification
        if (d?.bankOrderId) db.prepare("UPDATE transfers SET bank_order_id = ? WHERE id = ?").run(d.bankOrderId, run.transferId);
        const row = requireRow(db, run.transferId);
        if (f.status === "executed" && row.action !== "delete") upsertPayee(db, row.payee_name, row.payee_iban, row.payee_bic);
        const account = (db.prepare("SELECT name FROM accounts WHERE id = ?").get(row.account_id) as { name: string } | undefined)?.name ?? null;
        const action = { executed: "transfer_executed", rejected: "transfer_rejected", failed: "transfer_failed", cancelled: "transfer_cancelled", unknown: "transfer_unknown" }[f.status as "executed"] ?? "transfer_failed";
        logActivity(db, { userId: run.userId, userName: run.userName, deviceId: run.deviceId }, action, account, `${describeRow(row)} an ${row.payee_name}, ${formatCents(row.amount)}`);
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
             FROM transfers tr WHERE tr.account_id = ? AND tr.transaction_id IS NULL AND tr.status IN ('executed', 'unknown') AND tr.execution IN ('now', 'date') AND tr.action = 'create'`,
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

// ---------- Orders after a fetch ----------

/**
 * After a fetch replaced the orders of `kind` of the account: links the transfers that created or
 * changed an order to it, and settles those whose outcome was unknown. A new or changed order is
 * found by the own end-to-end ID or by the identification the bank gave; a change also by its new
 * data; a deletion counts as done once the order is gone. An order still listed after a deletion
 * may be marked for deletion only, so that stays unknown.
 */
export function resolveOrderTransfers(db: Db, accountId: number, kind: OrderKind): number {
    const table = kind === "standing" ? "standing_orders" : "scheduled_transfers";
    const execution = kind === "standing" ? "standing" : "date";
    const rows = db
        .prepare(
            `SELECT tr.*, (SELECT a.name FROM accounts a WHERE a.id = tr.account_id) AS account_name FROM transfers tr
             WHERE tr.account_id = ? AND tr.execution = ? AND (tr.status = 'unknown' OR (tr.status = 'executed' AND tr.action != 'delete' AND tr.finished_at >= ?))`,
        )
        .all(accountId, execution, new Date(Date.now() - 24 * 3600_000).toISOString()) as (TransferRow & { account_name: string | null })[];
    const orders = db.prepare(`SELECT * FROM ${table} WHERE account_id = ?`).all(accountId) as (StandingRow & ScheduledRow)[];
    let settled = 0;
    for (const r of rows) {
        const sameData = (o: StandingRow & ScheduledRow) =>
            o.payee_iban === r.payee_iban && o.amount === r.amount && o.payee_name.trim() === r.payee_name.trim() && o.remittance.trim() === r.remittance.trim() &&
            (kind === "scheduled" ? o.execution_date === r.execution_date : o.unit === r.unit && o.every === r.every && o.execution_day === r.execution_day && o.last_date === r.last_date);
        let hit: (StandingRow & ScheduledRow) | undefined;
        if (r.action === "delete") {
            if (r.status !== "unknown" || orders.some((o) => o.bank_order_id === r.bank_order_id)) continue;
        } else {
            hit =
                orders.find((o) => o.end_to_end_id === r.end_to_end_id) ??
                (r.bank_order_id ? orders.find((o) => o.bank_order_id === r.bank_order_id && (r.action === "create" || sameData(o))) : undefined) ??
                (r.action === "change" && r.order_id !== null ? orders.find((o) => o.id === r.order_id && sameData(o)) : undefined);
            if (!hit) continue;
            if (r.status === "executed") {
                if (r.order_id !== hit.id) db.prepare("UPDATE transfers SET order_id = ?, bank_order_id = COALESCE(bank_order_id, ?) WHERE id = ?").run(hit.id, hit.bank_order_id, r.id);
                continue;
            }
        }
        settled++;
        const message = r.action === "delete" ? "Der Auftrag ist nicht mehr im Bestand der Bank: Er wurde gelöscht." : "Der Bestand der Bank zeigt den Auftrag: Er wurde ausgeführt.";
        db.prepare("UPDATE transfers SET status = 'executed', bank_message = ?, order_id = COALESCE(?, order_id), bank_order_id = COALESCE(bank_order_id, ?), updated_at = ? WHERE id = ?").run(
            message, hit?.id ?? null, hit?.bank_order_id ?? null, nowIso(), r.id,
        );
        if (r.action !== "delete") upsertPayee(db, r.payee_name, r.payee_iban, r.payee_bic);
        logActivity(db, { userId: r.created_by, userName: r.created_by_name, deviceId: null }, "transfer_executed", r.account_name, `${describeRow(r)} an ${r.payee_name}, ${formatCents(r.amount)}, durch den Bestand der Bank bestätigt`);
    }
    return settled;
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
             WHERE t.deleted_at IS NULL AND t.amount < 0 AND t.counterparty_iban IS NOT NULL AND t.counterparty_iban != '' AND t.counterparty_name != ''
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
