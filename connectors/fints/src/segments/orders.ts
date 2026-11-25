// Orders the bank holds: standing orders (Messages C.10.2.3) and scheduled transfers (C.10.2.2).
// Listing (HKCDB, HKCSB), and writing: HKCSE/HKCSA/HKCSL, HKCDE/HKCDN/HKCDL with their parameters.

import type { ConnectorOrderRules, ConnectorRecurrence, OrderLeadTime, StandingOrderRules } from "@mbm/shared";
import { bytes, jn, num, text, toDat } from "../syntax/formats.js";
import { FintsSyntaxError, type Element, type Segment, type SegmentInput } from "../syntax/types.js";
import { negotiate, type BankParameters, type JobParameters } from "./bpd.js";
import { kti, type JobAccount } from "./jobs.js";

export const CDB_VERSIONS = [1];
export const CSB_VERSIONS = [1, 2];

const PAIN_001 = /pain\.001\.\d{3}\.\d{2}/;

/**
 * The descriptors of the "SEPA Überweisung Kunde-Bank" formats the bank supports, in its
 * spelling. Formats named in the job's own parameters replace the global list of HISPAS
 * (Data Dictionary, „Unterstützte SEPA-Datenformate“).
 */
export function painFormats(bpd: BankParameters, job?: JobParameters): string[] {
    const of = (params: Element[] | undefined) => (params?.[0] ?? []).map((_, i) => text(params![0], i)).filter((d) => PAIN_001.test(d));
    const own = of(job?.params);
    return own.length > 0 ? own : of(bpd.jobs.HKSPA?.at(-1)?.params);
}

/** HKCDB v1: account, supported pain messages, order id, max. entries, touchdown. */
export const hkcdb = (a: JobAccount, formats: string[], touchdown?: string): SegmentInput => ({
    id: "HKCDB",
    version: 1,
    elements: [kti(a), formats, null, null, touchdown ?? null],
});

/** HKCSB v1/v2: account, supported pain messages, from, to, max. entries, touchdown. */
export const hkcsb = (version: number, a: JobAccount, formats: string[], touchdown?: string): SegmentInput => ({
    id: "HKCSB",
    version,
    elements: [kti(a), formats, null, null, null, touchdown ?? null],
});

export interface StandingOrderSegment {
    /** The SEPA descriptor of the pain message: a change or deletion must use the same one. */
    descriptor: string;
    /** The Dauerauftragdetails as the bank sent them; a deletion sends them back unchanged. */
    details: Element;
    pain: Uint8Array | null;
    orderId: string | null;
    firstDate: string | null;
    unit: "month" | "week" | null;
    every: number | null;
    executionDay: number | null;
    lastDate: string | null;
    canChange: boolean | null;
    canDelete: boolean | null;
}

/**
 * HICDB v1: account, descriptor, pain message, order id, Dauerauftragdetails (first execution,
 * unit M/W, interval, day, last execution), Aussetzung, changeable, suspendable, deletable.
 */
export function parseHicdb(s: Segment): StandingOrderSegment {
    const e = s.elements;
    const d = e[4];
    const unit = text(d, 1);
    return {
        descriptor: text(e[1]),
        details: d ?? [],
        pain: bytes(e[2]),
        orderId: text(e[3]) || null,
        firstDate: vdat(d, 0),
        unit: unit === "M" ? "month" : unit === "W" ? "week" : null,
        every: num(d, 2),
        executionDay: num(d, 3),
        lastDate: vdat(d, 4),
        canChange: flag(e[6]),
        canDelete: flag(e[8]),
    };
}

export interface ScheduledTransferSegment {
    descriptor: string;
    pain: Uint8Array | null;
    orderId: string | null;
    canChange: boolean | null;
    canDelete: boolean | null;
}

/**
 * HICSB: account, descriptor, pain message, order id, then v1: deletable, changeable;
 * v2: SEPA-C-Code, changeable, status.
 */
export function parseHicsb(s: Segment): ScheduledTransferSegment {
    const e = s.elements;
    return { descriptor: text(e[1]), pain: bytes(e[2]), orderId: text(e[3]) || null, canChange: flag(e[5]), canDelete: s.version === 1 ? flag(e[4]) : null };
}

/** An optional jn: null if the bank left it out. */
const flag = (el: Element | undefined): boolean | null => (text(el) === "" ? null : text(el) === "J");

/**
 * Format vdat: a date that need not exist in the calendar (the 30th of February for an order
 * that runs on the 30th). Such a day is moved to the last day of its month.
 */
function vdat(el: Element | undefined, i: number): string | null {
    const t = text(el, i);
    if (t === "") return null;
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) throw new FintsSyntaxError(`Not a date: ${t}`);
    const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return `${m[1]}-${m[2]}-${String(Math.min(Number(m[3]), lastDay)).padStart(2, "0")}`;
}

// ---------- Writing ----------

export const CSE_VERSIONS = [1];
export const CSA_VERSIONS = [1];
export const CSL_VERSIONS = [1];
export const CDE_VERSIONS = [1];
export const CDN_VERSIONS = [1];
export const CDL_VERSIONS = [1];

/**
 * Dauerauftragdetails v3: first execution, unit M/W, interval, day, last execution. `firstAsListed`
 * is the first date as the bank wrote it (format vdat, e.g. 20250230), sent back unchanged when the
 * first date stays.
 */
const details = (r: ConnectorRecurrence, firstAsListed?: string): (string | number | null)[] => [
    firstAsListed ?? toDat(r.firstDate),
    r.unit === "month" ? "M" : "W",
    r.every,
    r.executionDay,
    r.lastDate ? toDat(r.lastDate) : null,
];

/** HKCSE v1: account, descriptor, pain message (with the execution date in it). */
export const hkcse = (a: JobAccount, descriptor: string, pain: Uint8Array): SegmentInput => ({ id: "HKCSE", version: 1, elements: [kti(a), descriptor, pain] });

/** HKCSA v1: account, descriptor, the complete new pain message, order id. */
export const hkcsa = (a: JobAccount, descriptor: string, pain: Uint8Array, orderId: string): SegmentInput => ({ id: "HKCSA", version: 1, elements: [kti(a), descriptor, pain, orderId] });

/** HKCSL v1: account, descriptor and pain message (if the bank wants them), order id. */
export const hkcsl = (a: JobAccount, data: { descriptor: string; pain: Uint8Array } | null, orderId: string): SegmentInput => ({
    id: "HKCSL",
    version: 1,
    elements: [kti(a), data?.descriptor ?? null, data?.pain ?? null, orderId],
});

/** HKCDE v1: account, descriptor, pain message, Dauerauftragdetails. */
export const hkcde = (a: JobAccount, descriptor: string, pain: Uint8Array, r: ConnectorRecurrence): SegmentInput => ({ id: "HKCDE", version: 1, elements: [kti(a), descriptor, pain, details(r)] });

/** HKCDN v1: account, descriptor, pain, execution date (only for scheduled changes; never sent), order id, details. */
export const hkcdn = (a: JobAccount, descriptor: string, pain: Uint8Array, orderId: string, r: ConnectorRecurrence, firstAsListed?: string): SegmentInput => ({
    id: "HKCDN",
    version: 1,
    elements: [kti(a), descriptor, pain, null, orderId, details(r, firstAsListed)],
});

/**
 * HKCDL v1: account, descriptor and pain (if the bank wants them), date (only for scheduled
 * deletions; never sent), order id, the Dauerauftragdetails exactly as the bank listed them.
 */
export const hkcdl = (a: JobAccount, data: { descriptor: string; pain: Uint8Array } | null, orderId: string, listedDetails: Element): SegmentInput => ({
    id: "HKCDL",
    version: 1,
    elements: [kti(a), data?.descriptor ?? null, data?.pain ?? null, null, orderId, listedDetails],
});

/** HICSE, HICDE: the order identification of the new order, if the bank gives one. HICSA, HICDN: the new one first. */
export const parseOrderId = (s: Segment): string | null => text(s.elements[0]) || null;

// ---------- Parameters ----------

/** A chain of two-digit numbers ("0102030612") as numbers. */
export function twoDigitList(chain: string): number[] {
    const out: number[] = [];
    for (let i = 0; i + 1 < chain.length; i += 2) {
        const n = Number(chain.slice(i, i + 2));
        if (Number.isInteger(n) && n > 0) out.push(n);
    }
    return out;
}

/** A chain of single digits ("12345") as numbers (Ausführungstage pro Woche). */
const digitList = (chain: string): number[] => [...chain].map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);

const lead = (p: Element, i: number): OrderLeadTime => ({ minDays: num(p, i) ?? 0, maxDays: num(p, i + 1) ?? 0 });

/** Rhythms from four components: months, days per month, weeks, days per week. */
const rhythm = (p: Element, i: number): Omit<StandingOrderRules, "minDays" | "maxDays"> => {
    const weeks = twoDigitList(text(p, i + 2));
    return { months: twoDigitList(text(p, i)), monthDays: twoDigitList(text(p, i + 1)), weeks, weekDays: weeks.length ? digitList(text(p, i + 3)) : [] };
};

const paramsOf = (bpd: BankParameters, id: string, versions: number[]): Element | null => {
    const job = negotiate(bpd, id, versions);
    return job ? (job.params[0] ?? []) : null;
};

/**
 * The bank's rules for writing orders, from HICSES/HICSAS (min. and max. lead time), HICDES
 * (number of remittance lines – not to be checked –, lead times, rhythms) and HICDNS (number of
 * scheduled changes, lead times, nine flags "changeable", rhythms). Null if it offers none of them.
 */
export function orderRules(bpd: BankParameters | null): ConnectorOrderRules | null {
    if (!bpd) return null;
    const cse = paramsOf(bpd, "HKCSE", CSE_VERSIONS);
    const csa = paramsOf(bpd, "HKCSA", CSA_VERSIONS);
    const cde = paramsOf(bpd, "HKCDE", CDE_VERSIONS);
    const cdn = paramsOf(bpd, "HKCDN", CDN_VERSIONS);
    if (!cse && !csa && !cde && !cdn) return null;
    return {
        scheduled: cse ? lead(cse, 0) : null,
        scheduledChange: csa ? lead(csa, 0) : null,
        standing: cde ? { ...lead(cde, 1), ...rhythm(cde, 3) } : null,
        standingChange: cdn
            ? {
                  ...lead(cdn, 1),
                  ...rhythm(cdn, 12),
                  changeable: {
                      payeeAccount: jn(cdn, 3),
                      payeeName: jn(cdn, 4),
                      amount: jn(cdn, 5),
                      remittance: jn(cdn, 6),
                      firstDate: jn(cdn, 7),
                      unit: jn(cdn, 8),
                      every: jn(cdn, 9),
                      executionDay: jn(cdn, 10),
                      lastDate: jn(cdn, 11),
                  },
              }
            : null,
    };
}

/** Whether a deletion must carry the order's data (HICSLS: element 1; HICDLS: element 4). */
export function deleteNeedsData(bpd: BankParameters | null, id: "HKCSL" | "HKCDL"): boolean {
    const p = bpd ? paramsOf(bpd, id, id === "HKCSL" ? CSL_VERSIONS : CDL_VERSIONS) : null;
    // Unknown: send the data, which the bank may always use for its checks
    if (!p) return true;
    return text(p, id === "HKCSL" ? 0 : 3) !== "N";
}
