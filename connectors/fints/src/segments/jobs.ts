// Business transactions for fetching data (Messages C.2.1.1, C.2.1.2, C.2.3.1.1, C.10.1) and
// credit card transactions (HKKKU/DKKKU, see formats/kku.ts).

import { bytes, dat, text, toDat, wrtCents } from "../syntax/formats.js";
import type { Element, Segment, SegmentInput } from "../syntax/types.js";
import { COUNTRY_DE } from "./common.js";

/** What identifies an account in a job. */
export interface JobAccount {
    accountNumber: string;
    subAccount: string;
    blz: string;
    iban: string | null;
    bic: string | null;
}

/** Kontoverbindung (ktv): number, sub-account, country, bank code. */
export const ktv = (a: JobAccount): string[] => [a.accountNumber, a.subAccount, COUNTRY_DE, a.blz];

/** Kontoverbindung international (kti): IBAN, BIC, number, sub-account, country, bank code. */
export const kti = (a: JobAccount): (string | null)[] => [a.iban, a.bic, a.accountNumber, a.subAccount, COUNTRY_DE, a.blz];

// ---------- HKSPA: SEPA account details ----------

export const SPA_VERSIONS = [1, 2, 3];
export const hkspa = (version: number, touchdown?: string): SegmentInput => ({ id: "HKSPA", version, elements: [null, null, touchdown ?? null] });

export interface SepaAccount {
    iban: string;
    bic: string;
    accountNumber: string;
    subAccount: string;
    blz: string;
}

/** HISPA: one Kontoverbindung ZV (ktz) per element: IBAN-fähig, IBAN, BIC, number, sub, country, BLZ. */
export function parseHispa(s: Segment): SepaAccount[] {
    return s.elements
        .filter((e) => text(e, 1))
        .map((e) => ({ iban: text(e, 1).replace(/\s/g, ""), bic: text(e, 2), accountNumber: text(e, 3), subAccount: text(e, 4), blz: text(e, 6) }));
}

// ---------- HKSAL: balance ----------

export const SAL_VERSIONS = [5, 6, 7];

export const hksal = (version: number, a: JobAccount, touchdown?: string): SegmentInput => ({
    id: "HKSAL",
    version,
    elements: [version >= 7 ? kti(a) : ktv(a), "N", null, touchdown ?? null],
});

export interface Balance {
    booked: number;
    currency: string;
    date: string | null;
    pending: number | null;
    available: number | null;
    creditLine: number | null;
}

/** HISAL v5–v7: account, product, currency, booked balance (sdo), pending (sdo), credit line, available, … */
export function parseHisal(s: Segment): Balance | null {
    const e = s.elements;
    const booked = sdo(e[3]);
    if (!booked) return null;
    return {
        booked: booked.cents,
        currency: booked.currency || text(e[2]) || "EUR",
        date: booked.date,
        pending: sdo(e[4])?.cents ?? null,
        creditLine: btg(e[5]),
        available: btg(e[6]),
    };
}

/** Saldo (sdo): C/D, amount, currency, date, time. */
function sdo(el: Element | undefined): { cents: number; currency: string; date: string | null } | null {
    const mark = text(el, 0);
    const cents = wrtCents(el, 1);
    if (!mark || cents === null) return null;
    return { cents: mark === "D" ? -cents : cents, currency: text(el, 2), date: dat(el, 3) };
}

/** Betrag (btg): amount, currency. */
const btg = (el: Element | undefined): number | null => wrtCents(el, 0);

// ---------- HKKAZ: transactions in MT940 ----------

export const KAZ_VERSIONS = [5, 6, 7];

export const hkkaz = (version: number, a: JobAccount, from?: string, to?: string, touchdown?: string): SegmentInput => ({
    id: "HKKAZ",
    version,
    elements: [version >= 7 ? kti(a) : ktv(a), "N", from ? toDat(from) : null, to ? toDat(to) : null, null, touchdown ?? null],
});

/** HIKAZ: booked (MT940) and pending (MT942) as binary data. */
export const parseHikaz = (s: Segment): { booked: Uint8Array | null; pending: Uint8Array | null } => ({ booked: bytes(s.elements[0]), pending: bytes(s.elements[1]) });

// ---------- HKCAZ: transactions in camt ----------

export const CAZ_VERSIONS = [1];

/** camt.052 versions we read, best first. */
export const CAMT_FORMATS = ["camt.052.001.08", "camt.052.001.02"];

export const hkcaz = (a: JobAccount, formats: string[], from?: string, to?: string, touchdown?: string): SegmentInput => ({
    id: "HKCAZ",
    version: 1,
    elements: [kti(a), formats, "N", from ? toDat(from) : null, to ? toDat(to) : null, null, touchdown ?? null],
});

/** The descriptors of the camt formats both sides support, in the bank's spelling. */
export function camtFormats(params: Element[]): string[] {
    const offered = (params[0] ?? []).slice(3).map((_, i) => text(params[0], i + 3)).filter(Boolean);
    return CAMT_FORMATS.flatMap((f) => offered.filter((o) => o.endsWith(f)));
}

/** HICAZ: account, descriptor, booked (one camt document per component), pending (one document). */
export function parseHicaz(s: Segment): { booked: Uint8Array[]; pending: Uint8Array | null } {
    const booked = (s.elements[2] ?? []).map((_, i) => bytes(s.elements[2], i)).filter((b): b is Uint8Array => b !== null && b.length > 0);
    return { booked, pending: bytes(s.elements[3]) };
}

// ---------- HKKKU / DKKKU: credit card transactions ----------

export const hkkku = (a: JobAccount, from?: string, to?: string, touchdown?: string): SegmentInput => ({
    id: "HKKKU",
    version: 1,
    elements: [kti(a), a.accountNumber, a.subAccount || null, from ? toDat(from) : null, to ? toDat(to) : null, null, touchdown ?? null],
});

export const dkkku = (a: JobAccount, from?: string, touchdown?: string): SegmentInput => ({
    id: "DKKKU",
    version: 2,
    elements: [ktv(a), a.accountNumber, a.subAccount || null, from ? toDat(from) : null, null, touchdown ?? null],
});
