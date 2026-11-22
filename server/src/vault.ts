// Holds what exists only while the server is unlocked: the open database, the data key and the
// field key. A user's password opens it; there is no separate passphrase.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger as Logger } from "fastify";
import type { ServerState } from "@mbm/shared";
import type { Config } from "./config.js";
import { KeyStore, NameTakenError, STRONG_KDF, WrongSecretError, type KdfParams, type UserRef } from "./crypto/keystore.js";
import { FieldCipher } from "./crypto/secrets.js";
import { migrate, openDatabase, type Db } from "./db/database.js";
import { seedDefaults, type SeedOptions } from "./db/seed.js";
import { conflict, HttpError } from "./http/errors.js";

/** The first user of a fresh database; the key store is written before the database exists. */
const FIRST_USER_ID = 1;

interface Opened {
    db: Db;
    cipher: FieldCipher;
    dataKey: Buffer;
}

/** What a password attempt gets to work with. While `wasLocked`, nobody else sees this database yet. */
export interface Attempt {
    db: Db;
    fields: FieldCipher;
    userId: number;
    wasLocked: boolean;
}

export class Vault {
    private opened: Opened | null = null;
    private readonly keystore: KeyStore;
    private readonly keyFile: string;
    private readonly dbFile: string;
    private readonly listeners = new Set<() => void>();
    private readonly openListeners = new Set<(db: Db) => void>();
    /** Serializes everything that derives keys or writes the key store. */
    private busy: Promise<unknown> = Promise.resolve();
    /** Writes to the key store under way on the open server; a lock() meanwhile waits for them. */
    private writes = 0;
    private lockPending = false;

    constructor(
        config: Config,
        private readonly log: Logger,
        /** Key derivation for passwords; also used for the user key. */
        readonly kdf: KdfParams = STRONG_KDF,
    ) {
        mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
        this.keyFile = path.join(config.dataDir, "keystore.json");
        this.keystore = new KeyStore(this.keyFile, kdf);
        this.keystore.check();
        this.dbFile = path.join(config.dataDir, "mbm.db");
    }

    state(): ServerState {
        if (!this.keystore.exists()) return "setup";
        return this.opened ? "ready" : "locked";
    }

    private get unlocked(): Opened {
        if (!this.opened) throw new HttpError(423, "locked", "Der Server ist gesperrt.");
        return this.opened;
    }

    /** The open database; throws 423 while locked. */
    get database(): Db {
        return this.unlocked.db;
    }

    get fields(): FieldCipher {
        return this.unlocked.cipher;
    }

    /** Called with the database each time it is opened, after the migrations. */
    onOpen(listener: (db: Db) => void): () => void {
        this.openListeners.add(listener);
        return () => this.openListeners.delete(listener);
    }

    onLock(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.busy.then(fn, fn);
        this.busy = run.catch(() => undefined);
        return run;
    }

    private beginWrite(): void {
        this.writes++;
    }

    private endWrite(): void {
        this.writes--;
        if (this.writes === 0 && this.lockPending) {
            this.lockPending = false;
            this.lock();
        }
    }

    /**
     * Runs `fn` on the open server while it writes the key store. A lock() meanwhile takes
     * effect only afterwards, so the data key stays intact and the follow-up steps of `fn`
     * still find the database open.
     */
    private write<T>(fn: (o: Opened) => Promise<T>): Promise<T> {
        return this.exclusive(async () => {
            const opened = this.unlocked;
            this.beginWrite();
            try {
                return await fn(opened);
            } finally {
                this.endWrite();
            }
        });
    }

    /** Runs `fn` with a copy of the data key, wiped afterwards. */
    private static async withKeyCopy<T>(dataKey: Buffer, fn: (key: Buffer) => Promise<T>): Promise<T> {
        const key = Buffer.from(dataKey);
        try {
            return await fn(key);
        } finally {
            key.fill(0);
        }
    }

    private async open(dataKey: Buffer): Promise<Opened> {
        const db = openDatabase(this.dbFile, dataKey);
        try {
            await migrate(db);
        } catch (err) {
            db.close();
            throw err;
        }
        for (const listener of this.openListeners) {
            try {
                listener(db);
            } catch (err) {
                this.log.error({ err }, "open listener failed");
            }
        }
        return { db, cipher: new FieldCipher(dataKey), dataKey };
    }

    private static discard(o: Opened): void {
        o.db.close();
        o.dataKey.fill(0);
    }

    /**
     * Sets MBM up: key store, encrypted database, the start trees chosen in `seed` and the first
     * user. Returns the recovery key.
     */
    setup(name: string, password: string, seed: SeedOptions, createFirstUser: (db: Db) => number): Promise<string> {
        return this.exclusive(async () => {
            if (this.keystore.exists()) throw new HttpError(409, "already_set_up", "MBM ist bereits eingerichtet.");
            if (existsSync(this.dbFile)) throw new HttpError(409, "database_exists", "Im Datenverzeichnis liegt schon eine Datenbank ohne Schlüssel.");
            const { dataKey, recoveryKey } = await this.keystore.create({ userId: FIRST_USER_ID, name, password });
            let opened: Opened | null = null;
            try {
                opened = await this.open(dataKey);
                seedDefaults(opened.db, seed);
                if (createFirstUser(opened.db) !== FIRST_USER_ID) throw new Error("first user has an unexpected id");
            } catch (err) {
                // Nothing of a failed set-up stays behind, so it can be tried again
                if (opened) Vault.discard(opened);
                for (const f of [this.dbFile, `${this.dbFile}-wal`, `${this.dbFile}-shm`, this.keyFile]) rmSync(f, { force: true });
                throw err;
            }
            this.opened = opened;
            this.log.info("set up: key store and encrypted database created");
            return recoveryKey;
        });
    }

    /**
     * Checks a user's password (throws WrongSecretError) and runs `fn` on the database. A locked
     * server is opened for `fn` alone and stays open only when `fn` asks for it (`keep`), so a
     * right password without the second factor leaves it locked.
     */
    attempt<T>(who: UserRef, password: string, fn: (a: Attempt) => { keep: boolean; value: T }): Promise<T> {
        return this.exclusive(async () => {
            if (!this.keystore.exists()) throw new HttpError(409, "not_set_up", "MBM ist noch nicht eingerichtet.");
            const { dataKey, userId } = await this.keystore.unlockWithPassword(who, password);
            if (this.opened) {
                dataKey.fill(0);
                return fn({ db: this.opened.db, fields: this.opened.cipher, userId, wasLocked: false }).value;
            }
            const opened = await this.open(dataKey);
            try {
                const result = fn({ db: opened.db, fields: opened.cipher, userId, wasLocked: true });
                if (result.keep) {
                    this.opened = opened;
                    // The id, not the name: logs are not encrypted
                    this.log.info({ userId }, "unlocked");
                } else {
                    Vault.discard(opened);
                }
                return result.value;
            } catch (err) {
                Vault.discard(opened);
                throw err;
            }
        });
    }

    /** True when the password belongs to this user. */
    checkPassword(userId: number, password: string): Promise<boolean> {
        return this.exclusive(async () => {
            try {
                (await this.keystore.unlockWithPassword({ userId }, password)).dataKey.fill(0);
                return true;
            } catch (err) {
                if (err instanceof WrongSecretError) return false;
                throw err;
            }
        });
    }

    /**
     * Opens with the recovery key and gives the user found by `findUser` a new password; `then`
     * runs on the database right after. The server is unlocked afterwards; the user still signs
     * in with the second factor.
     */
    recover<U extends { id: number; name: string }>(
        recoveryKey: string,
        password: string,
        findUser: (db: Db) => U | undefined,
        then?: (db: Db, user: U) => void,
    ): Promise<U> {
        return this.exclusive(async () => {
            if (!this.keystore.exists()) throw new HttpError(409, "not_set_up", "MBM ist noch nicht eingerichtet.");
            let dataKey: Buffer;
            try {
                dataKey = await this.keystore.unlockWithRecoveryKey(recoveryKey);
            } catch (err) {
                if (err instanceof WrongSecretError) throw new HttpError(401, "wrong_secret", "Der Wiederherstellungsschlüssel stimmt nicht.");
                throw err;
            }
            const fresh = this.opened ? null : await this.open(dataKey);
            const opened = this.opened ?? fresh!;
            // A freshly opened database is seen by nobody else yet: no lock() can reach it
            if (!fresh) {
                dataKey.fill(0);
                this.beginWrite();
            }
            try {
                const user = findUser(opened.db);
                if (!user) throw new HttpError(404, "not_found", "Diesen Benutzer gibt es nicht.");
                await Vault.withKeyCopy(opened.dataKey, (key) => this.keystore.setUser(key, user.id, user.name, password));
                then?.(opened.db, user);
                if (fresh) {
                    this.opened = fresh;
                    this.log.info({ userId: user.id }, "unlocked with the recovery key");
                }
                return user;
            } catch (err) {
                if (fresh) Vault.discard(fresh);
                throw err;
            } finally {
                if (!fresh) this.endWrite();
            }
        });
    }

    /**
     * Writes a user's slot in the key store: new user, new password. `steps.user` names the user
     * on the open database; `then` (after success) and `undo` (after a failure) run there too,
     * before a lock() meanwhile takes effect.
     */
    setUserPassword<U extends { id: number; name: string }>(
        password: string,
        steps: { user: (db: Db) => U; then?: (db: Db, user: U) => void; undo?: (db: Db, user: U) => void },
    ): Promise<U> {
        return this.write(async (o) => {
            const user = steps.user(o.db);
            try {
                await Vault.withKeyCopy(o.dataKey, (key) => this.keystore.setUser(key, user.id, user.name, password));
            } catch (err) {
                steps.undo?.(o.db, user);
                if (err instanceof NameTakenError) throw conflict(`Es gibt schon einen Benutzer „${user.name}“.`, "name_taken");
                throw err;
            }
            steps.then?.(o.db, user);
            return user;
        });
    }

    /** After this the user's password opens nothing any more; `then` runs on the database right after. */
    removeUser(userId: number, then?: (db: Db) => void): Promise<void> {
        return this.write(async (o) => {
            this.keystore.removeUser(userId);
            then?.(o.db);
        });
    }

    /** Returns the new recovery key; `then` runs on the database right after. */
    replaceRecoveryKey(then?: (db: Db) => void): Promise<string> {
        return this.write(async (o) => {
            const recoveryKey = await Vault.withKeyCopy(o.dataKey, (key) => this.keystore.replaceRecoveryKey(key));
            then?.(o.db);
            return recoveryKey;
        });
    }

    /** Locks now, or right after a write to the key store under way. */
    lock(): void {
        if (!this.opened) return;
        if (this.writes > 0) {
            this.lockPending = true;
            return;
        }
        Vault.discard(this.opened);
        this.opened = null;
        this.log.info("locked");
        for (const l of this.listeners) l();
    }

    close(): void {
        if (this.opened) Vault.discard(this.opened);
        this.opened = null;
        this.lockPending = false;
    }
}
