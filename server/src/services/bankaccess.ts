// Bank accesses: connections (shared), logins (per user, sealed with the user key), and taking
// over accounts. The bank directory is in bankdirectory.ts.

import type { BankConnection, BankLogin, ConnectorAccount, ConnectorLogin } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { HttpError, notFound } from "../http/errors.js";
import { deleteAccount, nextPosition, requireAccount, requireGroup } from "./accounts.js";
import { openForUser, sealForUser } from "./userkey.js";
import { clearOrders } from "./orders.js";

// ---------- Connections and logins ----------

interface ConnectionRow {
    id: number;
    name: string;
    connector: string;
    bank_name: string;
    blz: string;
    bic: string | null;
    fints_url: string;
    icon: string;
    color: string;
}

export interface LoginRow {
    id: number;
    connection_id: number;
    user_id: number;
    login_hint: string;
    sealed_credentials: string | null;
    sealed_connector_state: string | null;
    save_pin: number;
    tan_method: string | null;
    tan_method_name: string | null;
    tan_medium: string | null;
    status: BankLogin["status"];
    last_sync_at: string | null;
    last_error: string | null;
}

export interface Credentials {
    loginName: string;
    customerId?: string;
    /** Null when the PIN is not stored. */
    pin: string | null;
}

const nowIso = () => new Date().toISOString();
const credAad = (loginId: number) => `bank_logins:${loginId}:credentials`;
const stateAad = (loginId: number) => `bank_logins:${loginId}:state`;

export const loginHint = (name: string): string => (name.length > 4 ? `••••${name.slice(-4)}` : "••••");

const toLogin = (r: LoginRow): BankLogin => ({
    id: r.id,
    loginHint: r.login_hint,
    status: r.status,
    tanMethod: r.tan_method ? { id: r.tan_method, name: r.tan_method_name ?? r.tan_method } : null,
    tanMedium: r.tan_medium,
    savePin: r.save_pin === 1,
    lastSyncAt: r.last_sync_at,
    lastError: r.last_error,
});

export function requireConnection(db: Db, id: number): ConnectionRow {
    const row = db.prepare("SELECT * FROM bank_connections WHERE id = ?").get(id) as ConnectionRow | undefined;
    if (!row) throw notFound("Bankzugang");
    return row;
}

export function getConnection(db: Db, id: number, userId: number): BankConnection {
    const c = requireConnection(db, id);
    const logins = db.prepare("SELECT l.*, u.name AS user_name FROM bank_logins l JOIN users u ON u.id = l.user_id WHERE l.connection_id = ? ORDER BY u.name").all(id) as (LoginRow & { user_name: string })[];
    const mine = logins.find((l) => l.user_id === userId);
    const accountCount = (db.prepare("SELECT count(*) AS n FROM accounts WHERE connection_id = ?").get(id) as { n: number }).n;
    return {
        id: c.id,
        name: c.name,
        bankName: c.bank_name,
        blz: c.blz,
        bic: c.bic,
        fintsUrl: c.fints_url,
        icon: c.icon,
        color: c.color,
        myLogin: mine ? toLogin(mine) : null,
        otherLogins: logins.filter((l) => l.user_id !== userId).map((l) => ({ userName: l.user_name, status: l.status })),
        accountCount,
    };
}

export const listConnections = (db: Db, userId: number): BankConnection[] =>
    (db.prepare("SELECT id FROM bank_connections ORDER BY name, id").all() as { id: number }[]).map((r) => getConnection(db, r.id, userId));

/** Creates the connection, or returns the existing one for the same bank code and address. */
export function createConnection(
    db: Db,
    input: { blz: string; fintsUrl: string; bankName: string; name?: string; icon?: string; color?: string },
    dir: { name: string; bic: string } | null,
): { id: number; created: boolean } {
    const existing = db.prepare("SELECT id FROM bank_connections WHERE blz = ? AND fints_url = ?").get(input.blz, input.fintsUrl) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    const id = Number(
        db
            .prepare("INSERT INTO bank_connections (name, connector, bank_name, blz, bic, fints_url, icon, color, created_at) VALUES (?, 'fints', ?, ?, ?, ?, ?, ?, ?)")
            .run(input.name ?? dir?.name ?? input.bankName, input.bankName, input.blz, dir?.bic || null, input.fintsUrl, input.icon ?? "landmark", input.color ?? "red", nowIso()).lastInsertRowid,
    );
    return { id, created: true };
}

/** Removes the connection; its accounts become offline accounts (balance kept) or are deleted. */
export function deleteConnection(db: Db, id: number, accounts: "keep" | "delete"): void {
    requireConnection(db, id);
    db.transaction(() => {
        if (accounts === "delete") {
            db.prepare("DELETE FROM accounts WHERE connection_id = ?").run(id);
        } else {
            const rows = db.prepare("SELECT id FROM accounts WHERE connection_id = ?").all(id) as { id: number }[];
            for (const r of rows) toOffline(db, r.id);
        }
        db.prepare("DELETE FROM bank_connections WHERE id = ?").run(id);
    })();
}

/** Turns a bank account into an offline account; its bookings and last bank balance stay. */
function toOffline(db: Db, accountId: number): void {
    const balance = (db.prepare("SELECT amount FROM balances WHERE account_id = ?").get(accountId) as { amount: number } | undefined)?.amount;
    const sum = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ?").get(accountId) as { s: number }).s;
    // An offline balance is opening balance plus bookings: keep the last bank balance
    db.prepare("UPDATE accounts SET kind = 'offline', connection_id = NULL, external_id = NULL, opening_balance = ? WHERE id = ?").run((balance ?? sum) - sum, accountId);
    db.prepare("DELETE FROM balances WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM bank_login_accounts WHERE account_id = ?").run(accountId);
    clearOrders(db, accountId);
}

/**
 * Detaches one account from its bank access: it stays as an offline account, or goes with its
 * bookings. The bank keeps reporting it, so it is ignored from now on. Call inside a transaction.
 */
export function detachAccount(db: Db, accountId: number, mode: "keep" | "delete"): { name: string; connectionName: string } {
    const row = requireAccount(db, accountId);
    if (row.connection_id === null || row.external_id === null) throw new HttpError(409, "not_bank_account", "Das Konto gehört zu keinem Bankzugang.");
    const conn = requireConnection(db, row.connection_id);
    ignoreAccount(db, conn.id, row.external_id);
    toOffline(db, accountId);
    if (mode === "delete") deleteAccount(db, accountId);
    return { name: row.name, connectionName: conn.name };
}

export function findLogin(db: Db, connectionId: number, userId: number): LoginRow | undefined {
    return db.prepare("SELECT * FROM bank_logins WHERE connection_id = ? AND user_id = ?").get(connectionId, userId) as LoginRow | undefined;
}

export function requireLogin(db: Db, connectionId: number, userId: number): LoginRow {
    requireConnection(db, connectionId);
    const row = findLogin(db, connectionId, userId);
    if (!row) throw new HttpError(404, "no_login", "Du hast für diesen Bankzugang noch keine eigene Anmeldung.");
    return row;
}

export const loginById = (db: Db, id: number): LoginRow => db.prepare("SELECT * FROM bank_logins WHERE id = ?").get(id) as LoginRow;
export const loginToApi = (db: Db, id: number): BankLogin => toLogin(loginById(db, id));

/** Sets (or replaces) the user's login; the TAN method is chosen afresh afterwards. */
export function setLogin(db: Db, connectionId: number, userId: number, userKey: Buffer, creds: Credentials, savePin: boolean): LoginRow {
    requireConnection(db, connectionId);
    let row = findLogin(db, connectionId, userId);
    if (!row) {
        db.prepare("INSERT INTO bank_logins (connection_id, user_id, login_hint, save_pin, created_at) VALUES (?, ?, ?, ?, ?)").run(connectionId, userId, loginHint(creds.loginName), savePin ? 1 : 0, nowIso());
        row = findLogin(db, connectionId, userId)!;
    }
    db.prepare(
        "UPDATE bank_logins SET login_hint = ?, sealed_credentials = ?, sealed_connector_state = NULL, save_pin = ?, tan_method = NULL, tan_method_name = NULL, tan_medium = NULL, status = 'setup', last_error = NULL WHERE id = ?",
    ).run(loginHint(creds.loginName), sealForUser(userKey, JSON.stringify(creds), credAad(row.id)), savePin ? 1 : 0, row.id);
    return loginById(db, row.id);
}

export function readCredentials(row: LoginRow, userKey: Buffer): Credentials {
    if (!row.sealed_credentials) throw new HttpError(409, "credentials_lost", "Bitte Anmeldename und PIN für diesen Bankzugang neu eingeben.");
    try {
        return JSON.parse(openForUser(userKey, row.sealed_credentials, credAad(row.id))) as Credentials;
    } catch {
        throw new HttpError(409, "credentials_lost", "Bitte Anmeldename und PIN für diesen Bankzugang neu eingeben.");
    }
}

export function writeCredentials(db: Db, row: LoginRow, userKey: Buffer, creds: Credentials): void {
    db.prepare("UPDATE bank_logins SET sealed_credentials = ?, login_hint = ? WHERE id = ?").run(sealForUser(userKey, JSON.stringify(creds), credAad(row.id)), loginHint(creds.loginName), row.id);
}

/** What the connector needs for one call; `pin` overrides a PIN that is not stored. */
export function connectorLogin(row: LoginRow, userKey: Buffer, pin?: string): ConnectorLogin {
    const creds = readCredentials(row, userKey);
    const usePin = pin ?? creds.pin;
    if (!usePin) throw new HttpError(409, "pin_required", "Bitte die PIN eingeben.");
    let state: string | undefined;
    if (row.sealed_connector_state) {
        try {
            state = openForUser(userKey, row.sealed_connector_state, stateAad(row.id));
        } catch {
            state = undefined; // the connector synchronises again
        }
    }
    return {
        userId: creds.loginName,
        customerId: creds.customerId || undefined,
        pin: usePin,
        state,
        tanMethod: row.tan_method ?? undefined,
        tanMedium: row.tan_medium ?? undefined,
    };
}

export function saveConnectorState(db: Db, loginId: number, userKey: Buffer, state: string): void {
    db.prepare("UPDATE bank_logins SET sealed_connector_state = ? WHERE id = ?").run(sealForUser(userKey, state, stateAad(loginId)), loginId);
}

export function setLoginStatus(db: Db, loginId: number, status: BankLogin["status"], error: string | null = null): void {
    db.prepare("UPDATE bank_logins SET status = ?, last_error = ? WHERE id = ?").run(status, error, loginId);
}

// ---------- Taking over accounts ----------

const SUPPORTED_KINDS = new Set(["giro", "savings", "credit_card", "loan"]);
export const isSupportedKind = (kind: string): boolean => SUPPORTED_KINDS.has(kind);

export function isIgnored(db: Db, connectionId: number, externalId: string): boolean {
    return db.prepare("SELECT 1 FROM bank_ignored_accounts WHERE connection_id = ? AND external_id = ?").get(connectionId, externalId) !== undefined;
}

/** A fetch no longer reports the account as new; taking it over ends this. */
export function ignoreAccount(db: Db, connectionId: number, externalId: string): void {
    db.prepare("INSERT OR IGNORE INTO bank_ignored_accounts (connection_id, external_id, created_at) VALUES (?, ?, ?)").run(connectionId, externalId, nowIso());
}

/** True when the own login reaches the account (it is fetched with that login). */
export function isLinked(db: Db, loginId: number, accountId: number): boolean {
    return db.prepare("SELECT 1 FROM bank_login_accounts WHERE login_id = ? AND account_id = ?").get(loginId, accountId) !== undefined;
}

export function accountIdOf(db: Db, connectionId: number, externalId: string): number | null {
    return (db.prepare("SELECT id FROM accounts WHERE connection_id = ? AND external_id = ?").get(connectionId, externalId) as { id: number } | undefined)?.id ?? null;
}

const ICONS: Record<string, string> = { giro: "landmark", savings: "piggy-bank", credit_card: "credit-card", loan: "percent" };


/** Links the login to the account (creating it if needed) and remembers how to address it. */
export function takeOverAccount(
    db: Db,
    connectionId: number,
    loginId: number,
    acc: ConnectorAccount,
    choice: { name?: string; groupId: number | null; icon?: string; color?: string },
): { accountId: number; created: boolean } {
    let accountId = accountIdOf(db, connectionId, acc.externalId);
    const created = accountId === null;
    if (accountId === null) {
        if (!isSupportedKind(acc.kind)) throw new HttpError(422, "not_supported", `„${acc.name}“ kann MBM noch nicht übernehmen.`);
        if (choice.groupId !== null) requireGroup(db, choice.groupId);
        const conn = requireConnection(db, connectionId);
        accountId = Number(
            db
                .prepare(
                    `INSERT INTO accounts (connection_id, external_id, iban, bic, card_number, name, currency, kind, icon, color, group_id, position, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    connectionId,
                    acc.externalId,
                    acc.iban,
                    acc.bic,
                    acc.kind === "credit_card" ? acc.accountNumber : null,
                    choice.name ?? acc.name,
                    acc.currency,
                    acc.kind,
                    choice.icon ?? ICONS[acc.kind] ?? "landmark",
                    choice.color ?? conn.color,
                    choice.groupId,
                    nextPosition(db, choice.groupId),
                    nowIso(),
                ).lastInsertRowid,
        );
    } else if (acc.kind === "credit_card") {
        db.prepare("UPDATE accounts SET card_number = ? WHERE id = ? AND kind = 'credit_card'").run(acc.accountNumber, accountId);
    }
    db.prepare("DELETE FROM bank_ignored_accounts WHERE connection_id = ? AND external_id = ?").run(connectionId, acc.externalId);
    const ref = JSON.stringify({ accountNumber: acc.accountNumber, subAccount: acc.subAccount, iban: acc.iban, bic: acc.bic });
    db.prepare(
        `INSERT INTO bank_login_accounts (login_id, account_id, account_ref, allowed_operations, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (login_id, account_id) DO UPDATE SET account_ref = excluded.account_ref, allowed_operations = excluded.allowed_operations, last_seen_at = excluded.last_seen_at, missing_since = NULL`,
    ).run(loginId, accountId, ref, JSON.stringify(acc.capabilities), nowIso());
    return { accountId, created };
}
