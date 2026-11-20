import type { ReturnCode } from "../segments/common.js";
import { FintsSyntaxError } from "../syntax/types.js";
import { FintsTransportError } from "../transport/http.js";

/** The bank rejected a message or a job; `codes` are its error codes with its own text. */
export class FintsBankError extends Error {
    constructor(readonly codes: ReturnCode[]) {
        super(codes.map((c) => `${c.code} ${c.text}`).join("; ") || "The bank rejected the message");
        this.name = "FintsBankError";
    }

    has(code: string): boolean {
        return this.codes.some((c) => c.code === code);
    }
}

/** Return codes that mean: wrong PIN or access blocked (PIN/TAN B.6). The PIN must not be retried. */
export const PIN_ERROR_CODES = ["9942", "9931", "9930", "9340"];

export class FintsPinError extends FintsBankError {
    constructor(codes: ReturnCode[]) {
        super(codes);
        this.name = "FintsPinError";
    }
}

/** The connector cannot go on without input: no TAN method chosen, no system ID, … */
export class FintsSetupError extends Error {
    constructor(
        readonly reason: "no_tan_method" | "no_bpd" | "dialog_closed" | "no_pending_approval" | "nothing_to_confirm",
        message: string,
    ) {
        super(message);
        this.name = "FintsSetupError";
    }
}

/** Throws the fitting error for the error codes of a bank message, if there are any. */
export function throwIfErrors(errors: ReturnCode[]): void {
    if (errors.length === 0) return;
    if (errors.some((c) => PIN_ERROR_CODES.includes(c.code))) throw new FintsPinError(errors);
    throw new FintsBankError(errors);
}

/**
 * A payment was sent, but its answer was lost (connection, timeout, unreadable answer): the bank
 * may or may not have executed it. Never retried; the user checks the bookings.
 */
export class FintsOutcomeUnknownError extends Error {
    constructor() {
        super("The bank's answer to a payment was lost");
        this.name = "FintsOutcomeUnknownError";
    }
}

/** For payments: a lost or unreadable answer becomes "outcome unknown"; anything else stays. */
export function lostAnswer(e: unknown): unknown {
    return e instanceof FintsTransportError || e instanceof FintsSyntaxError ? new FintsOutcomeUnknownError() : e;
}
