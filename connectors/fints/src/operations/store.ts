// Operations waiting for the user: an approval (pushTAN, TAN) or, for a payment whose payee name
// differs, the user's confirmation. They live only in memory; a restart loses them and the
// server reports them as expired (payments: outcome unknown). The PIN lives here as long as the
// dialog does.

import { randomUUID } from "node:crypto";
import type { ConnectorVop } from "@mbm/shared";
import type { Challenge, Dialog, ScaResult } from "../dialog/dialog.js";

export interface Operation {
    id: string;
    /** What it is for, e.g. "accounts"; for status reports. */
    kind: string;
    /** A payment: lost answers mean "outcome unknown". */
    payment: boolean;
    expiresAt: number;
    dialog: Dialog;
    /** The approval the bank asks for; null while a payment waits for the user's confirmation. */
    challenge: Challenge | null;
    /** Payments: the result of the verification of payee. */
    vop: ConnectorVop | null;
    /** Earliest time for the next status query of a decoupled approval. */
    nextPollAt: number;
    /** Resumes the waiting job: with the bank's answer after an approval, null after a confirmation. */
    resume: (r: ScaResult | null) => void;
    /** Aborts the waiting job. */
    abort: (e: unknown) => void;
    /** Serialises requests for the same operation. */
    lock: Promise<unknown>;
    /** Requests under way (or queued) with the bank; while there are any, the operation never expires. */
    busy: number;
}

export const DEFAULT_TTL_MS = 5 * 60_000;

export class OperationStore {
    private readonly ops = new Map<string, Operation>();
    private readonly timer: NodeJS.Timeout;

    constructor(
        readonly ttlMs = DEFAULT_TTL_MS,
        readonly clock: () => number = Date.now,
    ) {
        this.timer = setInterval(() => void this.sweep(), 15_000);
        this.timer.unref();
    }

    add(op: Omit<Operation, "id" | "expiresAt" | "lock" | "busy">): Operation {
        const full: Operation = { ...op, id: randomUUID(), expiresAt: this.clock() + this.ttlMs, lock: Promise.resolve(), busy: 0 };
        this.ops.set(full.id, full);
        return full;
    }

    /**
     * The operation, or undefined if unknown or expired (an expired one is removed and ended). One
     * whose request is with the bank stays until the bank has answered (a TAN may be on its way).
     */
    get(id: string): Operation | undefined {
        const op = this.ops.get(id);
        if (op && op.expiresAt <= this.clock() && op.busy === 0) {
            void this.remove(id, new Error("expired"));
            return undefined;
        }
        return op;
    }

    /** True while `op` is still the registered operation (not finished, detached or removed). */
    holds(op: Operation): boolean {
        return this.ops.get(op.id) === op;
    }

    /** Forgets the operation without touching its dialog (the job goes on with it). */
    detach(id: string): void {
        this.ops.delete(id);
    }

    /** Removes the operation, aborts its job and ends its dialog. */
    async remove(id: string, reason: unknown = new Error("cancelled")): Promise<void> {
        const op = this.ops.get(id);
        if (!op) return;
        this.ops.delete(id);
        op.abort(reason);
        await op.dialog.end();
    }

    async sweep(): Promise<void> {
        const now = this.clock();
        await Promise.all([...this.ops.values()].filter((o) => o.expiresAt <= now && o.busy === 0).map((o) => this.remove(o.id, new Error("expired"))));
    }

    get size(): number {
        return this.ops.size;
    }

    async close(): Promise<void> {
        clearInterval(this.timer);
        await Promise.all([...this.ops.keys()].map((id) => this.remove(id)));
    }
}
