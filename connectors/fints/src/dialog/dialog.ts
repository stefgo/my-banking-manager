// A personal FinTS dialog with PIN/TAN and strong customer authentication (Security PIN/TAN B.4).
//
// Every message is signed with the PIN. In the two-step method, the dialog start carries
// HKTAN process 4 for HKIDN; jobs that need a TAN (HIPINS) carry HKTAN process 4 for themselves.
// The bank then either answers right away (3076 or no SCA at all) or asks for an approval
// (0030, or 3955 alone): decoupled (3955, approve in the app, query with HKTAN process S until 3956 stops) or
// with a TAN (HKTAN process 2, TAN in the signature closing).

import { buildMessage } from "../message/build.js";
import { readMessage, type BankMessage } from "../message/read.js";
import { parseBpd } from "../segments/bpd.js";
import { hkend, hkidn, hkvvb, type Product } from "../segments/dialog.js";
import type { Signer } from "../segments/envelope.js";
import { hksyn, hktan4, hktanFollowUp, parseHisynSystemId, parseHitan, parseTanMethods, type TanMethod } from "../segments/tan.js";
import { parseUpd, updVersionToAnnounce } from "../segments/upd.js";
import type { SegmentInput } from "../syntax/types.js";
import type { Transport } from "../transport/http.js";
import type { FintsState } from "../state.js";
import { FintsSetupError, throwIfErrors } from "./errors.js";

export interface Credentials {
    blz: string;
    /** Benutzerkennung (login name). */
    userId: string;
    /** Kunden-ID, if the bank gave one that differs from the login name. */
    customerId?: string;
    pin: string;
}

export interface DialogOptions {
    transport: Transport;
    product: Product;
    credentials: Credentials;
    /** Changed in place: Kundensystem-ID, BPD, UPD and allowed methods as the bank sends them. */
    state: FintsState;
    now?: () => Date;
}

/** What the user has to do to approve. */
export interface Challenge {
    decoupled: boolean;
    /** The bank's instructions or challenge, to be shown unchanged; "" if none. */
    text: string;
    medium: string;
    /** Bank's local time "JJJJ-MM-TTThh:mm:ss", "" if not given. */
    validUntil: string;
    methodName: string;
    /** Decoupled only: the bank's hints for status queries, in seconds. */
    polling: { first: number; next: number; max: number | null } | null;
}

/** "challenge" carries the message that asked for it: it may hold more (e.g. HIVPP). */
export type ScaResult =
    | { kind: "done"; message: BankMessage; numbers: number[] }
    | { kind: "challenge"; challenge: Challenge; message: BankMessage; numbers: number[] };

interface Pending {
    orderRef: string;
    hktanVersion: number;
    challenge: Challenge;
    /** Segments that go along with every HKTAN of this approval (HKVPA). */
    followUp: SegmentInput[];
}

export class Dialog {
    dialogId = "0";
    private messageNumber = 1;
    private pending: Pending | null = null;
    private closed = false;

    constructor(
        private readonly o: DialogOptions,
        /** "999" one-step (only to find out the allowed methods), else the chosen method. */
        readonly securityFunction: string,
    ) {}

    get state(): FintsState {
        return this.o.state;
    }

    get awaitingApproval(): boolean {
        return this.pending !== null;
    }

    /** The chosen two-step method from the BPD; null in the one-step method. */
    get method(): TanMethod | null {
        if (this.securityFunction === "999" || !this.state.bpd) return null;
        return parseTanMethods(this.state.bpd).find((m) => m.securityFunction === this.securityFunction) ?? null;
    }

    /** Sends one signed message and takes over what the bank sends about itself and the user. */
    async exchange(segments: SegmentInput[], tan?: string): Promise<{ message: BankMessage; numbers: number[] }> {
        if (this.closed) throw new FintsSetupError("dialog_closed", "The dialog has ended");
        const c = this.o.credentials;
        const signer: Signer = { blz: c.blz, userId: c.userId, systemId: this.state.systemId, securityFunction: this.securityFunction };
        const built = buildMessage({
            dialogId: this.dialogId,
            messageNumber: this.messageNumber++,
            segments,
            security: { signer, pin: c.pin, tan },
            now: this.o.now?.(),
        });
        const message = readMessage(await this.o.transport.send(built.bytes));
        if (this.dialogId === "0" && message.dialogId && message.dialogId !== "0") this.dialogId = message.dialogId;
        this.absorb(message);
        return { message, numbers: built.numbers };
    }

    private absorb(m: BankMessage): void {
        const bpd = parseBpd(m.segments);
        if (bpd) this.state.bpd = bpd;
        const upd = parseUpd(m.segments);
        if (upd) this.state.upd = upd;
        const allowed = m.segmentCodes().find((c) => c.code === "3920");
        if (allowed) this.state.allowedFunctions = allowed.params.filter((p) => /^9\d\d$/.test(p));
        const hisyn = m.find("HISYN");
        if (hisyn && parseHisynSystemId(hisyn)) this.state.systemId = parseHisynSystemId(hisyn);
    }

    /**
     * Opens the dialog. `sync` adds HKSYN for a new Kundensystem-ID; `scaFor` is the segment the
     * strong authentication refers to (HKIDN, or a PIN/TAN management job such as HKTAB).
     */
    async init(opts: { sync?: boolean; scaFor?: string } = {}): Promise<ScaResult> {
        const c = this.o.credentials;
        const segments = [hkidn(c.blz, c.customerId || c.userId, this.state.systemId, true), hkvvb(this.state.bpd?.version ?? 0, updVersionToAnnounce(this.state.upd), this.o.product)];
        const tan = this.hktan(opts.scaFor ?? "HKIDN");
        if (tan) segments.push(tan);
        if (opts.sync) segments.push(hksyn());
        return this.run(segments);
    }

    /**
     * Sends jobs; adds HKTAN process 4 if the job `scaFor` (default: the first) needs a TAN
     * according to HIPINS. A payment goes after HKVPP/HKVPA, so the TAN refers to it, not to the first.
     */
    async send(segments: SegmentInput[], opts: { scaFor?: string } = {}): Promise<ScaResult> {
        const target = opts.scaFor ?? segments[0]?.id;
        const needsTan = target !== undefined && this.state.bpd?.pinTan?.tanRequired[target] === true;
        const tan = needsTan ? this.hktan(target) : null;
        return this.run(tan ? [...segments, tan] : segments);
    }

    /** Segments to send along with every HKTAN of the pending approval (VoP: HKVPA). */
    setFollowUp(segments: SegmentInput[]): void {
        this.requirePending().followUp = segments;
    }

    /** Status query of a decoupled approval (HKTAN process S). */
    async poll(): Promise<ScaResult> {
        const p = this.requirePending();
        return this.run([...p.followUp, hktanFollowUp(p.hktanVersion, "S", p.orderRef)]);
    }

    /** Hands in a TAN (HKTAN process 2, TAN in the signature closing). */
    async submitTan(tan: string): Promise<ScaResult> {
        const p = this.requirePending();
        return this.run([...p.followUp, hktanFollowUp(p.hktanVersion, "2", p.orderRef)], tan);
    }

    /** Ends the dialog; errors are ignored, the bank ends it on its own after a while. */
    async end(): Promise<void> {
        if (this.closed) return;
        try {
            if (this.dialogId !== "0") await this.exchange([hkend(this.dialogId)]);
        } catch {
            // ignored on purpose
        }
        this.closed = true;
        this.pending = null;
    }

    private hktan(segmentId: string): SegmentInput | null {
        if (this.securityFunction === "999") return null;
        const method = this.method;
        if (!method) throw new FintsSetupError("no_tan_method", "The chosen TAN method is not offered by the bank");
        const medium = method.mediumRequired > 0 ? this.state.tanMedium : "";
        return hktan4(method.hktanVersion, segmentId, medium);
    }

    private requirePending(): Pending {
        if (!this.pending) throw new FintsSetupError("no_pending_approval", "No approval is pending");
        return this.pending;
    }

    /** Sends, reads the answer; `numbers` are the segment numbers of `segments` in the message. */
    private async run(segments: SegmentInput[], tan?: string): Promise<ScaResult> {
        const { message, numbers } = await this.exchange(segments, tan);
        try {
            throwIfErrors(message.errors);
        } catch (e) {
            this.pending = null;
            throw e;
        }
        // Approval still outstanding (decoupled status query).
        if (this.pending && message.hasCode("3956")) {
            const hitan = message.find("HITAN");
            const text = hitan ? parseHitan(hitan).challenge : "";
            if (text) this.pending.challenge = { ...this.pending.challenge, text };
            return { kind: "challenge", challenge: this.pending.challenge, message, numbers };
        }
        const hitan = message.find("HITAN");
        // Some banks (Sparkasse) announce a decoupled approval with 3955 alone, without 0030.
        if ((message.hasCode("0030") || message.hasCode("3955")) && hitan) {
            const answer = parseHitan(hitan);
            const method = this.method;
            const decoupled = message.hasCode("3955") || method?.decoupled != null;
            const d = method?.decoupled;
            const challenge: Challenge = {
                decoupled,
                text: answer.challenge,
                medium: answer.medium || this.state.tanMedium,
                validUntil: answer.validUntil,
                methodName: method?.name ?? "",
                polling: decoupled ? { first: d?.firstDelay ?? 2, next: d?.nextDelay ?? 2, max: d?.maxPolls ?? null } : null,
            };
            this.pending = { orderRef: answer.orderRef, hktanVersion: hitan.version, challenge, followUp: [] };
            return { kind: "challenge", challenge, message, numbers };
        }
        this.pending = null;
        return { kind: "done", message, numbers };
    }
}
