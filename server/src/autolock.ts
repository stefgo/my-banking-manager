// Locks sessions after inactivity and the server when no active session is left.
//
// A browser session reports input over its WebSocket at most once a minute. Without input for
// `sessionIdleMinutes`, the session is locked and only the password opens it again. When no
// signed-in, unlocked window is connected any more, the server locks itself `autoLockMinutes`
// later and the data key leaves the memory.

import type { FastifyBaseLogger as Logger } from "fastify";
import type { AppContext } from "./http/route.js";
import { actorOfDevice, connectedSessionState, logActivity, setIdleLocked, type Session } from "./services/users.js";

/** The client reports input at most once a minute; the server waits that much longer. */
const REPORT_INTERVAL_MS = 60_000;
/** How often connections are pinged and the time limits checked. */
export const TICK_MS = 30_000;

export class AutoLock {
    /** Current time; tests replace it. */
    clock: () => number = Date.now;
    private readonly lastActive = new Map<number, number>();
    private emptySince: number | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly ctx: AppContext,
        private readonly log: Logger,
    ) {
        ctx.events.onChange(() => this.watchServer());
        ctx.events.onActive((deviceId) => this.lastActive.set(deviceId, this.clock()));
        ctx.vault.onLock(() => {
            this.lastActive.clear();
            this.emptySince = null;
        });
    }

    start(): void {
        this.timer = setInterval(() => this.tick(), TICK_MS);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private get idleMs(): number {
        return this.ctx.config.sessionIdleMinutes * 60_000;
    }

    /** True when the session is locked or its idle time just ran out (it is locked then). */
    isSessionLocked(session: Session): boolean {
        if (session.idleLocked) return true;
        if (session.kind !== "web" || this.idleMs === 0) return false;
        const last = this.lastActive.get(session.deviceId);
        if (last === undefined) {
            // First request since start or unlock: the time counts from now
            this.lastActive.set(session.deviceId, this.clock());
            return false;
        }
        if (this.clock() - last <= this.idleMs + REPORT_INTERVAL_MS) return false;
        this.lockSession(session.deviceId);
        return true;
    }

    lockSession(deviceId: number): void {
        const db = this.ctx.vault.database;
        setIdleLocked(db, deviceId, true);
        this.lastActive.delete(deviceId);
        logActivity(db, actorOfDevice(db, deviceId), "session_locked", null, "nach Inaktivität");
        this.ctx.events.sessionLocked(deviceId);
        this.ctx.events.changed("activity");
    }

    unlockSession(deviceId: number): void {
        setIdleLocked(this.ctx.vault.database, deviceId, false);
        this.lastActive.set(deviceId, this.clock());
    }

    /** Pings the connections, checks sessions and time limits. Runs every TICK_MS. */
    tick(): void {
        const { vault, events, config } = this.ctx;
        if (vault.state() !== "ready") return;
        events.heartbeat();
        const db = vault.database;
        const now = this.clock();
        for (const c of events.connections()) {
            const state = connectedSessionState(db, c.deviceId);
            if (state === "gone") events.signOutDevice(c.deviceId);
            else if (state === "idle_locked") events.sessionLocked(c.deviceId);
            // A session whose user waits for a fetch or a transfer (or its approval) does not lock meanwhile
            else if (c.kind === "web" && this.idleMs > 0 && !this.ctx.sync?.active(c.userId) && !this.ctx.transfers?.active(c.userId)) {
                const last = this.lastActive.get(c.deviceId);
                if (last === undefined) this.lastActive.set(c.deviceId, now);
                else if (now - last > this.idleMs + REPORT_INTERVAL_MS) this.lockSession(c.deviceId);
            }
        }
        this.watchServer();
        // The server waits for running fetches and transfers; their approval runs out after a few minutes anyway
        if (this.emptySince !== null && config.autoLockMinutes > 0 && now - this.emptySince >= config.autoLockMinutes * 60_000 && !this.ctx.sync?.active() && !this.ctx.transfers?.active()) {
            logActivity(db, { userId: null, userName: null, deviceId: null }, "lock", null, "automatisch, keine aktive Sitzung");
            this.log.info("locked automatically: no active session");
            vault.lock();
        }
    }

    /** Starts the server's time limit when the last connection is gone, stops it on a new one. */
    private watchServer(): void {
        if (this.ctx.vault.state() !== "ready" || this.ctx.events.size > 0) this.emptySince = null;
        else this.emptySince ??= this.clock();
    }
}
