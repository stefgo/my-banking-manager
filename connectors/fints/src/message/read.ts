// Reads bank messages (Formals B.7, B.8): unpacks HNVSD and collects the return codes.

import { parseSegments } from "../syntax/parse.js";
import { bytes, num, text } from "../syntax/formats.js";
import { FintsSyntaxError, type Segment } from "../syntax/types.js";
import { returnClass, returnCodes, type ReturnCode } from "../segments/common.js";

export class BankMessage {
    constructor(
        /** All segments with HNVSD unpacked and HNVSK removed. */
        readonly segments: Segment[],
        readonly dialogId: string,
        readonly messageNumber: number,
    ) {}

    find(id: string): Segment | undefined {
        return this.segments.find((s) => s.id === id);
    }

    findAll(id: string): Segment[] {
        return this.segments.filter((s) => s.id === id);
    }

    /** Return codes for the whole message (HIRMG). */
    get globalCodes(): ReturnCode[] {
        return this.findAll("HIRMG").flatMap(returnCodes);
    }

    /** Return codes for one customer segment (HIRMS with that reference), or for all. */
    segmentCodes(ref?: number): ReturnCode[] {
        return this.findAll("HIRMS")
            .filter((s) => ref === undefined || s.ref === ref)
            .flatMap(returnCodes);
    }

    get allCodes(): ReturnCode[] {
        return [...this.globalCodes, ...this.segmentCodes()];
    }

    hasCode(code: string, ref?: number): boolean {
        const codes = ref === undefined ? this.allCodes : this.segmentCodes(ref);
        return codes.some((c) => c.code === code);
    }

    /** Errors (class 9) for the whole message or for any segment. */
    get errors(): ReturnCode[] {
        return this.allCodes.filter((c) => returnClass(c.code) === "error");
    }
}

export function readMessage(data: Uint8Array): BankMessage {
    const outer = parseSegments(data);
    const head = outer[0];
    if (!head || head.id !== "HNHBK") throw new FintsSyntaxError("Message does not start with HNHBK");
    const segments: Segment[] = [];
    for (const s of outer) {
        if (s.id === "HNVSK") continue;
        if (s.id === "HNVSD") {
            const inner = bytes(s.elements[0]);
            if (inner) segments.push(...parseSegments(inner));
            continue;
        }
        segments.push(s);
    }
    return new BankMessage(segments, text(head.elements[2]), num(head.elements[3]) ?? 0);
}
