// Data formats of FinTS (Formals B.4) and reading components by position.

import { FintsSyntaxError, type Component, type Element } from "./types.js";

/** Component `i` of an element as text; "" if absent. Binary data is decoded as latin1. */
export function text(element: Element | undefined, i = 0): string {
    const c: Component | undefined = element?.[i];
    if (c === undefined) return "";
    return typeof c === "string" ? c : Buffer.from(c).toString("latin1");
}

/** Component `i` as binary data; text is taken as latin1 bytes. */
export function bytes(element: Element | undefined, i = 0): Uint8Array | null {
    const c = element?.[i];
    if (c === undefined || c === "") return null;
    return typeof c === "string" ? Buffer.from(c, "latin1") : c;
}

/** Component `i` as number (formats num/dig); null if empty. */
export function num(element: Element | undefined, i = 0): number | null {
    const t = text(element, i);
    if (t === "") return null;
    if (!/^\d+$/.test(t)) throw new FintsSyntaxError(`Not a number: ${t}`);
    return Number(t);
}

/** Format jn; an omitted optional value means "N". */
export const jn = (element: Element | undefined, i = 0): boolean => text(element, i) === "J";
export const toJn = (v: boolean): string => (v ? "J" : "N");

/** Format dat (JJJJMMTT) → "JJJJ-MM-TT"; null if empty. */
export function dat(element: Element | undefined, i = 0): string | null {
    const t = text(element, i);
    if (t === "") return null;
    if (!/^\d{8}$/.test(t)) throw new FintsSyntaxError(`Not a date: ${t}`);
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/** "JJJJ-MM-TT" or Date (local time) → format dat. */
export function toDat(d: string | Date): string {
    if (typeof d === "string") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new FintsSyntaxError(`Not a date: ${d}`);
        return d.replaceAll("-", "");
    }
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Date (local time) → format tim (hhmmss). */
export const toTim = (d: Date): string => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Format wrt ("1234,5") → cents. More than two decimal places are allowed only if they are
 * zero; amounts are never rounded.
 */
export function wrtCents(element: Element | undefined, i = 0): number | null {
    const t = text(element, i);
    if (t === "") return null;
    const m = /^(\d+),(\d*)$/.exec(t);
    if (!m) throw new FintsSyntaxError(`Not an amount: ${t}`);
    const decimals = m[2]!.replace(/0+$/, "");
    if (decimals.length > 2) throw new FintsSyntaxError(`Amount with more than two decimal places: ${t}`);
    return Number(m[1]) * 100 + Number(decimals.padEnd(2, "0"));
}
