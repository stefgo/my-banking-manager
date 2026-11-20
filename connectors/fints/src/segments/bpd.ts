// Bankparameterdaten (Formals D; PIN/TAN B.8.1 for HIPINS).

import { jn, num, text } from "../syntax/formats.js";
import type { Element, Segment } from "../syntax/types.js";
import { numOr } from "./common.js";

/** Parameters of one business transaction in one version (Formals D.6). */
export interface JobParameters {
    version: number;
    maxJobs: number;
    minSignatures: number;
    /** Only meaningful for HBCI; PIN/TAN products must not evaluate it (PIN/TAN B.9.11). */
    securityClass: number;
    /** The transaction-specific parameter elements (field 5 onwards). */
    params: Element[];
}

export interface CommunicationAccess {
    /** Kommunikationsdienst: 1 T-Online, 2 TCP/IP, 3 HTTPS. */
    service: number;
    address: string;
    addressExtra: string;
    filter: string;
}

export interface PinTanInfo {
    minPinLength: number | null;
    maxPinLength: number | null;
    maxTanLength: number | null;
    userIdLabel: string;
    customerIdLabel: string;
    /** Order segment id (e.g. "HKSAL") → whether it needs a TAN. Not listed: not allowed with PIN/TAN. */
    tanRequired: Record<string, boolean>;
}

export interface BankParameters {
    version: number;
    blz: string;
    bankName: string;
    maxJobTypes: number;
    languages: number[];
    hbciVersions: string[];
    /** Upper limit in kB, null if none. */
    maxMessageSizeKb: number | null;
    communication: CommunicationAccess[];
    securityMethods: { method: string; versions: number[] }[];
    /** Present if the bank offers PIN/TAN at all (PIN/TAN B.8.1). */
    pinTan: PinTanInfo | null;
    /** Order segment id (e.g. "HKSAL", "DKKKU") → its parameters in every version the bank offers. */
    jobs: Record<string, JobParameters[]>;
}

const PARAMETER_SEGMENT = /^(HI|DI)[A-Z]{3,4}S$/;

/** Order segment id of a parameter segment: HISALS → HKSAL, DIKKUS → DKKKU. */
export function orderIdOf(parameterSegmentId: string): string | null {
    if (!PARAMETER_SEGMENT.test(parameterSegmentId) || parameterSegmentId === "HIRMS") return null;
    return parameterSegmentId.slice(0, 1) + "K" + parameterSegmentId.slice(2, -1);
}

/** Reads the BPD from a bank message; null if it carries none (no HIBPA). */
export function parseBpd(segments: Segment[]): BankParameters | null {
    const hibpa = segments.find((s) => s.id === "HIBPA");
    if (!hibpa) return null;
    const e = hibpa.elements;
    const bpd: BankParameters = {
        version: numOr(e[0], 0),
        blz: text(e[1], 1),
        bankName: text(e[2]),
        maxJobTypes: numOr(e[3], 0),
        languages: (e[4] ?? []).map((_, i) => num(e[4], i)).filter((n): n is number => n !== null),
        hbciVersions: (e[5] ?? []).map((_, i) => text(e[5], i)).filter(Boolean),
        maxMessageSizeKb: num(e[6]) || null,
        communication: [],
        securityMethods: [],
        pinTan: null,
        jobs: {},
    };

    for (const s of segments) {
        if (s.id === "HIKOM") {
            // Kreditinstitutskennung, Standardsprache, then one DEG per access
            for (const a of s.elements.slice(2)) {
                bpd.communication.push({ service: numOr(a, 0), address: text(a, 1), addressExtra: text(a, 2), filter: text(a, 3) });
            }
        } else if (s.id === "HISHV") {
            for (const m of s.elements.slice(1)) {
                bpd.securityMethods.push({ method: text(m), versions: m.slice(1).map((_, i) => numOr(m, 0, i + 1)) });
            }
        }
        const orderId = orderIdOf(s.id);
        if (!orderId) continue;
        const job = parseJobParameters(s);
        // A parameter segment we cannot read is skipped; it must not cost us the whole BPD.
        if (!job) continue;
        (bpd.jobs[orderId] ??= []).push(job);
        if (s.id === "HIPINS") bpd.pinTan = parsePinTan(job.params);
    }
    for (const list of Object.values(bpd.jobs)) list.sort((a, b) => a.version - b.version);
    return bpd;
}

/**
 * Head of a parameter segment (Formals D.6): max. jobs, min. signatures, security class, then
 * the job's parameters. Older or bank-specific segments (seen: DITLFS, DITSPS, HIWPDS, HIWPRS)
 * have no security class, so their parameters start right after the signatures.
 */
function parseJobParameters(s: Segment): JobParameters | null {
    const isNum = (e: Element | undefined) => e !== undefined && e.length === 1 && /^\d*$/.test(text(e));
    const [maxJobs, minSignatures, securityClass] = s.elements;
    if (!isNum(maxJobs) || !isNum(minSignatures)) return null;
    const hasSecurityClass = securityClass === undefined || isNum(securityClass);
    return {
        version: s.version,
        maxJobs: numOr(maxJobs, 0),
        minSignatures: numOr(minSignatures, 0),
        securityClass: hasSecurityClass ? numOr(securityClass, 0) : 0,
        params: s.elements.slice(hasSecurityClass ? 3 : 2),
    };
}

/**
 * HIPINS parameter: min/max PIN length, max TAN length, two labels, then pairs of segment id
 * and "TAN erforderlich". All of it is one DEG, so the pairs follow in the same element.
 */
function parsePinTan(params: Element[]): PinTanInfo {
    const p = params[0] ?? [];
    const tanRequired: Record<string, boolean> = {};
    for (let i = 5; i + 1 < p.length; i += 2) {
        const id = text(p, i);
        if (id) tanRequired[id] = jn(p, i + 1);
    }
    return {
        minPinLength: num(p, 0),
        maxPinLength: num(p, 1),
        maxTanLength: num(p, 2),
        userIdLabel: text(p, 3),
        customerIdLabel: text(p, 4),
        tanRequired,
    };
}

/**
 * The highest version of `orderId` that both sides support, with its parameters; null if the
 * bank does not offer it or offers no version we know.
 */
export function negotiate(bpd: BankParameters, orderId: string, supported: readonly number[]): JobParameters | null {
    const offered = bpd.jobs[orderId] ?? [];
    for (let i = offered.length - 1; i >= 0; i--) {
        if (supported.includes(offered[i]!.version)) return offered[i]!;
    }
    return null;
}
