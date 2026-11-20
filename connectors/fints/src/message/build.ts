// Builds customer messages (Formals B.6, B.8; PIN/TAN B.9).
//
// Unsigned (anonymous): HNHBK, segments, HNHBS.
// Signed (PIN/TAN):     HNHBK, HNVSK(998), HNVSD(999)[HNSHK, segments, HNSHA], HNHBS.
// Numbering is continuous as before "encryption": HNHBK 1, HNSHK 2, segments 3…, HNSHA, HNHBS.

import { randomInt } from "node:crypto";
import { serializeSegment, toWire } from "../syntax/serialize.js";
import type { SegmentInput } from "../syntax/types.js";
import { hnhbk, hnhbs, hnsha, hnshk, hnvsd, hnvsk, type Signer } from "../segments/envelope.js";

export interface Security {
    signer: Signer;
    pin: string;
    /** Only for the one-step method; two-step TANs go into HKTAN (PIN/TAN B.9.7). */
    tan?: string;
}

export interface OutgoingMessage {
    /** "0" for the dialog initialisation, then the ID the bank assigned. */
    dialogId: string;
    messageNumber: number;
    segments: SegmentInput[];
    security?: Security;
    /** For tests: fixed time and Sicherheitskontrollreferenz. */
    now?: Date;
    controlRef?: string;
}

export interface BuiltMessage {
    bytes: Buffer;
    /** Segment number of each payload segment, in order; the bank refers to them in HIRMS. */
    numbers: number[];
}

export function buildMessage(m: OutgoingMessage): BuiltMessage {
    const now = m.now ?? new Date();
    const numbered = (s: SegmentInput, number: number) => serializeSegment({ ...s, number });

    let body: string;
    let last: number;
    const numbers: number[] = [];
    if (m.security) {
        const controlRef = m.controlRef ?? String(randomInt(1_000_000, 10_000_000));
        let n = 2;
        let inner = numbered(hnshk(m.security.signer, controlRef, now), n++);
        for (const s of m.segments) {
            numbers.push(n);
            inner += numbered(s, n++);
        }
        inner += numbered(hnsha(controlRef, m.security.pin, m.security.tan), n);
        last = n;
        body =
            serializeSegment({ ...hnvsk(m.security.signer, now), number: 998 }) +
            serializeSegment({ ...hnvsd(toWire(inner)), number: 999 });
    } else {
        let n = 2;
        body = "";
        for (const s of m.segments) {
            numbers.push(n);
            body += numbered(s, n++);
        }
        last = n - 1;
    }
    const tail = numbered(hnhbs(m.messageNumber), last + 1);
    // The size field has a fixed width, so the size does not depend on its own value.
    const headLength = numbered(hnhbk(0, m.dialogId, m.messageNumber), 1).length;
    const size = headLength + body.length + tail.length;
    const text = numbered(hnhbk(size, m.dialogId, m.messageNumber), 1) + body + tail;
    return { bytes: toWire(text), numbers };
}
