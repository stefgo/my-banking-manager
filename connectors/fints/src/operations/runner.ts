// Runs a job in a dialog so that it can pause for the user and go on later.
//
// The job is plain async code: it calls `send(segments)` and gets the bank's answer. When the
// bank asks for an approval, `send` waits, the runner registers an operation and the HTTP call
// answers "approval". A later status query (or TAN) hands the bank's answer to the waiting
// `send`; the job continues and either finishes or pauses again. Payments use `io` instead: they
// look at the answer that carries the challenge (verification of payee) and may pause for the
// user's confirmation ("confirm") before the bank asks for the approval.

import type { ConnectorVop } from "@mbm/shared";
import type { BankMessage } from "../message/read.js";
import type { Challenge, Dialog, DialogOptions, ScaResult } from "../dialog/dialog.js";
import { openDialog } from "../dialog/session.js";
import { FintsBankError, FintsOrderChangedError, FintsOutcomeUnknownError, FintsSetupError } from "../dialog/errors.js";
import { FintsNotSupportedError } from "../jobs/jobs.js";
import type { SegmentInput } from "../syntax/types.js";
import type { Operation, OperationStore } from "./store.js";
import { serializeState } from "../state.js";

export type Outcome<T> =
    | { status: "done"; data: T; state: string }
    | { status: "approval"; operationId: string; challenge: Challenge; vop?: ConnectorVop }
    | { status: "confirm"; operationId: string; vop: ConnectorVop };

export interface JobIo {
    /** Sends segments and returns the answer, also one that asks for an approval. */
    exchange(segments: SegmentInput[], opts?: { scaFor?: string }): Promise<ScaResult>;
    /**
     * Waits until the approval `r` asks for is given (at once if it asks for none) and returns the
     * bank's final answer. `vop` is reported with the approval; `followUp` goes with every HKTAN.
     */
    approve(r: ScaResult, extra?: { vop?: ConnectorVop; followUp?: SegmentInput[] }): Promise<BankMessage>;
    /** Pauses until the user confirms; cancelling aborts the job. */
    confirm(vop: ConnectorVop): Promise<void>;
}

export type Job<T> = (send: (segments: SegmentInput[]) => Promise<BankMessage>, dialog: Dialog, io: JobIo) => Promise<T>;

/** One running job: whoever waits for its next step (finished, approval, confirmation, error). */
interface Run {
    waiter: { resolve: (o: Outcome<unknown>) => void; reject: (e: unknown) => void } | null;
}

const nextStep = (run: Run): Promise<Outcome<unknown>> => new Promise((resolve, reject) => (run.waiter = { resolve, reject }));

function emit(run: Run, o: Outcome<unknown> | { error: unknown }): void {
    const w = run.waiter;
    run.waiter = null;
    if (!w) return;
    if ("error" in o) w.reject(o.error);
    else w.resolve(o);
}

export class JobRunner {
    private readonly runs = new Map<string, Run>();

    constructor(private readonly store: OperationStore) {}

    async run<T>(o: DialogOptions, kind: string, job: Job<T>, scaFor = "HKIDN", opts: { payment?: boolean } = {}): Promise<Outcome<T>> {
        const run: Run = { waiter: null };
        const first = nextStep(run);
        const payment = opts.payment === true;

        // Registers the operation and reports what it waits for: an approval, or (challenge null) a confirmation.
        const pause = (dialog: Dialog, challenge: Challenge | null, vop: ConnectorVop | null): Promise<ScaResult | null> =>
            new Promise<ScaResult | null>((resume, abort) => {
                const nextPollAt = this.store.clock() + (challenge?.polling?.first ?? 0) * 1000;
                const op = this.store.add({ kind, payment, dialog, challenge, vop, nextPollAt, resume, abort });
                this.runs.set(op.id, run);
                emit(run, challenge ? { status: "approval", operationId: op.id, challenge, ...(vop ? { vop } : {}) } : { status: "confirm", operationId: op.id, vop: vop! });
            });

        const untilDone = async (dialog: Dialog, r: ScaResult, vop: ConnectorVop | null = null): Promise<BankMessage> => {
            while (r.kind === "challenge") r = (await pause(dialog, r.challenge, vop))!;
            return r.message;
        };

        void (async () => {
            let dialog: Dialog | null = null;
            try {
                const opened = await openDialog(o, scaFor);
                const d = (dialog = opened.dialog);
                await untilDone(d, opened.result);
                const io: JobIo = {
                    exchange: (segments, x) => d.send(segments, x),
                    approve: (r, x = {}) => {
                        if (r.kind === "challenge" && x.followUp?.length) d.setFollowUp(x.followUp);
                        return untilDone(d, r, x.vop ?? null);
                    },
                    confirm: async (vop) => void (await pause(d, null, vop)),
                };
                const data = await job(async (segments) => untilDone(d, await d.send(segments)), d, io);
                await d.end();
                emit(run, { status: "done", data, state: serializeState(o.state) });
            } catch (error) {
                await dialog?.end();
                emit(run, { error });
            }
        })();

        return first as Promise<Outcome<T>>;
    }

    /**
     * Status of an operation. Hands in the TAN, or queries the bank if the approval is decoupled
     * and a query is due; once approved, waits for the job's next step. Undefined if unknown.
     */
    async advance(id: string, tan?: string): Promise<Outcome<unknown> | undefined> {
        const op = this.store.get(id);
        const run = this.runs.get(id);
        if (!op || !run) return undefined;
        const step = op.lock.then(async (): Promise<Outcome<unknown> | undefined> => {
            // Finished by an earlier request meanwhile
            if (!this.store.holds(op)) return undefined;
            const challenge = op.challenge;
            if (!challenge) return { status: "confirm", operationId: op.id, vop: op.vop! };
            const waiting: Outcome<unknown> = { status: "approval", operationId: op.id, challenge, ...(op.vop ? { vop: op.vop } : {}) };
            let r: ScaResult;
            if (tan !== undefined) r = await op.dialog.submitTan(tan);
            else if (challenge.decoupled && this.store.clock() >= op.nextPollAt) r = await op.dialog.poll();
            else return waiting;
            if (r.kind === "challenge") {
                op.challenge = r.challenge;
                op.nextPollAt = this.store.clock() + (r.challenge.polling?.next ?? 2) * 1000;
                return { ...waiting, challenge: r.challenge };
            }
            // Approved: the job goes on with the dialog; its next step answers this call.
            return this.resume(id, run, () => op.resume(r));
        });
        return this.settle(op, step);
    }

    /** Goes on with a payment the user confirmed despite a differing payee name. */
    async confirm(id: string): Promise<Outcome<unknown> | undefined> {
        const op = this.store.get(id);
        const run = this.runs.get(id);
        if (!op || !run) return undefined;
        const step = op.lock.then(async (): Promise<Outcome<unknown> | undefined> => {
            if (!this.store.holds(op)) return undefined;
            if (op.challenge) throw new FintsSetupError("nothing_to_confirm", "The operation waits for an approval, not a confirmation");
            return this.resume(id, run, () => op.resume(null));
        });
        return this.settle(op, step);
    }

    /**
     * Ends the operation. A request already with the bank (a TAN, a status query) is answered
     * first: cancelling never cuts it off. False if the operation is unknown or finished meanwhile.
     */
    async cancel(id: string): Promise<boolean> {
        const op = this.store.get(id);
        if (!op) return false;
        for (let lock = op.lock; ; lock = op.lock) {
            await lock;
            if (op.lock === lock) break;
        }
        if (!this.store.holds(op)) return false;
        this.runs.delete(id);
        await this.store.remove(id);
        return true;
    }

    private resume(id: string, run: Run, go: () => void): Promise<Outcome<unknown>> {
        const next = nextStep(run);
        this.store.detach(id);
        this.runs.delete(id);
        go();
        return next;
    }

    /** Waits for a request on `op`; while it runs, the operation neither expires nor ends. */
    private async settle(op: Operation, step: Promise<Outcome<unknown> | undefined>): Promise<Outcome<unknown> | undefined> {
        op.lock = step.catch(() => undefined);
        op.busy++;
        try {
            return await step;
        } catch (e) {
            if (e instanceof FintsSetupError && e.reason === "nothing_to_confirm") throw e;
            this.runs.delete(op.id);
            await this.store.remove(op.id, e);
            // A payment is with the bank: whatever is not the bank's own answer leaves the outcome open.
            // Checks before anything was sent (an order listed first, then compared) stay what they are.
            const known = e instanceof FintsBankError || e instanceof FintsOutcomeUnknownError || e instanceof FintsOrderChangedError || e instanceof FintsNotSupportedError;
            throw op.payment && !known ? new FintsOutcomeUnknownError() : e;
        } finally {
            op.busy--;
        }
    }
}
