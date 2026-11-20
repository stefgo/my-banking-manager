// Orders the bank holds: standing orders (HKCDB, Messages C.10.2.3.4) and scheduled transfers
// (HKCSB, Messages C.10.2.2.3). Read only.

import { bytes, num, text } from "../syntax/formats.js";
import { FintsSyntaxError, type Element, type Segment, type SegmentInput } from "../syntax/types.js";
import type { BankParameters, JobParameters } from "./bpd.js";
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
    return { pain: bytes(e[2]), orderId: text(e[3]) || null, canChange: flag(e[5]), canDelete: s.version === 1 ? flag(e[4]) : null };
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
