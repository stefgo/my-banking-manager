// Data element groups used by many segments (Formals, Data Dictionary).

import { num, text } from "../syntax/formats.js";
import type { Element, Segment } from "../syntax/types.js";

/** Country code of Germany (ISO 3166-1 numeric), used in every Kreditinstitutskennung. */
export const COUNTRY_DE = "280";

/** Kreditinstitutskennung (kik): country code, bank code. */
export const kik = (blz: string): string[] => [COUNTRY_DE, blz];

/** One return code (DEG Rückmeldung): code, reference element, text, parameters. */
export interface ReturnCode {
    code: string;
    /** Reference data element ("2" or "2,3"), only in HIRMS. */
    ref: string;
    text: string;
    params: string[];
}

export type ReturnClass = "success" | "warning" | "error";

export function returnClass(code: string): ReturnClass {
    if (code.startsWith("9")) return "error";
    if (code.startsWith("3")) return "warning";
    return "success";
}

/** The return codes of an HIRMG or HIRMS segment (Formals B.7.2, B.7.3). */
export function returnCodes(segment: Segment): ReturnCode[] {
    return segment.elements.map((e) => ({
        code: text(e, 0),
        ref: text(e, 1),
        text: text(e, 2),
        params: e.slice(3).map((_, i) => text(e, i + 3)),
    }));
}

/** Kontoverbindung (ktv): account number, sub-account, country code, bank code. */
export interface AccountRef {
    number: string;
    subAccount: string;
    blz: string;
}

export function accountRef(element: Element | undefined): AccountRef | null {
    const number = text(element, 0);
    if (!number) return null;
    return { number, subAccount: text(element, 1), blz: text(element, 3) };
}

/** Reads an optional number, `fallback` if empty. */
export const numOr = (element: Element | undefined, fallback: number, i = 0): number => num(element, i) ?? fallback;
