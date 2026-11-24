// The user key seals a user's bank logins (credentials and connector state). On disk it lies
// only wrapped: with the user's password (scrypt) and per session with a key from the session
// token (HKDF; the server keeps only the token's hash). So the server can unseal a bank login only
// while its owner makes a request; neither another user nor the unlocked server alone can.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { scrypt, type KdfParams } from "../crypto/keystore.js";
import type { Db } from "../db/database.js";

const VERSION = "uk1";

function encrypt(key: Buffer, plain: Buffer, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(aad));
    const data = Buffer.concat([c.update(plain), c.final()]);
    return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(key: Buffer, sealed: string, aad: string): Buffer {
    const [iv, tag, data] = sealed.split(".");
    if (!iv || !tag || data === undefined) throw new Error("unknown format");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]);
}

const passwordAad = (userId: number) => `mbm-user-key-v1:password:${userId}`;
const deviceAad = (deviceId: number) => `mbm-user-key-v1:device:${deviceId}`;
const tokenKey = (token: string): Buffer => Buffer.from(hkdfSync("sha256", Buffer.from(token), Buffer.alloc(0), Buffer.from("mbm-user-key-v1:token"), 32));

async function sealWithPassword(userKey: Buffer, password: string, userId: number, kdf: KdfParams): Promise<string> {
    const salt = randomBytes(16);
    const kek = await scrypt(password, salt, kdf);
    return `${VERSION}.${salt.toString("base64")}.${encrypt(kek, userKey, passwordAad(userId))}`;
}

async function openWithPassword(sealed: string, password: string, userId: number, kdf: KdfParams): Promise<Buffer> {
    const [v, salt, ...rest] = sealed.split(".");
    if (v !== VERSION || !salt) throw new Error("unknown format");
    const kek = await scrypt(password, Buffer.from(salt, "base64"), kdf);
    return decrypt(kek, rest.join("."), passwordAad(userId));
}

/**
 * At sign-in with the password: the user key, created on first use. If the stored one does not
 * open with this password (the password was set by someone else meanwhile), the user gets a new
 * key and their bank logins need the credentials again.
 */
export async function userKeyAtLogin(db: Db, userId: number, password: string, kdf: KdfParams): Promise<Buffer> {
    const row = db.prepare("SELECT sealed_user_key FROM users WHERE id = ?").get(userId) as { sealed_user_key: string | null } | undefined;
    if (row?.sealed_user_key) {
        try {
            return await openWithPassword(row.sealed_user_key, password, userId, kdf);
        } catch {
            forgetUserKey(db, userId);
        }
    }
    const key = randomBytes(32);
    db.prepare("UPDATE users SET sealed_user_key = ? WHERE id = ?").run(await sealWithPassword(key, password, userId, kdf), userId);
    return key;
}

/** Wraps the user key for a session or device token. */
export function attachUserKey(db: Db, deviceId: number, token: string, userKey: Buffer): void {
    db.prepare("UPDATE devices SET sealed_user_key = ? WHERE id = ?").run(`${VERSION}.${encrypt(tokenKey(token), userKey, deviceAad(deviceId))}`, deviceId);
}

/** The user key of a request; null if this session has none (signed in before M4). */
export function userKeyOfSession(db: Db, deviceId: number, token: string): Buffer | null {
    const row = db.prepare("SELECT sealed_user_key FROM devices WHERE id = ?").get(deviceId) as { sealed_user_key: string | null } | undefined;
    const sealed = row?.sealed_user_key;
    if (!sealed?.startsWith(`${VERSION}.`)) return null;
    try {
        return decrypt(tokenKey(token), sealed.slice(VERSION.length + 1), deviceAad(deviceId));
    } catch {
        return null;
    }
}

/** The user key wrapped for a new password, not stored yet. */
export interface RewrappedUserKey {
    userId: number;
    before: string;
    after: string;
}

/**
 * New password set by the user: the same key, wrapped anew. Done before the password changes, so
 * that a lock meanwhile cannot leave a new password with a key wrapped for the old one. Null if
 * there is no key yet or the current password does not open it: the next sign-in handles both.
 */
export async function rewrapForPassword(db: Db, userId: number, currentPassword: string, nextPassword: string, kdf: KdfParams): Promise<RewrappedUserKey | null> {
    const before = (db.prepare("SELECT sealed_user_key FROM users WHERE id = ?").get(userId) as { sealed_user_key: string | null } | undefined)?.sealed_user_key;
    if (!before) return null;
    let key: Buffer;
    try {
        key = await openWithPassword(before, currentPassword, userId, kdf);
    } catch {
        return null;
    }
    try {
        return { userId, before, after: await sealWithPassword(key, nextPassword, userId, kdf) };
    } finally {
        key.fill(0);
    }
}

/** Stores the new wrapping, unless the key was replaced or forgotten since it was made. */
export function storeRewrappedKey(db: Db, r: RewrappedUserKey): void {
    db.prepare("UPDATE users SET sealed_user_key = ? WHERE id = ? AND sealed_user_key = ?").run(r.after, r.userId, r.before);
}

/**
 * The key is lost (password set by another user or with the recovery key): its wrappings go,
 * and the user's bank logins need login name and PIN again. Accounts and bookings stay.
 */
export function forgetUserKey(db: Db, userId: number): void {
    db.prepare("UPDATE users SET sealed_user_key = NULL WHERE id = ?").run(userId);
    db.prepare("UPDATE devices SET sealed_user_key = NULL WHERE user_id = ?").run(userId);
    db.prepare("UPDATE bank_logins SET sealed_credentials = NULL, sealed_connector_state = NULL, status = 'credentials_lost' WHERE user_id = ?").run(userId);
}

/** Seals a value of a bank login with the user key; `aad` binds it to its row and column. */
export const sealForUser = (userKey: Buffer, plain: string, aad: string): string => `${VERSION}.${encrypt(userKey, Buffer.from(plain, "utf8"), aad)}`;

export function openForUser(userKey: Buffer, sealed: string, aad: string): string {
    if (!sealed.startsWith(`${VERSION}.`)) throw new Error("unknown format");
    return decrypt(userKey, sealed.slice(VERSION.length + 1), aad).toString("utf8");
}
