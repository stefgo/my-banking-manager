// Standing orders and scheduled transfers as last fetched from the banks. The bank is the
// source: a fetch replaces the orders of an account, nothing is edited here. From them come the
// list, the single runs of the coming days and the forecast of the balance.

import {
    addDaysIso, nextStandingOrderDate, standingOrderDates, toBankingDay, todayIso,
    type AccountScope, type ConnectorAccountCapabilities, type ConnectorScheduledTransfer, type ConnectorStandingOrder, type Order, type OrderAccount, type Recurrence, type UpcomingOrder,
} from "@mbm/shared";
import type { Db } from "../db/database.js";
import { accountsInScope } from "./accounts.js";

interface BaseRow {
    id: number;
    account_id: number;
    bank_order_id: string | null;
    payee_name: string;
    payee_iban: string;
    payee_bic: string | null;
    amount: number;
    remittance: string;
    can_change: number | null;
    can_delete: number | null;
    end_to_end_id: string | null;
    fetched_at: string;
}
export interface StandingRow extends BaseRow {
    unit: "month" | "week";
    every: number;
    execution_day: number;
    first_date: string;
    last_date: string | null;
}
export interface ScheduledRow extends BaseRow {
    execution_date: string;
}

const flag = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);
const bool = (v: number | null): boolean | null => (v === null ? null : v === 1);
const recurrence = (r: StandingRow): Recurrence => ({ unit: r.unit, every: r.every, executionDay: r.execution_day, firstDate: r.first_date, lastDate: r.last_date });
const inList = (ids: number[]): string => ids.map(() => "?").join(",");

// ---------- Taking over a fetch ----------

/**
 * Replaces the rows of an account by what the bank sent. A row whose order the bank still
 * reports under the same identification keeps its id, so a client's selection survives a fetch.
 */
function replace<T extends { bankOrderId: string | null }>(db: Db, table: "standing_orders" | "scheduled_transfers", accountId: number, orders: T[], write: (o: T, id: number | null) => void): void {
    db.transaction(() => {
        const existing = db.prepare(`SELECT id, bank_order_id FROM ${table} WHERE account_id = ?`).all(accountId) as { id: number; bank_order_id: string | null }[];
        const kept = new Set<number>();
        for (const o of orders) {
            const match = o.bankOrderId === null ? undefined : existing.find((e) => e.bank_order_id === o.bankOrderId && !kept.has(e.id));
            if (match) kept.add(match.id);
            write(o, match?.id ?? null);
        }
        for (const e of existing) if (!kept.has(e.id)) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(e.id);
    })();
}

export function replaceStandingOrders(db: Db, accountId: number, orders: ConnectorStandingOrder[], now = new Date().toISOString()): void {
    replace(db, "standing_orders", accountId, orders, (o, id) => {
        const values = [o.bankOrderId, o.payeeName, o.payeeIban, o.payeeBic, o.amount, o.remittance, o.unit, o.every, o.executionDay, o.firstDate, o.lastDate, flag(o.canChange), flag(o.canDelete), o.endToEndId, now];
        if (id !== null) {
            db.prepare(
                `UPDATE standing_orders SET bank_order_id = ?, payee_name = ?, payee_iban = ?, payee_bic = ?, amount = ?, remittance = ?, unit = ?, every = ?, execution_day = ?,
                        first_date = ?, last_date = ?, can_change = ?, can_delete = ?, end_to_end_id = ?, fetched_at = ? WHERE id = ?`,
            ).run(...values, id);
        } else {
            db.prepare(
                `INSERT INTO standing_orders (bank_order_id, payee_name, payee_iban, payee_bic, amount, remittance, unit, every, execution_day, first_date, last_date, can_change, can_delete, end_to_end_id, fetched_at, account_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(...values, accountId);
        }
    });
}

export function replaceScheduledTransfers(db: Db, accountId: number, orders: ConnectorScheduledTransfer[], now = new Date().toISOString()): void {
    replace(db, "scheduled_transfers", accountId, orders, (o, id) => {
        const values = [o.bankOrderId, o.payeeName, o.payeeIban, o.payeeBic, o.amount, o.remittance, o.executionDate, flag(o.canChange), flag(o.canDelete), o.endToEndId, now];
        if (id !== null) {
            db.prepare(
                `UPDATE scheduled_transfers SET bank_order_id = ?, payee_name = ?, payee_iban = ?, payee_bic = ?, amount = ?, remittance = ?, execution_date = ?, can_change = ?, can_delete = ?, end_to_end_id = ?, fetched_at = ? WHERE id = ?`,
            ).run(...values, id);
        } else {
            db.prepare(
                `INSERT INTO scheduled_transfers (bank_order_id, payee_name, payee_iban, payee_bic, amount, remittance, execution_date, can_change, can_delete, end_to_end_id, fetched_at, account_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(...values, accountId);
        }
    });
}

export function markOrdersFetched(db: Db, accountId: number, now = new Date().toISOString()): void {
    db.prepare("UPDATE accounts SET orders_fetched_at = ? WHERE id = ?").run(now, accountId);
}

/** An account that leaves its bank access has no orders any more. */
export function clearOrders(db: Db, accountId: number): void {
    db.prepare("DELETE FROM standing_orders WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM scheduled_transfers WHERE account_id = ?").run(accountId);
    db.prepare("UPDATE accounts SET orders_fetched_at = NULL WHERE id = ?").run(accountId);
}

// ---------- Reading ----------

/** One order row by kind; undefined if a fetch removed it meanwhile. */
export function orderRow(db: Db, kind: "standing", id: number): StandingRow | undefined;
export function orderRow(db: Db, kind: "scheduled", id: number): ScheduledRow | undefined;
export function orderRow(db: Db, kind: "standing" | "scheduled", id: number): StandingRow | ScheduledRow | undefined;
export function orderRow(db: Db, kind: "standing" | "scheduled", id: number): StandingRow | ScheduledRow | undefined {
    return db.prepare(`SELECT * FROM ${kind === "standing" ? "standing_orders" : "scheduled_transfers"} WHERE id = ?`).get(id) as StandingRow | ScheduledRow | undefined;
}

const normIban = (s: string): string => s.replace(/\s/g, "").toUpperCase();

/** IBAN → account id of the accounts in MBM. */
function ownIbans(db: Db): Map<string, number> {
    const rows = db.prepare("SELECT id, iban FROM accounts WHERE iban IS NOT NULL AND iban <> ''").all() as { id: number; iban: string }[];
    return new Map(rows.map((r) => [normIban(r.iban), r.id]));
}

function rowsOf(db: Db, accountIds?: number[]): { standing: StandingRow[]; scheduled: ScheduledRow[] } {
    if (accountIds && accountIds.length === 0) return { standing: [], scheduled: [] };
    const where = accountIds ? `WHERE account_id IN (${inList(accountIds)})` : "";
    const args = accountIds ?? [];
    return {
        standing: db.prepare(`SELECT * FROM standing_orders ${where} ORDER BY id`).all(...args) as StandingRow[],
        scheduled: db.prepare(`SELECT * FROM scheduled_transfers ${where} ORDER BY id`).all(...args) as ScheduledRow[],
    };
}

const baseOf = (r: BaseRow, own: Map<string, number>) => {
    const payeeAccountId = own.get(normIban(r.payee_iban)) ?? null;
    return {
        id: r.id,
        accountId: r.account_id,
        payeeName: r.payee_name,
        payeeIban: r.payee_iban,
        payeeBic: r.payee_bic,
        amount: r.amount,
        remittance: r.remittance,
        payeeAccountId: payeeAccountId === r.account_id ? null : payeeAccountId,
        bankOrderId: r.bank_order_id,
        canChange: bool(r.can_change),
        canDelete: bool(r.can_delete),
        fetchedAt: r.fetched_at,
    };
};

/** The day a scheduled transfer runs: its date, or the next banking day. */
const scheduledDate = (r: ScheduledRow): string => toBankingDay(r.execution_date);

/** Orders of the accounts in scope, the next to run first, and what the user's logins may fetch there. */
export function listOrders(db: Db, userId: number, scope: AccountScope, today = todayIso()): { orders: Order[]; accounts: OrderAccount[] } {
    const ids = accountsInScope(db, scope);
    const own = ownIbans(db);
    const { standing, scheduled } = rowsOf(db, ids);
    const orders: Order[] = [
        ...standing.map((r): Order => ({ ...baseOf(r, own), kind: "standing", unit: r.unit, every: r.every, executionDay: r.execution_day, firstDate: r.first_date, lastDate: r.last_date, nextDate: nextStandingOrderDate(recurrence(r), today) })),
        ...scheduled.map((r): Order => {
            const date = scheduledDate(r);
            return { ...baseOf(r, own), kind: "scheduled", executionDate: r.execution_date, nextDate: date >= today ? date : null };
        }),
    ];
    // Ended orders last
    orders.sort((a, b) => (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999") || a.payeeName.localeCompare(b.payeeName, "de") || a.id - b.id);

    const accounts: OrderAccount[] = [];
    if (ids.length) {
        const rows = db
            .prepare(
                `SELECT a.id, a.orders_fetched_at, bla.allowed_operations FROM accounts a
                 JOIN bank_login_accounts bla ON bla.account_id = a.id JOIN bank_logins l ON l.id = bla.login_id
                 WHERE l.user_id = ? AND bla.missing_since IS NULL AND a.id IN (${inList(ids)}) ORDER BY a.id`,
            )
            .all(userId, ...ids) as { id: number; orders_fetched_at: string | null; allowed_operations: string }[];
        for (const r of rows) {
            const caps = JSON.parse(r.allowed_operations) as Partial<ConnectorAccountCapabilities>;
            if (!caps.standingOrders && !caps.scheduledTransfers) continue;
            accounts.push({
                accountId: r.id,
                standingOrders: !!caps.standingOrders,
                scheduledTransfers: !!caps.scheduledTransfers,
                needsApproval: (!!caps.standingOrders && !!caps.standingOrdersTan) || (!!caps.scheduledTransfers && !!caps.scheduledTransfersTan),
                fetchedAt: r.orders_fetched_at,
                createScheduled: !!caps.createScheduledTransfer,
                changeScheduled: !!caps.changeScheduledTransfer,
                deleteScheduled: !!caps.deleteScheduledTransfer,
                createStanding: !!caps.createStandingOrder,
                changeStanding: !!caps.changeStandingOrder,
                deleteStanding: !!caps.deleteStandingOrder,
            });
        }
    }
    return { orders, accounts };
}

/** The single runs of the orders in scope from today on, by date. */
export function upcomingOrders(db: Db, scope: AccountScope, days: number, count: number, today = todayIso()): UpcomingOrder[] {
    const ids = accountsInScope(db, scope);
    const own = ownIbans(db);
    const to = addDaysIso(today, days);
    const { standing, scheduled } = rowsOf(db, ids);
    const item = (r: BaseRow, kind: "standing" | "scheduled", date: string): UpcomingOrder => {
        const b = baseOf(r, own);
        return { date, orderId: r.id, kind, accountId: r.account_id, payeeName: r.payee_name, remittance: r.remittance, amount: r.amount, payeeAccountId: b.payeeAccountId };
    };
    const items = [
        ...standing.flatMap((r) => standingOrderDates(recurrence(r), today, to).map((d) => item(r, "standing", d))),
        ...scheduled.map((r) => item(r, "scheduled", scheduledDate(r))).filter((i) => i.date >= today && i.date <= to),
    ];
    items.sort((a, b) => a.date.localeCompare(b.date) || a.payeeName.localeCompare(b.payeeName, "de") || a.orderId - b.orderId);
    return items.slice(0, count);
}

/**
 * The balance of the accounts `ids` on the `days` days after today, if only the known orders
 * run. An order debits its account and credits the payee if that is an account in MBM, so an
 * order between two accounts of `ids` changes nothing. Empty if no order falls into the days.
 */
export function forecast(db: Db, ids: number[], balance: number, days: number, today = todayIso()): { date: string; balance: number }[] {
    if (ids.length === 0 || days < 1) return [];
    const inScope = new Set(ids);
    const own = ownIbans(db);
    const from = addDaysIso(today, 1);
    const to = addDaysIso(today, days);
    const deltas = new Map<string, number>();
    let any = false;
    const add = (r: BaseRow, date: string) => {
        const payee = own.get(normIban(r.payee_iban));
        const delta = (inScope.has(r.account_id) ? -r.amount : 0) + (payee !== undefined && payee !== r.account_id && inScope.has(payee) ? r.amount : 0);
        if (inScope.has(r.account_id) || (payee !== undefined && inScope.has(payee))) any = true;
        deltas.set(date, (deltas.get(date) ?? 0) + delta);
    };
    // All orders, not only those of `ids`: an order of another account may pay into one of them
    const { standing, scheduled } = rowsOf(db);
    for (const r of standing) for (const d of standingOrderDates(recurrence(r), from, to)) add(r, d);
    for (const r of scheduled) {
        const d = scheduledDate(r);
        if (d >= from && d <= to) add(r, d);
    }
    if (!any) return [];
    const points: { date: string; balance: number }[] = [];
    for (let date = from; date <= to; date = addDaysIso(date, 1)) {
        balance += deltas.get(date) ?? 0;
        points.push({ date, balance });
    }
    return points;
}
