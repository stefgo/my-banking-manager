// Confirmation of sensitive steps by the signed-in user: the current TOTP code or the password.
// Wrong codes and passwords of a session count together, also wrong passwords when unlocking
// it; the fifth signs the session out. The counters live in memory only.

import type { FastifyReply } from "fastify";
import type { Db } from "../db/database.js";
import { verifyTotp, type FieldCipher } from "../crypto/secrets.js";
import { logActivity, requireUser, revokeDevice, setTotpLastStep, type Actor } from "../services/users.js";
import type { Vault } from "../vault.js";
import type { EventHub } from "./events.js";
import { HttpError } from "./errors.js";

/** Wrong codes or passwords of a session; the fifth signs it out. */
export const MAX_SESSION_FAILURES = 5;

/** The signed-in session a confirmation belongs to. */
export interface ReauthRequest {
    db: Db;
    fields: FieldCipher;
    session: { userId: number; userName: string; deviceId: number };
    actor: Actor;
    reply: FastifyReply;
}

export class Reauth {
    private readonly failures = new Map<number, number>();

    constructor(
        private readonly vault: Vault,
        private readonly events: EventHub,
        private readonly clearSession: (reply: FastifyReply) => void,
    ) {}

    /**
     * Counts a wrong code or password of a session. The fifth signs the session out and throws
     * 401 `signed_out`; before that it returns and the caller throws its own error.
     */
    countFailure(db: Db, session: { userId: number; userName: string; deviceId: number }, reply: FastifyReply): void {
        const count = (this.failures.get(session.deviceId) ?? 0) + 1;
        if (count < MAX_SESSION_FAILURES) {
            this.failures.set(session.deviceId, count);
            return;
        }
        this.failures.delete(session.deviceId);
        revokeDevice(db, session.deviceId);
        logActivity(db, { userId: session.userId, userName: session.userName, deviceId: session.deviceId }, "logout", null, "nach fünf Fehlversuchen");
        this.clearSession(reply);
        this.events.signOutDevice(session.deviceId);
        this.events.changed("devices", "activity");
        throw new HttpError(401, "signed_out", "Zu viele Fehlversuche. Bitte neu anmelden.");
    }

    /** The session entered a right code or password: its count starts again. */
    succeeded(deviceId: number): void {
        this.failures.delete(deviceId);
    }

    /** Checks the signed-in user's password; throws 401 `wrong_password` (or `signed_out`). */
    async password(req: ReauthRequest, password: string, message = "Das Passwort stimmt nicht."): Promise<void> {
        if (await this.vault.checkPassword(req.session.userId, password)) {
            this.succeeded(req.session.deviceId);
            return;
        }
        // The database may have been locked while the key was derived: then this throws 423
        const db = this.vault.database;
        logActivity(db, req.actor, "reauth_failed", "Passwort");
        this.events.changed("activity");
        this.countFailure(db, req.session, req.reply);
        throw new HttpError(401, "wrong_password", message);
    }

    /** Checks the recovery key in place of a code; throws 401 `wrong_recovery_key` (or `signed_out`). */
    async recoveryKey(req: ReauthRequest, recoveryKey: string): Promise<void> {
        if (await this.vault.checkRecoveryKey(recoveryKey)) {
            this.succeeded(req.session.deviceId);
            return;
        }
        // The database may have been locked while the key was derived: then this throws 423
        const db = this.vault.database;
        logActivity(db, req.actor, "reauth_failed", "Wiederherstellungsschlüssel");
        this.events.changed("activity");
        this.countFailure(db, req.session, req.reply);
        throw new HttpError(401, "wrong_recovery_key", "Der Wiederherstellungsschlüssel stimmt nicht.");
    }

    /**
     * Checks the signed-in user's current TOTP code; a code works only once. A code used before
     * does not count as a failure: whoever just signed in waits for the next one.
     */
    code(req: ReauthRequest, code: string): void {
        const { db, session } = req;
        const user = requireUser(db, session.userId);
        if (!user.totp_secret) throw new HttpError(409, "totp_missing", "Bitte zuerst die Authenticator-App einrichten: abmelden und neu anmelden.");
        const secret = req.fields.open(user.totp_secret);
        const step = verifyTotp(secret, code, user.totp_last_step);
        if (step !== null) {
            setTotpLastStep(db, user.id, step);
            this.succeeded(session.deviceId);
            return;
        }
        if (user.totp_last_step !== null && verifyTotp(secret, code, null) !== null) {
            throw new HttpError(401, "code_used", "Dieser Code wurde schon verwendet. Bitte den nächsten Code abwarten.");
        }
        logActivity(db, req.actor, "reauth_failed", "Code");
        this.events.changed("activity");
        this.countFailure(db, session, req.reply);
        throw new HttpError(401, "wrong_code", "Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.");
    }
}
