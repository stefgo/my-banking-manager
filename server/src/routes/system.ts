import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { routes } from "@mbm/shared";
import { WrongSecretError } from "../crypto/keystore.js";
import { hashToken, newToken, newTotpSecret, totpUri, verifyTotp } from "../crypto/secrets.js";
import { conflict, HttpError } from "../http/errors.js";
import { handle, SESSION_COOKIE, tokenOf, type AppContext } from "../http/route.js";
import { Throttle } from "../http/throttle.js";
import { ensureCards } from "../services/profile.js";
import { serverVersion } from "../version.js";
import { attachUserKey, forgetUserKey, rewrapForPassword, storeRewrappedKey, userKeyAtLogin, userKeyOfSession } from "../services/userkey.js";
import {
    createDevice,
    createUser,
    deleteUser,
    deviceToApi,
    findUserByName,
    getUserRow,
    listActivity,
    listDevices,
    listUsers,
    logActivity,
    markPasswordEntered,
    requireDeletableUser,
    requireUser,
    resolveToken,
    revokeDevice,
    revokeUserDevices,
    setTotp,
    setTotpStep,
    type Session,
    type UserRow,
} from "../services/users.js";

/** Readable name of a browser from its user agent, e.g. "Safari auf macOS". */
export function browserName(ua: string | undefined): string {
    if (!ua) return "Browser";
    const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    return os ? `${browser} auf ${os}` : browser;
}

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
    // The counters below belong to this server instance

    // ---------- Throttling of failed sign-ins ----------

    const throttle = new Throttle();

    function throttleKey(request: FastifyRequest, name: string): string {
        return `${request.ip}|${name.trim().toLowerCase()}`;
    }

    /** One try with the recovery key: wrong keys of a client count together, on every route. */
    async function withRecoveryThrottle<T>(request: FastifyRequest, attempt: () => Promise<T>): Promise<T> {
        const key = throttleKey(request, "recovery-key");
        const release = throttle.begin(key);
        try {
            const result = await attempt();
            throttle.succeed(key);
            return result;
        } catch (err) {
            if (err instanceof HttpError && (err.code === "wrong_secret" || err.code === "wrong_recovery_key")) throttle.fail(key);
            throw err;
        } finally {
            release();
        }
    }

    // ---------- TOTP set-up in progress ----------

    // The stored secret stays valid until a new one is confirmed: giving up changes nothing
    interface PendingTotp {
        userId: number;
        secret: string;
        expires: number;
        userKey: Buffer | null;
        /** Replaces a second factor at sign-in: the user's old sessions end with the confirmation. */
        replaces: boolean;
        /** Started in this signed-in session and confirmed only there, without a new sign-in. */
        deviceId: number | null;
    }

    const pendingTotp = new Map<string, PendingTotp>();

    function startTotpSetup(
        user: Pick<UserRow, "id" | "name">,
        userKey: Buffer | null = null,
        { replaces = false, deviceId = null }: { replaces?: boolean; deviceId?: number | null } = {},
    ): { setupToken: string; secret: string; uri: string } {
        for (const [k, v] of pendingTotp) if (v.expires < Date.now() || v.userId === user.id) pendingTotp.delete(k);
        const setupToken = newToken();
        const secret = newTotpSecret();
        pendingTotp.set(setupToken, { userId: user.id, secret, expires: Date.now() + 10 * 60_000, userKey, replaces, deviceId });
        return { setupToken, secret, uri: totpUri(secret, user.name) };
    }

    const { vault, events, config, autoLock, reauth } = ctx;

    const meOf = (userId: number, name: string, deviceId: number, sessionLocked = false) => ({
        id: userId,
        name,
        deviceId,
        sessionLocked,
        sessionIdleMinutes: config.sessionIdleMinutes,
    });

    const signIn = (request: FastifyRequest, reply: FastifyReply, user: UserRow, client: "web" | "macos", deviceName: string | undefined, userKey: Buffer | null) => {
        const db = vault.database;
        const kind = client === "web" ? "web" : "device";
        const name = deviceName || (client === "web" ? browserName(request.headers["user-agent"]) : "macOS");
        const { device, token } = createDevice(db, user.id, name, kind);
        if (userKey) attachUserKey(db, device.id, token, userKey);
        ensureCards(db, user.id);
        logActivity(db, { userId: user.id, userName: user.name, deviceId: device.id }, "login", name);
        events.changed("devices", "activity");
        if (client === "web") {
            reply.setCookie(SESSION_COOKIE, token, {
                httpOnly: true,
                sameSite: "strict",
                path: "/",
                secure: config.secureCookies === "auto" ? request.protocol === "https" : config.secureCookies,
                maxAge: config.sessionDays * 86_400,
            });
            return { status: "ok" as const, user: meOf(user.id, user.name, device.id) };
        }
        return { status: "ok" as const, user: meOf(user.id, user.name, device.id), token };
    };

    // ---------- System ----------

    handle(app, ctx, routes.status, () => ({
        state: vault.state(),
        version: serverVersion(),
        webTheme: config.profileDefaults.web.theme,
    }));

    handle(app, ctx, routes.setup, async ({ body }) => {
        let userId = 0;
        const seed = { categories: body.defaultCategories, accountGroups: body.defaultAccountGroups };
        const recoveryKey = await vault.setup(body.name, body.password, seed, (db) => (userId = createUser(db, body.name).id));
        const db = vault.database;
        const user = requireUser(db, userId);
        logActivity(db, { userId: null, userName: null, deviceId: null }, "setup");
        logActivity(db, { userId: user.id, userName: user.name, deviceId: null }, "user_created", user.name);
        const userKey = await userKeyAtLogin(db, user.id, body.password, vault.kdf);
        return { recoveryKey, totp: startTotpSetup(user, userKey) };
    });

    handle(app, ctx, routes.recover, async ({ body, request }) => {
        const user = await withRecoveryThrottle(request, () =>
            vault.recover(
                body.recoveryKey,
                body.password,
                (db) => findUserByName(db, body.name),
                (db, user) => {
                    // Whoever knew the old password is out; the user signs in again with the second factor
                    for (const id of revokeUserDevices(db, user.id)) events.signOutDevice(id);
                    forgetUserKey(db, user.id);
                    logActivity(db, { userId: user.id, userName: user.name, deviceId: null }, "password_recovered", null, "mit Wiederherstellungsschlüssel");
                },
            ),
        );
        events.changed("devices", "activity");
        if (!body.resetTotp) return { ok: true as const };
        // The phone is gone as well: a new secret, which replaces the old one once confirmed
        const userKey = await userKeyAtLogin(vault.database, user.id, body.password, vault.kdf);
        return { ok: true as const, totp: startTotpSetup(user, userKey, { replaces: true }) };
    });

    // Phone lost, password known: the bank logins stay, because the password still opens the user key
    handle(app, ctx, routes.recoverTotp, async ({ body, request }) => {
        // One answer for all three, so a try does not tell which of them was right
        const wrong = () => new HttpError(401, "wrong_secret", "Name, Passwort oder Wiederherstellungsschlüssel stimmt nicht.");
        const user = await withRecoveryThrottle(request, async () => {
            if (!(await vault.checkRecoveryKey(body.recoveryKey))) throw wrong();
            try {
                return await vault.attempt<UserRow>({ name: body.name }, body.password, ({ db, userId, wasLocked }) => {
                    const row = getUserRow(db, userId);
                    if (!row) throw new WrongSecretError();
                    if (wasLocked) logActivity(db, { userId: row.id, userName: row.name, deviceId: null }, "unlock");
                    return { keep: true, value: row };
                });
            } catch (err) {
                if (err instanceof WrongSecretError) throw wrong();
                throw err;
            }
        });
        const userKey = await userKeyAtLogin(vault.database, user.id, body.password, vault.kdf);
        events.changed("activity");
        return startTotpSetup(user, userKey, { replaces: true });
    });

    handle(app, ctx, routes.lock, ({ db, actor }) => {
        // A running transfer would lose its result; its approval runs out after a few minutes anyway
        if (ctx.transfers.active()) throw new HttpError(409, "transfer_running", "Eine Überweisung läuft noch. Bitte erst abschließen oder abbrechen.");
        logActivity(db, actor, "lock");
        vault.lock();
        return { ok: true as const };
    });

    handle(app, ctx, routes.newRecoveryKey, async (req) => {
        const { body, actor } = req;
        // The password first: a wrong one must not use up the code
        await reauth.password(req, body.password);
        reauth.code(req, body.code);
        const recoveryKey = await vault.replaceRecoveryKey((db) => logActivity(db, actor, "recovery_key_replaced"));
        events.changed("activity");
        return { recoveryKey };
    });

    handle(app, ctx, routes.activity, ({ db, query }) => listActivity(db, query.limit));

    // ---------- Sign-in ----------

    /** A wrong password: counts against the session it came from (with wrong confirmations), the fifth signs that session out. */
    const wrongPassword = (request: FastifyRequest, reply: FastifyReply, name: string): never => {
        if (vault.state() === "ready") {
            const db = vault.database;
            const user = findUserByName(db, name);
            const token = tokenOf(request);
            const session = token ? resolveToken(db, token, config.sessionDays) : null;
            // An unknown name is whatever the client sent: it is not written into the log
            const actor = { userId: user?.id ?? null, userName: user?.name ?? null, deviceId: null };
            logActivity(db, actor, "login_failed", "Passwort", user ? null : "unbekannter Name");
            events.changed("activity");
            if (session && session.userId === user?.id) reauth.countFailure(db, session, reply);
        }
        throw new HttpError(401, "wrong_login", "Name oder Passwort stimmt nicht.");
    };

    type LoginOutcome =
        | { kind: "resumed"; user: UserRow; session: Session; wasLocked: boolean }
        | { kind: "signed_in"; user: UserRow; wasLocked: boolean }
        | { kind: "totp_setup"; user: UserRow; wasLocked: boolean }
        | { kind: "code_required" };

    // One way in for every case: the password opens a locked database and a locked session.
    // Whoever still holds a session of this user needs no code; everybody else needs the second
    // factor, and without it a locked database stays locked.
    handle(app, ctx, routes.login, async ({ body, request, reply }) => {
        const key = throttleKey(request, body.name);
        const release = throttle.begin(key);
        let outcome: LoginOutcome;
        try {
            outcome = await vault.attempt<LoginOutcome>({ name: body.name }, body.password, ({ db, fields, userId, wasLocked }) => {
                const user = getUserRow(db, userId);
                if (!user) throw new WrongSecretError();
                const token = tokenOf(request);
                const session = token ? resolveToken(db, token, config.sessionDays) : null;
                if (session && session.userId === user.id) return { keep: true, value: { kind: "resumed", user, session, wasLocked } };
                if (!user.totp_secret) return { keep: true, value: { kind: "totp_setup", user, wasLocked } };
                if (!body.code) return { keep: false, value: { kind: "code_required" } };
                const step = verifyTotp(fields.open(user.totp_secret), body.code, user.totp_last_step);
                if (step === null) {
                    throttle.fail(key);
                    logActivity(db, { userId: user.id, userName: user.name, deviceId: null }, "login_failed", "Code");
                    throw new HttpError(401, "wrong_code", "Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.");
                }
                setTotpStep(db, user.id, step);
                return { keep: true, value: { kind: "signed_in", user, wasLocked } };
            });
        } catch (err) {
            if (!(err instanceof WrongSecretError)) throw err;
            throttle.fail(key);
            return wrongPassword(request, reply, body.name);
        } finally {
            release();
        }
        if (outcome.kind === "code_required") return { status: "code_required" as const };

        const db = vault.database;
        const { user } = outcome;
        // The password is at hand only now: unwrap (or create) the key that seals bank logins
        const userKey = await userKeyAtLogin(db, user.id, body.password, vault.kdf);
        if (outcome.wasLocked) logActivity(db, { userId: user.id, userName: user.name, deviceId: null }, "unlock");
        if (outcome.kind === "totp_setup") {
            events.changed("activity");
            return { status: "totp_setup" as const, ...startTotpSetup(user, userKey) };
        }
        throttle.succeed(key);
        if (outcome.kind === "signed_in") return signIn(request, reply, user, body.client, body.deviceName, userKey);

        const { session } = outcome;
        const token = tokenOf(request);
        if (token) attachUserKey(db, session.deviceId, token, userKey);
        reauth.succeeded(session.deviceId);
        markPasswordEntered(db, session.deviceId);
        autoLock.unlockSession(session.deviceId);
        if (session.idleLocked) logActivity(db, { userId: user.id, userName: user.name, deviceId: session.deviceId }, "session_unlocked");
        events.changed("activity");
        return { status: "ok" as const, user: meOf(user.id, user.name, session.deviceId) };
    });

    handle(app, ctx, routes.confirmTotp, ({ db, fields, body, request, reply }) => {
        const pending = pendingTotp.get(body.setupToken);
        // A change started in a session is no way to sign in
        if (!pending || pending.expires < Date.now() || pending.deviceId !== null) throw new HttpError(401, "setup_expired", "Die Einrichtung ist abgelaufen. Bitte noch einmal anmelden.");
        const step = verifyTotp(pending.secret, body.code, null);
        if (step === null) throw new HttpError(401, "wrong_code", "Der Code stimmt nicht. Stimmt die Uhrzeit auf dem Telefon?");
        pendingTotp.delete(body.setupToken);
        setTotp(db, pending.userId, fields.seal(pending.secret), step);
        const user = requireUser(db, pending.userId);
        setTotpStep(db, user.id, step);
        const who = { userId: user.id, userName: user.name, deviceId: null };
        if (pending.replaces) {
            for (const id of revokeUserDevices(db, user.id)) events.signOutDevice(id);
            logActivity(db, who, "totp_changed", null, "mit Wiederherstellungsschlüssel");
            events.changed("users");
        } else {
            logActivity(db, who, "totp_set_up");
        }
        return signIn(request, reply, user, body.client, body.deviceName, pending.userKey);
    });

    // Changing the own second factor needs both factors; without the phone, the recovery key
    // stands in for the code. The old secret stays valid until the new one is confirmed.
    handle(app, ctx, routes.startTotpChange, async (req) => {
        const { body, session } = req;
        await reauth.password(req, body.password);
        if ("code" in body) reauth.code(req, body.code);
        else await withRecoveryThrottle(req.request, () => reauth.recoveryKey(req, body.recoveryKey));
        return startTotpSetup(requireUser(req.db, session.userId), null, { deviceId: session.deviceId });
    });

    handle(app, ctx, routes.confirmTotpChange, ({ db, fields, session, actor, body }) => {
        const pending = pendingTotp.get(body.setupToken);
        if (!pending || pending.expires < Date.now() || pending.deviceId !== session.deviceId) {
            throw new HttpError(401, "setup_expired", "Die Einrichtung ist abgelaufen. Bitte noch einmal beginnen.");
        }
        const step = verifyTotp(pending.secret, body.code, null);
        if (step === null) throw new HttpError(401, "wrong_code", "Der Code stimmt nicht. Stimmt die Uhrzeit auf dem Telefon?");
        pendingTotp.delete(body.setupToken);
        setTotp(db, session.userId, fields.seal(pending.secret), step);
        // Other sessions end; this one stays
        for (const id of revokeUserDevices(db, session.userId, session.deviceId)) events.signOutDevice(id);
        logActivity(db, actor, "totp_changed");
        events.changed("users", "devices", "activity");
        return { ok: true as const };
    });

    handle(app, ctx, routes.logout, ({ db, session, actor, request, reply }) => {
        const token = tokenOf(request);
        if (token) db.prepare("UPDATE devices SET revoked_at = ? WHERE token_hash = ?").run(new Date().toISOString(), hashToken(token));
        logActivity(db, actor, "logout");
        reply.clearCookie(SESSION_COOKIE, { path: "/" });
        events.signOutDevice(session.deviceId);
        events.changed("devices");
        return { ok: true as const };
    });

    handle(app, ctx, routes.me, ({ session }) => meOf(session.userId, session.userName, session.deviceId, session.idleLocked));

    handle(app, ctx, routes.lockSession, ({ session }) => {
        if (!session.idleLocked) autoLock.lockSession(session.deviceId);
        return { ok: true as const };
    });

    // Steps after a vault operation run in its callbacks: the database may be locked once it is done

    handle(app, ctx, routes.changePassword, async (req) => {
        const { session, actor, body } = req;
        // The password first: a wrong one must not use up the code
        await reauth.password(req, body.current, "Das bisherige Passwort stimmt nicht.");
        reauth.code(req, body.code);
        // Same user key, wrapped for the new password before that password takes effect
        const rewrapped = await rewrapForPassword(req.db, session.userId, body.current, body.next, vault.kdf);
        await vault.setUserPassword(body.next, {
            user: (db) => requireUser(db, session.userId),
            then: (db, user) => {
                if (rewrapped) storeRewrappedKey(db, rewrapped);
                // Other sessions of the user end; this one stays
                for (const id of revokeUserDevices(db, user.id, session.deviceId)) events.signOutDevice(id);
                logActivity(db, actor, "password_changed");
            },
        });
        events.changed("devices", "activity");
        return { ok: true as const };
    });

    // ---------- Users ----------

    handle(app, ctx, routes.listUsers, ({ db }) => listUsers(db));

    handle(app, ctx, routes.createUser, async (req) => {
        const { db, actor, body } = req;
        // A name in use costs no code
        if (findUserByName(db, body.name)) throw conflict(`Es gibt schon einen Benutzer „${body.name}“.`, "name_taken");
        reauth.code(req, body.code);
        const user = await vault.setUserPassword(body.password, {
            user: (db) => createUser(db, body.name),
            then: (db, u) => logActivity(db, actor, "user_created", u.name),
            // Without a slot in the key store the user could never sign in
            undo: (db, u) => db.prepare("DELETE FROM users WHERE id = ?").run(u.id),
        });
        events.changed("users", "activity");
        return user;
    });

    handle(app, ctx, routes.deleteUser, async (req) => {
        const { db, session, actor, params, body } = req;
        if (params.id === session.userId) throw conflict("Du kannst dich nicht selbst entfernen.", "self");
        const user = requireDeletableUser(db, params.id);
        reauth.code(req, body.code);
        // The slot goes first: a removed user's password must never open the database again
        await vault.removeUser(user.id, (open) => {
            deleteUser(open, user.id);
            logActivity(open, actor, "user_deleted", user.name);
        });
        events.signOutUser(params.id);
        events.changed("users", "devices", "activity");
        return { ok: true as const };
    });

    handle(app, ctx, routes.setUserPassword, async (req) => {
        const { db, session, actor, params, body } = req;
        // This way drops the bank logins; the own password is changed in the profile, which keeps them
        if (params.id === session.userId) throw conflict("Dein eigenes Passwort änderst du im Profil.", "self");
        requireUser(db, params.id);
        reauth.code(req, body.code);
        await vault.setUserPassword(body.password, {
            user: (db) => requireUser(db, params.id),
            then: (db, user) => {
                for (const id of revokeUserDevices(db, user.id)) events.signOutDevice(id);
                // Nobody else may open this user's bank logins: the key goes, the PIN is asked for again
                forgetUserKey(db, user.id);
                logActivity(db, actor, "password_set", user.name);
            },
        });
        events.changed("devices", "activity");
        return { ok: true as const };
    });

    handle(app, ctx, routes.resetUserTotp, async (req) => {
        const { session, actor, params, body } = req;
        if (params.id === session.userId) throw conflict("Deinen eigenen Authenticator wechselst du im Profil.", "self");
        requireUser(req.db, params.id);
        await reauth.password(req, body.password);
        // The database may have been locked while the password was checked
        const db = vault.database;
        const user = requireUser(db, params.id);
        setTotp(db, user.id, null, null);
        for (const id of revokeUserDevices(db, user.id)) events.signOutDevice(id);
        logActivity(db, actor, "totp_reset", user.name);
        events.changed("users", "devices", "activity");
        return { ok: true as const };
    });

    handle(app, ctx, routes.listDevices, ({ db, session }) => listDevices(db, session.deviceId));

    handle(app, ctx, routes.createDevice, (req) => {
        const { db, session, actor, body, request } = req;
        reauth.code(req, body.code);
        // The password was not entered for this token: its first transfer asks for it
        const { device, token } = createDevice(db, session.userId, body.name, "device", false);
        // The device token gets the user key of the session that created it
        const current = tokenOf(request);
        const userKey = current ? userKeyOfSession(db, session.deviceId, current) : null;
        if (userKey) attachUserKey(db, device.id, token, userKey);
        logActivity(db, actor, "device_created", body.name);
        events.changed("devices", "activity");
        return { device: deviceToApi(db, device.id, session.deviceId), token };
    });

    handle(app, ctx, routes.revokeDevice, ({ db, actor, params }) => {
        const name = (db.prepare("SELECT name FROM devices WHERE id = ?").get(params.id) as { name: string } | undefined)?.name ?? null;
        revokeDevice(db, params.id);
        logActivity(db, actor, "device_revoked", name);
        events.signOutDevice(params.id);
        events.changed("devices", "activity");
        return { ok: true as const };
    });
}
