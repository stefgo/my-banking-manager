// What the connector hands back to the server after each call and gets again with the next one.
// The server stores it encrypted (AES-256-GCM, detects changes); the connector keeps nothing.

import type { BankParameters } from "./segments/bpd.js";
import type { UserParameters } from "./segments/upd.js";

export const STATE_FORMAT = 1;

export interface FintsState {
    format: typeof STATE_FORMAT;
    /** Kundensystem-ID; "0" until the synchronisation. */
    systemId: string;
    /** Chosen two-step method ("900"–"997"); "999" until one is chosen. */
    securityFunction: string;
    /** Chosen TAN medium (name), "" if none is needed. */
    tanMedium: string;
    /** Methods the bank allows this user (return code 3920). */
    allowedFunctions: string[];
    bpd: BankParameters | null;
    upd: UserParameters | null;
}

export const emptyState = (): FintsState => ({
    format: STATE_FORMAT,
    systemId: "0",
    securityFunction: "999",
    tanMedium: "",
    allowedFunctions: [],
    bpd: null,
    upd: null,
});

export const serializeState = (s: FintsState): string => JSON.stringify(s);

/**
 * Reads a state handed in by the server. Anything unknown (other format, broken JSON) gives an
 * empty state: the connector then synchronises again instead of failing.
 */
export function parseState(raw: string | null | undefined): FintsState {
    if (!raw) return emptyState();
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch {
        return emptyState();
    }
    if (!isObject(v) || v.format !== STATE_FORMAT) return emptyState();
    const s = emptyState();
    if (typeof v.systemId === "string" && v.systemId) s.systemId = v.systemId;
    if (typeof v.securityFunction === "string" && /^9\d\d$/.test(v.securityFunction)) s.securityFunction = v.securityFunction;
    if (typeof v.tanMedium === "string") s.tanMedium = v.tanMedium;
    if (Array.isArray(v.allowedFunctions)) s.allowedFunctions = v.allowedFunctions.filter((f): f is string => typeof f === "string");
    if (isObject(v.bpd) && typeof v.bpd.version === "number" && isObject(v.bpd.jobs)) s.bpd = v.bpd as unknown as BankParameters;
    if (isObject(v.upd) && typeof v.upd.version === "number" && Array.isArray(v.upd.accounts)) s.upd = v.upd as unknown as UserParameters;
    return s;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
