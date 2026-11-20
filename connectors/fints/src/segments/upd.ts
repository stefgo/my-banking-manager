// Userparameterdaten (Formals E).

import { num, text, wrtCents } from "../syntax/formats.js";
import type { Element, Segment } from "../syntax/types.js";
import { accountRef, numOr, type AccountRef } from "./common.js";

export interface Limit {
    /** Limitart: E Einzelauftrag, T Tageslimit, W Wochenlimit, M Monatslimit, Z Zeitlimit. */
    kind: string;
    cents: number | null;
    currency: string;
    days: number | null;
}

export interface AllowedJob {
    /** Order segment id, e.g. "HKSAL". */
    id: string;
    minSignatures: number;
    limit: Limit | null;
}

/** Kontoart code ranges (Formals, Data Dictionary „Kontoart“). */
export type AccountClass = "giro" | "savings" | "fixed_deposit" | "depot" | "loan" | "credit_card" | "fund" | "building_savings" | "insurance" | "other";

export function accountClass(kontoart: number | null): AccountClass {
    if (kontoart === null) return "other";
    if (kontoart >= 1 && kontoart <= 9) return "giro";
    if (kontoart <= 19) return "savings";
    if (kontoart <= 29) return "fixed_deposit";
    if (kontoart <= 39) return "depot";
    if (kontoart <= 49) return "loan";
    if (kontoart <= 59) return "credit_card";
    if (kontoart <= 69) return "fund";
    if (kontoart <= 79) return "building_savings";
    if (kontoart <= 89) return "insurance";
    return "other";
}

export interface UpdAccount {
    account: AccountRef | null;
    iban: string;
    customerId: string;
    kontoart: number | null;
    currency: string;
    owner: string;
    owner2: string;
    productName: string;
    limit: Limit | null;
    allowedJobs: AllowedJob[];
    /** Erweiterung, kontobezogen (JSON text), "" if absent. */
    extension: string;
}

export interface UserParameters {
    userId: string;
    version: number;
    /** UPD-Verwendung 0: jobs not listed are blocked; 1: no statement, only the bank knows. */
    unlistedBlocked: boolean;
    userName: string;
    accounts: UpdAccount[];
}

/** Reads the UPD from a bank message; null if it carries none (no HIUPA). */
export function parseUpd(segments: Segment[]): UserParameters | null {
    const hiupa = segments.find((s) => s.id === "HIUPA");
    if (!hiupa) return null;
    return {
        userId: text(hiupa.elements[0]),
        version: numOr(hiupa.elements[1], 0),
        unlistedBlocked: text(hiupa.elements[2]) === "0",
        userName: text(hiupa.elements[3]),
        accounts: segments.filter((s) => s.id === "HIUPD" && s.version === 6).map(parseHiupd6),
    };
}

const ORDER_ID = /^[A-Z]{4,6}$/;

/** HIUPD v6 (Formals E.3). */
function parseHiupd6(s: Segment): UpdAccount {
    const e = s.elements;
    const allowedJobs: AllowedJob[] = [];
    let extension = "";
    // Field 11 (Erlaubte Geschäftsvorfälle, up to 999 times) and field 12 (extension) share the
    // tail; a job starts with a segment id, the extension is JSON.
    for (const el of e.slice(9)) {
        const first = text(el);
        if (ORDER_ID.test(first)) allowedJobs.push({ id: first, minSignatures: numOr(el, 0, 1), limit: limit(el, 2) });
        else if (first.trim().startsWith("{")) extension = first;
    }
    return {
        account: accountRef(e[0]),
        iban: text(e[1]).replace(/\s/g, ""),
        customerId: text(e[2]),
        kontoart: num(e[3]),
        currency: text(e[4]),
        owner: text(e[5]),
        owner2: text(e[6]),
        productName: text(e[7]),
        limit: limit(e[8], 0),
        allowedJobs,
        extension,
    };
}

/** Limitart, Limitbetrag (Wert, Währung), Limit-Tage, starting at component `i`. */
function limit(el: Element | undefined, i: number): Limit | null {
    const kind = text(el, i);
    if (!kind) return null;
    return { kind, cents: wrtCents(el, i + 1), currency: text(el, i + 2), days: num(el, i + 3) };
}

/**
 * UPD version to announce in HKVVB. Without strong authentication (dialog with 999) banks may
 * send a UPD without accounts (seen at Sparkassen); announcing its version would make the bank
 * think we are up to date and never send the accounts, so such a UPD counts as none.
 */
export function updVersionToAnnounce(upd: UserParameters | null): number {
    return upd?.accounts.some((a) => a.account || a.iban) ? upd.version : 0;
}
