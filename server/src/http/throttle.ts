// Throttling of failed sign-ins per key (client address and name). Lives in memory only.

import { HttpError } from "./errors.js";

/** Failures before waiting starts. */
export const MAX_FAILURES = 5;
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 15 * 60_000;
/** An entry is forgotten this long after its last failure, once its wait is over. */
const FORGET_AFTER_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

interface Entry {
    count: number;
    /** Tries under way: they count as failures until they are done. */
    pending: number;
    until: number;
    last: number;
}

export class Throttle {
    private readonly entries = new Map<string, Entry>();
    private lastSweep = 0;

    constructor(
        private readonly clock: () => number = Date.now,
        private readonly maxEntries = 10_000,
    ) {}

    get size(): number {
        return this.entries.size;
    }

    /**
     * Reserves a try for `key` or throws 429. Returns the release, called once the try is done
     * (after `fail` or `succeed`). Tries sent at the same time can thus never get more than the
     * allowed number of guesses: below the limit, as many as are left; while waiting, none; after
     * the wait, one at a time.
     */
    begin(key: string): () => void {
        const now = this.clock();
        this.sweep(now);
        let e = this.entries.get(key);
        if (e && e.until > now) {
            const seconds = Math.ceil((e.until - now) / 1000);
            throw new HttpError(429, "throttled", `Zu viele Fehlversuche. Bitte in ${seconds} Sekunden noch einmal.`);
        }
        const allowed = e && e.count >= MAX_FAILURES ? 1 : MAX_FAILURES - (e?.count ?? 0);
        if (e && e.pending >= allowed) throw new HttpError(429, "throttled", "Zu viele Anmeldeversuche auf einmal. Bitte gleich noch einmal.");
        if (!e) {
            e = { count: 0, pending: 0, until: 0, last: now };
            this.entries.set(key, e);
        }
        const entry = e;
        entry.pending++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            entry.pending--;
            if (this.entries.get(key) === entry && entry.pending === 0 && entry.count === 0) this.entries.delete(key);
        };
    }

    fail(key: string): void {
        const now = this.clock();
        const e = this.entries.get(key) ?? { count: 0, pending: 0, until: 0, last: now };
        e.count++;
        e.last = now;
        // From the fifth failure on, wait 30 s, then twice as long each time, at most 15 minutes
        if (e.count >= MAX_FAILURES) e.until = now + Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** (e.count - MAX_FAILURES));
        this.entries.set(key, e);
    }

    succeed(key: string): void {
        this.entries.delete(key);
    }

    /** Forgets old entries and, beyond the limit, the oldest ones; at most once a minute. */
    private sweep(now: number): void {
        if (now - this.lastSweep < SWEEP_INTERVAL_MS && this.entries.size <= this.maxEntries) return;
        this.lastSweep = now;
        for (const [k, e] of this.entries) {
            if (e.pending === 0 && e.until <= now && now - e.last > FORGET_AFTER_MS) this.entries.delete(k);
        }
        // Map order is insertion order: the first entries are the oldest. Entries that make a
        // client wait go last, so flooding the map does not end a wait.
        for (const waiting of [false, true]) {
            for (const [k, e] of this.entries) {
                if (this.entries.size <= this.maxEntries) return;
                if (e.pending === 0 && e.until > now === waiting) this.entries.delete(k);
            }
        }
    }
}
