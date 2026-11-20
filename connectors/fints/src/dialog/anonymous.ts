// Anonymous dialog (Formals C.5): fetches the bank parameters without credentials.

import { buildMessage } from "../message/build.js";
import { readMessage } from "../message/read.js";
import { parseBpd, type BankParameters } from "../segments/bpd.js";
import { ANONYMOUS_CUSTOMER_ID, hkend, hkidn, hkvvb, type Product } from "../segments/dialog.js";
import type { ReturnCode } from "../segments/common.js";
import { hktan4 } from "../segments/tan.js";
import { text } from "../syntax/formats.js";
import type { Transport } from "../transport/http.js";
import { FintsBankError } from "./errors.js";

export interface AnonymousResult {
    /** Null if the bank confirmed that `knownBpdVersion` is current. */
    bpd: BankParameters | null;
    codes: ReturnCode[];
    /** Messages of the bank to its customers (HIKIM): subject and text. */
    notices: { subject: string; text: string }[];
}

export interface AnonymousOptions {
    blz: string;
    product: Product;
    transport: Transport;
    /** BPD version the caller already has; 0 = none. */
    knownBpdVersion?: number;
}

export async function fetchBankParameters(o: AnonymousOptions): Promise<AnonymousResult> {
    const init = buildMessage({
        dialogId: "0",
        messageNumber: 1,
        // HKTAN (from version 6) signals that we support strong authentication (PIN/TAN B.4.3.1).
        segments: [hkidn(o.blz, ANONYMOUS_CUSTOMER_ID, "0", false), hkvvb(o.knownBpdVersion ?? 0, 0, o.product), hktan4(6, "HKIDN")],
    });
    const answer = readMessage(await o.transport.send(init.bytes));
    if (answer.errors.length > 0) throw new FintsBankError(answer.errors);

    const result: AnonymousResult = {
        bpd: parseBpd(answer.segments),
        codes: answer.allCodes,
        notices: answer.findAll("HIKIM").map((s) => ({ subject: text(s.elements[0]), text: text(s.elements[1]) })),
    };

    // End the dialog; a failure here does not invalidate what we already received.
    try {
        await o.transport.send(buildMessage({ dialogId: answer.dialogId, messageNumber: 2, segments: [hkend(answer.dialogId)] }).bytes);
    } catch {
        // ignored on purpose
    }
    return result;
}
