import type { ActivityEntry, Device, User } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { hashToken, newToken } from "../crypto/secrets.js";
import { conflict, notFound } from "../http/errors.js";

// ---------- Activity log ----------

export interface Actor {
    userId: number | null;
    userName: string | null;
    deviceId: number | null;
}

export function logActivity(db: Db, actor: Actor, action: string, target: string | null = null, details: string | null = null): void {
    db.prepare("INSERT INTO activity_log (created_at, user_id, user_name, device_id, action, target, details) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        nowIso(),
        actor.userId,
        actor.userName,
        actor.deviceId,
        action,
        target,
        details,
    );
}

export function listActivity(db: Db, limit: number): ActivityEntry[] {
    return db
        .prepare(
            `SELECT a.id, a.created_at AS createdAt, a.user_id AS userId, COALESCE(u.name, a.user_name) AS userName,
                    a.action, a.target, a.details
             FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
             ORDER BY a.id DESC LIMIT ?`,
        )
        .all(limit) as ActivityEntry[];
}

// ---------- Users ----------

export interface UserRow {
    id: number;
    name: string;
    totp_secret: string | null;
    totp_last_step: number | null;
    created_at: string;
    last_login_at: string | null;
}

export const toUser = (r: UserRow): User => ({
    id: r.id,
    name: r.name,
    totpActive: r.totp_secret !== null,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
});

export const getUserRow = (db: Db, id: number): UserRow | undefined => db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;

export const findUserByName = (db: Db, name: string): UserRow | undefined =>
    db.prepare("SELECT * FROM users WHERE name = ? COLLATE NOCASE").get(name.trim()) as UserRow | undefined;

export function requireUser(db: Db, id: number): UserRow {
    const row = getUserRow(db, id);
    if (!row) throw notFound("Benutzer");
    return row;
}

export const listUsers = (db: Db): User[] => (db.prepare("SELECT * FROM users ORDER BY name COLLATE NOCASE").all() as UserRow[]).map(toUser);

/** The password lives in the key store only: the caller writes the user's slot there. */
export function createUser(db: Db, name: string): User {
    if (findUserByName(db, name)) throw conflict(`Es gibt schon einen Benutzer „${name}“.`, "name_taken");
    const id = Number(db.prepare("INSERT INTO users (name, created_at) VALUES (?, ?)").run(name, nowIso()).lastInsertRowid);
    return toUser(requireUser(db, id));
}

/** Throws unless the user exists and is not the last one. */
export function requireDeletableUser(db: Db, id: number): UserRow {
    const user = requireUser(db, id);
    const n = (db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n;
    if (n <= 1) throw conflict("Der letzte Benutzer kann nicht entfernt werden.", "last_user");
    return user;
}

export function deleteUser(db: Db, id: number): void {
    requireDeletableUser(db, id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function setTotp(db: Db, id: number, sealedSecret: string | null, step: number | null): void {
    db.prepare("UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?").run(sealedSecret, step, id);
}

export function setTotpStep(db: Db, id: number, step: number): void {
    db.prepare("UPDATE users SET totp_last_step = ?, last_login_at = ? WHERE id = ?").run(step, nowIso(), id);
}

/** A code confirmed a step of a signed-in user: it does not work a second time. */
export function setTotpLastStep(db: Db, id: number, step: number): void {
    db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ?").run(step, id);
}

// ---------- Devices and sessions ----------

interface DeviceRow {
    id: number;
    user_id: number;
    name: string;
    kind: "web" | "device";
    created_at: string;
    last_seen_at: string | null;
}

const toDevice = (r: DeviceRow, currentId: number): Device => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    kind: r.kind,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.id === currentId,
});

/**
 * Creates a browser session or a device token. The token itself is returned once and never stored.
 * `passwordEntered`: the password was entered just now (sign-in); a device token created from a
 * session was not, so its first transfer asks for the password.
 */
export function createDevice(db: Db, userId: number, name: string, kind: "web" | "device", passwordEntered = true): { device: DeviceRow; token: string } {
    const token = newToken();
    const now = nowIso();
    const id = Number(
        db.prepare("INSERT INTO devices (user_id, name, kind, token_hash, created_at, last_seen_at, password_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, name, kind, hashToken(token), now, now, passwordEntered ? now : null)
            .lastInsertRowid,
    );
    return { device: db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow, token };
}

export function deviceToApi(db: Db, id: number, currentId: number): Device {
    return toDevice(db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow, currentId);
}

export function listDevices(db: Db, currentId: number): Device[] {
    return (db.prepare("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC").all() as DeviceRow[]).map((r) => toDevice(r, currentId));
}

export interface Session {
    userId: number;
    userName: string;
    deviceId: number;
    kind: "web" | "device";
    /** Locked after inactivity: only the password (or signing out) helps. */
    idleLocked: boolean;
}

/**
 * Resolves a token. A browser session ends after `sessionDays` without use; a device token lasts
 * until it is revoked. `last_seen_at` is written at most once a minute.
 */
export function resolveToken(db: Db, token: string, sessionDays: number): Session | null {
    const row = db
        .prepare(
            `SELECT d.id, d.kind, d.last_seen_at, d.idle_locked_at, u.id AS user_id, u.name AS user_name
             FROM devices d JOIN users u ON u.id = d.user_id
             WHERE d.token_hash = ? AND d.revoked_at IS NULL`,
        )
        .get(hashToken(token)) as
        | { id: number; kind: "web" | "device"; last_seen_at: string | null; idle_locked_at: string | null; user_id: number; user_name: string }
        | undefined;
    if (!row) return null;
    const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    if (row.kind === "web" && Date.now() - lastSeen > sessionDays * 86_400_000) {
        db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(nowIso(), row.id);
        return null;
    }
    if (Date.now() - lastSeen > 60_000) db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(nowIso(), row.id);
    return { userId: row.user_id, userName: row.user_name, deviceId: row.id, kind: row.kind, idleLocked: row.idle_locked_at !== null };
}

/**
 * State of a session that holds an open connection. An open window counts as use, so
 * `last_seen_at` moves on here as well (at most once a minute).
 */
export function connectedSessionState(db: Db, deviceId: number): "ok" | "idle_locked" | "gone" {
    const row = db
        .prepare("SELECT d.last_seen_at, d.idle_locked_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.revoked_at IS NULL")
        .get(deviceId) as { last_seen_at: string | null; idle_locked_at: string | null } | undefined;
    if (!row) return "gone";
    if (row.idle_locked_at) return "idle_locked";
    if (Date.now() - (row.last_seen_at ? Date.parse(row.last_seen_at) : 0) > 60_000) {
        db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(nowIso(), deviceId);
    }
    return "ok";
}

/** The session's user just entered the password (sign-in, unlock, confirmation before a transfer). */
export function markPasswordEntered(db: Db, deviceId: number): void {
    db.prepare("UPDATE devices SET password_at = ? WHERE id = ?").run(nowIso(), deviceId);
}

/** When the session's user last entered the password; null if never recorded. */
export function passwordEnteredAt(db: Db, deviceId: number): string | null {
    return (db.prepare("SELECT password_at FROM devices WHERE id = ?").get(deviceId) as { password_at: string | null } | undefined)?.password_at ?? null;
}

export function setIdleLocked(db: Db, deviceId: number, locked: boolean): void {
    db.prepare("UPDATE devices SET idle_locked_at = ? WHERE id = ?").run(locked ? nowIso() : null, deviceId);
}

/** Who a session belongs to, for the activity log. */
export function actorOfDevice(db: Db, deviceId: number): Actor {
    const row = db.prepare("SELECT u.id, u.name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?").get(deviceId) as
        | { id: number; name: string }
        | undefined;
    return { userId: row?.id ?? null, userName: row?.name ?? null, deviceId };
}

export function revokeDevice(db: Db, id: number): number {
    const row = db.prepare("SELECT user_id FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) as { user_id: number } | undefined;
    if (!row) throw notFound("Gerät");
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(nowIso(), id);
    return row.user_id;
}

export function revokeUserDevices(db: Db, userId: number, exceptDeviceId: number | null = null): number[] {
    const ids = (db.prepare("SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL").all(userId) as { id: number }[])
        .map((r) => r.id)
        .filter((id) => id !== exceptDeviceId);
    const stmt = db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(nowIso(), id);
    return ids;
}
