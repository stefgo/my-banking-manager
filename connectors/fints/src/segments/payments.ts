// SEPA credit transfers (Messages C.10.2.1 HKCCS, C.10.2.9.1 HKIPZ) and the verification of payee
// (Messages – VoP 1.02, C.10.7: HKVPP/HIVPP, HKVPA).

import { bytes, num, text, toJn } from "../syntax/formats.js";
import type { Element, Segment, SegmentInput } from "../syntax/types.js";
import type { BankParameters } from "./bpd.js";
import { kti, type JobAccount } from "./jobs.js";

export const CCS_VERSIONS = [1];
export const IPZ_VERSIONS = [1, 2];

/** HKCCS v1: account (kti), SEPA descriptor, pain message. */
export const hkccs = (a: JobAccount, descriptor: string, pain: Uint8Array): SegmentInput => ({
    id: "HKCCS",
    version: 1,
    elements: [kti(a), descriptor, pain],
});

/**
 * HKIPZ v1/v2: account, descriptor, pain message; v2 adds "Umwandlung nach SEPA-Überweisung
 * zulässig", which MBM always sends as N: an instant transfer is never turned into a standard one.
 */
export const hkipz = (version: number, a: JobAccount, descriptor: string, pain: Uint8Array): SegmentInput => ({
    id: "HKIPZ",
    version,
    elements: version >= 2 ? [kti(a), descriptor, pain, toJn(false)] : [kti(a), descriptor, pain],
});

// ---------- Verification of payee ----------

export interface VopParameters {
    /** pain.002 descriptors the bank can answer with. */
    formats: string[];
    /** Segment ids of payments that need the verification, e.g. "HKCCS". */
    jobs: string[];
    /** The explanation may carry markup. */
    structured: boolean;
}

/**
 * HIVPPS v1, "Parameter Namensabgleich Prüfauftrag": max. transactions, Aufklärungstext
 * strukturiert, Art der Lieferung, Sammelzahlungen mit einem Auftrag erlaubt, Eingabe Anzahl
 * Einträge erlaubt, unterstützte Payment Status Report Datenformate, VOP-pflichtige Aufträge (n).
 * Null if the bank does not offer HKVPP (then it does not verify payees).
 */
export function vopParameters(bpd: BankParameters | null): VopParameters | null {
    const job = bpd?.jobs.HKVPP?.find((j) => j.version === 1);
    if (!job) return null;
    const p: Element = job.params[0] ?? [];
    const all = p.map((_, i) => text(p, i));
    const formats = all
        .slice(5)
        .flatMap((s) => s.split(/[;,\s]+/))
        .filter((s) => /pain\.002/.test(s));
    const jobs = all.slice(5).filter((s) => /^[A-Z]{5}$/.test(s));
    return { formats, jobs, structured: text(p, 1) === "J" };
}

/** HKVPP v1: supported payment status reports, polling ID, max. entries, touchdown. */
export const hkvpp = (formats: string[], pollingId?: Uint8Array | null, touchdown?: string | null): SegmentInput => ({
    id: "HKVPP",
    version: 1,
    elements: [formats, pollingId ?? null, null, touchdown ?? null],
});

/** HKVPA v1: the VOP-ID from HIVPP. */
export const hkvpa = (vopId: Uint8Array): SegmentInput => ({ id: "HKVPA", version: 1, elements: [vopId] });

/** Fill value for the VOP-ID of banks that give none yet (C.10.7, migration phase). */
export const VOP_ID_NOT_PROVIDED = Buffer.from("notprovided", "latin1");

export interface VopSingleResult {
    iban: string;
    /** The name the payee's bank holds (close match). */
    otherName: string;
    code: string;
    /** Why not applicable (RVNA). */
    reason: string;
}

export interface Hivpp {
    vopId: Uint8Array | null;
    pollingId: Uint8Array | null;
    /** pain.002 descriptor and message, if the bank answers that way. */
    reportDescriptor: string;
    report: Uint8Array | null;
    /** The DEG "Ergebnis VOP-Prüfung Einzeltransaktion", if the bank answers that way. */
    single: VopSingleResult | null;
    explanation: string;
    /** Seconds before the next HKVPP may be sent; null if not given. */
    waitSeconds: number | null;
}

/**
 * HIVPP v1: VOP-ID, VOP-ID gültig bis (tsp), Polling-ID, Payment Status Report Descriptor,
 * Payment Status Report, Ergebnis VOP-Prüfung Einzeltransaktion (IBAN, IBAN-Zusatz, abweichender
 * Name, anderes Merkmal, Ergebnis, Grund RVNA), Aufklärungstext, Wartezeit.
 */
export function parseHivpp(s: Segment): Hivpp {
    const e = s.elements;
    // A nested DEG (tsp) is flattened into its own element; it never moves the following ones.
    const r = e[5];
    const code = text(r, 4);
    return {
        vopId: bytes(e[0]),
        pollingId: bytes(e[2]),
        reportDescriptor: text(e[3]),
        report: bytes(e[4]),
        single: code ? { iban: text(r, 0), otherName: text(r, 2), code, reason: text(r, 5) } : null,
        explanation: text(e[6]),
        waitSeconds: num(e[7]),
    };
}

// ---------- HIIPZ ----------

/** HIIPZ v1/v2: order id, SEPA-C-Code, status of the SEPA order. */
export const parseHiipz = (s: Segment): { orderId: string; status: string } => ({ orderId: text(s.elements[0]), status: text(s.elements[2]) });
