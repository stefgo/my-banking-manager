// The key hierarchy: a random data key encrypts the database. On disk it exists only wrapped,
// once per user with a key derived from that user's password and once with a key derived from the
// recovery key. A password is right when it unwraps the data key; there is no other password hash.
// Changing a password re-wraps the data key; the database stays as it is.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

interface Wrapped {
    salt: string;
    iv: string;
    tag: string;
    data: string;
}

interface UserSlot extends Wrapped {
    userId: number;
    /** HMAC of the name, so the locked server finds the slot without the name lying on disk. */
    nameHash: string;
}

interface KeyStoreFile {
    version: 2;
    kdf: { name: "scrypt"; N: number; r: number; p: number };
    nameSalt: string;
    users: UserSlot[];
    recovery: Wrapped;
    createdAt: string;
}

export interface KdfParams {
    N: number;
    r: number;
    p: number;
}

/** scrypt with 128 MiB of memory: about half a second per attempt. */
export const STRONG_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };
/** For tests only. */
export const FAST_KDF: KdfParams = { N: 2 ** 10, r: 8, p: 1 };

export class WrongSecretError extends Error {
    constructor() {
        super("wrong password or recovery key");
    }
}

/** The name hash belongs to another user already. */
export class NameTakenError extends Error {
    constructor() {
        super("name hash in use");
    }
}

/** A key store written by an older version (with a passphrase); there is no way over. */
export class OldKeyStoreError extends Error {
    constructor(file: string) {
        super(`${file} stammt aus einer älteren Version (mit Passphrase). Bitte das Datenverzeichnis leeren und MBM neu einrichten.`);
    }
}

/** Who a password belongs to: found by name while locked, by id once the database is open. */
export type UserRef = { name: string } | { userId: number };

/** Derives a 32-byte key from a secret (scrypt with the key store's parameters). */
export function scrypt(secret: string, salt: Buffer, kdf: KdfParams): Promise<Buffer> {
    const options: ScryptOptions = { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 };
    return new Promise((resolve, reject) => {
        scryptCb(secret.normalize("NFKC"), salt, 32, options, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

const userAad = (userId: number): string => `mbm-data-key-v2:user:${userId}`;
const RECOVERY_AAD = "mbm-data-key-v2:recovery";

async function wrap(dataKey: Buffer, secret: string, kdf: KdfParams, aad: string): Promise<Wrapped> {
    const salt = randomBytes(16);
    const kek = await scrypt(secret, salt, kdf);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return { salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

async function unwrap(w: Wrapped, secret: string, kdf: KdfParams, aad: string): Promise<Buffer> {
    const kek = await scrypt(secret, Buffer.from(w.salt, "base64"), kdf);
    const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(w.iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(w.tag, "base64"));
    try {
        return Buffer.concat([decipher.update(Buffer.from(w.data, "base64")), decipher.final()]);
    } catch {
        throw new WrongSecretError();
    }
}

/** Names compare like in the database (NOCASE folds ASCII letters only). */
function hashName(nameSalt: string, name: string): string {
    const folded = name.trim().normalize("NFKC").replace(/[A-Z]/g, (c) => c.toLowerCase());
    return createHmac("sha256", Buffer.from(nameSalt, "base64")).update(folded).digest("base64");
}

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 32 characters from an alphabet without 0/O and 1/I, in groups of four: 160 bits. */
export function newRecoveryKey(): string {
    const bytes = randomBytes(32);
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % 32]).join("");
    return chars.match(/.{4}/g)!.join("-");
}

export const normalizeRecoveryKey = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export class KeyStore {
    constructor(
        private readonly file: string,
        private readonly kdf: KdfParams = STRONG_KDF,
    ) {}

    exists(): boolean {
        return existsSync(this.file);
    }

    private read(): KeyStoreFile {
        const content = JSON.parse(readFileSync(this.file, "utf8")) as KeyStoreFile;
        if (content.version !== 2) throw new OldKeyStoreError(this.file);
        return content;
    }

    /** Throws when the file is from an older version. */
    check(): void {
        if (this.exists()) this.read();
    }

    private write(content: KeyStoreFile): void {
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(content, null, 2), { mode: 0o600 });
        renameSync(tmp, this.file);
    }

    /** Creates the data key with the first user's slot. The recovery key is shown once. */
    async create(first: { userId: number; name: string; password: string }): Promise<{ dataKey: Buffer; recoveryKey: string }> {
        if (this.exists()) throw new Error("key store exists");
        const dataKey = randomBytes(32);
        const recoveryKey = newRecoveryKey();
        const nameSalt = randomBytes(32).toString("base64");
        this.write({
            version: 2,
            kdf: { name: "scrypt", ...this.kdf },
            nameSalt,
            users: [{ userId: first.userId, nameHash: hashName(nameSalt, first.name), ...(await wrap(dataKey, first.password, this.kdf, userAad(first.userId))) }],
            recovery: await wrap(dataKey, normalizeRecoveryKey(recoveryKey), this.kdf, RECOVERY_AAD),
            createdAt: new Date().toISOString(),
        });
        return { dataKey, recoveryKey };
    }

    /**
     * Unwraps the data key with a user's password. An unknown user costs the same time as a wrong
     * password, so the answer does not tell which names exist.
     */
    async unlockWithPassword(who: UserRef, password: string): Promise<{ dataKey: Buffer; userId: number }> {
        const ks = this.read();
        const slot = "userId" in who ? ks.users.find((u) => u.userId === who.userId) : ks.users.find((u) => u.nameHash === hashName(ks.nameSalt, who.name));
        if (!slot) {
            await scrypt(password, Buffer.alloc(16), ks.kdf);
            throw new WrongSecretError();
        }
        return { dataKey: await unwrap(slot, password, ks.kdf, userAad(slot.userId)), userId: slot.userId };
    }

    async unlockWithRecoveryKey(recoveryKey: string): Promise<Buffer> {
        const ks = this.read();
        return unwrap(ks.recovery, normalizeRecoveryKey(recoveryKey), ks.kdf, RECOVERY_AAD);
    }

    /** Adds a user's slot or replaces it (new password, new name). */
    async setUser(dataKey: Buffer, userId: number, name: string, password: string): Promise<void> {
        const ks = this.read();
        const nameHash = hashName(ks.nameSalt, name);
        if (ks.users.some((u) => u.nameHash === nameHash && u.userId !== userId)) throw new NameTakenError();
        const slot: UserSlot = { userId, nameHash, ...(await wrap(dataKey, password, ks.kdf, userAad(userId))) };
        this.write({ ...ks, users: [...ks.users.filter((u) => u.userId !== userId), slot] });
    }

    removeUser(userId: number): void {
        const ks = this.read();
        this.write({ ...ks, users: ks.users.filter((u) => u.userId !== userId) });
    }

    async replaceRecoveryKey(dataKey: Buffer): Promise<string> {
        const ks = this.read();
        const recoveryKey = newRecoveryKey();
        this.write({ ...ks, recovery: await wrap(dataKey, normalizeRecoveryKey(recoveryKey), ks.kdf, RECOVERY_AAD) });
        return recoveryKey;
    }
}
