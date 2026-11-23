// Readable text patterns and templates of rules. A pattern takes pieces out of a booking text
// ("Rechnung {nr:wort} Kundennr {kunde:zahl}"), a template puts them into a new one
// ("Rechnung {nr}"). Booking texts come from outside, so there are no regular expressions built
// from user input, a pattern never backtracks, and inserted values are never evaluated again.

import { foldText } from "./txquery.js";

export const PATTERN_MAX_LENGTH = 200;
/** Places of the first fixed text a pattern is tried at. */
export const PATTERN_MAX_TRIES = 32;

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;

export type SlotKind = "text" | "wort" | "zahl";
export type TemplateCase = "none" | "titel" | "gross" | "klein";

export type PatternPart = { k: "text"; text: string } | { k: "slot"; name: string; kind: SlotKind } | { k: "skip" };
export type TemplatePart = { k: "text"; text: string } | { k: "value"; name: string; change: TemplateCase };

export type Parsed<T> = { ok: true; parts: T[] } | { ok: false; error: string };

/** The next `{…}` from `at`: its name and option, and the index behind it. */
function readBraces(src: string, at: number): { name: string; option: string | null; end: number } | null {
    const close = src.indexOf("}", at);
    if (close < 0) return null;
    const inner = src.slice(at + 1, close);
    const colon = inner.indexOf(":");
    return colon < 0 ? { name: inner, option: null, end: close + 1 } : { name: inner.slice(0, colon), option: inner.slice(colon + 1), end: close + 1 };
}

/** Reads a pattern. `\{`, `\}`, `\*` and `\\` stand for the character itself. */
export function parsePattern(src: string): Parsed<PatternPart> {
    if (src.length > PATTERN_MAX_LENGTH) return { ok: false, error: `Das Muster ist zu lang (höchstens ${PATTERN_MAX_LENGTH} Zeichen).` };
    const parts: PatternPart[] = [];
    let text = "";
    const flush = () => {
        if (text) parts.push({ k: "text", text: foldText(text) });
        text = "";
    };
    const open = () => {
        flush();
        const last = parts[parts.length - 1];
        return !last || last.k === "text";
    };
    const names = new Set<string>();
    for (let i = 0; i < src.length; ) {
        const c = src[i]!;
        if (c === "\\" && "{}*\\".includes(src[i + 1] ?? " ")) {
            text += src[i + 1];
            i += 2;
        } else if (c === "*") {
            if (!open()) return { ok: false, error: "Zwischen zwei Platzhaltern muss fester Text stehen." };
            parts.push({ k: "skip" });
            i++;
        } else if (c === "{") {
            const b = readBraces(src, i);
            if (!b) return { ok: false, error: "Eine geschweifte Klammer ist nicht geschlossen." };
            if (!NAME.test(b.name)) return { ok: false, error: `„${b.name}“ ist kein gültiger Name. Erlaubt sind Buchstaben, Ziffern und _.` };
            if (b.option !== null && b.option !== "wort" && b.option !== "zahl") return { ok: false, error: `„${b.option}“ gibt es nicht. Möglich sind wort und zahl.` };
            if (names.has(b.name)) return { ok: false, error: `Der Name „${b.name}“ kommt doppelt vor.` };
            if (!open()) return { ok: false, error: "Zwischen zwei Platzhaltern muss fester Text stehen." };
            names.add(b.name);
            parts.push({ k: "slot", name: b.name, kind: b.option ?? "text" });
            i = b.end;
        } else {
            text += c;
            i++;
        }
    }
    flush();
    if (!parts.length) return { ok: false, error: "Das Muster ist leer." };
    return { ok: true, parts };
}

/** Reads a template: `{name}` or `{name:titel|gross|klein}`; `\{` and `\}` are plain text. */
export function parseTemplate(src: string): Parsed<TemplatePart> {
    const parts: TemplatePart[] = [];
    let text = "";
    const flush = () => {
        if (text) parts.push({ k: "text", text });
        text = "";
    };
    for (let i = 0; i < src.length; ) {
        const c = src[i]!;
        if (c === "\\" && "{}\\".includes(src[i + 1] ?? " ")) {
            text += src[i + 1];
            i += 2;
        } else if (c === "{") {
            const b = readBraces(src, i);
            if (!b) return { ok: false, error: "Eine geschweifte Klammer ist nicht geschlossen." };
            if (!NAME.test(b.name)) return { ok: false, error: `„${b.name}“ ist kein gültiger Name.` };
            if (b.option !== null && b.option !== "titel" && b.option !== "gross" && b.option !== "klein") {
                return { ok: false, error: `„${b.option}“ gibt es nicht. Möglich sind titel, gross und klein.` };
            }
            flush();
            parts.push({ k: "value", name: b.name, change: b.option ?? "none" });
            i = b.end;
        } else {
            text += c;
            i++;
        }
    }
    flush();
    return { ok: true, parts };
}

const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s\-/.&])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());

function changeCase(s: string, change: TemplateCase): string {
    switch (change) {
        case "titel":
            return titleCase(s);
        case "gross":
            return s.toUpperCase();
        case "klein":
            return s.toLowerCase();
        default:
            return s;
    }
}

/**
 * Fills a template in a single pass, so a value that itself reads `{zweck}` stays plain text.
 * Null when a value it needs is missing or empty.
 */
export function renderTemplate(parts: readonly TemplatePart[], value: (name: string) => string | undefined): string | null {
    let out = "";
    for (const p of parts) {
        if (p.k === "text") out += p.text;
        else {
            const v = value(p.name);
            if (!v) return null;
            out += changeCase(v, p.change);
        }
    }
    return out;
}

/** A value fit for storing: no control or format characters, single spaces, at most `max` characters. */
export function cleanValue(s: string, max: number): string {
    const clean = s.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
    if (clean.length <= max) return clean;
    // Never cut a character made of two code units in half
    const code = clean.charCodeAt(max - 1);
    return clean.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max).trim();
}

/** A folded text with, for each of its characters, where that character stands in the original. */
function foldWithMap(text: string): { folded: string; origin: number[] } {
    let folded = "";
    const origin: number[] = [];
    let at = 0;
    for (const ch of text) {
        const piece = foldText(ch);
        if (piece !== " " || !folded.endsWith(" ")) {
            folded += piece;
            for (let i = 0; i < piece.length; i++) origin.push(at);
        }
        at += ch.length;
    }
    origin.push(text.length);
    return { folded, origin };
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

export interface PatternMatch {
    values: Map<string, string>;
    /** The matched span in the original text. */
    start: number;
    end: number;
}

/** The end of a slot running from `from` up to the fixed text `next`; -1 if it cannot end there. */
function slotEnd(folded: string, from: number, kind: SlotKind, next: string | null): number {
    if (kind === "zahl") {
        let end = from;
        while (isDigit(folded[end])) end++;
        if (end === from) return -1;
        return next === null || folded.startsWith(next, end) ? end : -1;
    }
    if (kind === "wort") {
        const space = folded.indexOf(" ", from);
        const wordEnd = space < 0 ? folded.length : space;
        if (next === null) return wordEnd > from ? wordEnd : -1;
        const fixed = folded.indexOf(next, from);
        if (fixed < 0 || fixed > wordEnd || fixed === from) return -1;
        return fixed;
    }
    if (next === null) return folded.length;
    return folded.indexOf(next, from);
}

/** The start of a slot in front of the first fixed text, which stands at `end`; -1 if it cannot start. */
function leadStart(folded: string, end: number, kind: SlotKind): number {
    if (kind === "text") return 0;
    let start = end;
    if (kind === "zahl") while (start > 0 && isDigit(folded[start - 1])) start--;
    else while (start > 0 && folded[start - 1] !== " ") start--;
    return start === end ? -1 : start;
}

/** Runs the parts from `pos` on, without going back; false when the text does not fit. */
function walk(parts: readonly PatternPart[], first: number, pos: number, folded: string, spans: Map<string, [number, number]>): number {
    let at = pos;
    for (let i = first; i < parts.length; i++) {
        const p = parts[i]!;
        if (p.k === "text") {
            if (!folded.startsWith(p.text, at)) return -1;
            at += p.text.length;
            continue;
        }
        const after = parts[i + 1];
        const next = after?.k === "text" ? after.text : null;
        const end = p.k === "slot" ? slotEnd(folded, at, p.kind, next) : next === null ? folded.length : folded.indexOf(next, at);
        if (end < 0) return -1;
        if (p.k === "slot") spans.set(p.name, [at, end]);
        at = end;
    }
    return at;
}

/**
 * The first place where a pattern fits, from the left. It is tried at up to `PATTERN_MAX_TRIES`
 * places of its first fixed text; from each place it runs through the text once.
 */
export function runPattern(parts: readonly PatternPart[], text: string): PatternMatch | null {
    const { folded, origin } = foldWithMap(text);
    const textAt = parts.findIndex((p) => p.k === "text");
    const toValues = (spans: Map<string, [number, number]>) => new Map([...spans].map(([name, [a, b]]) => [name, text.slice(origin[a]!, origin[b]!).trim()]));
    if (textAt < 0) {
        // Only one slot or a skip: the whole text, or its first word or number
        const only = parts[0]!;
        if (only.k !== "slot") return { values: new Map(), start: 0, end: text.length };
        let from = 0;
        if (only.kind === "zahl") while (from < folded.length && !isDigit(folded[from])) from++;
        if (only.kind === "wort") while (folded[from] === " ") from++;
        if (from >= folded.length) return null;
        const end = slotEnd(folded, from, only.kind, null);
        if (end < 0) return null;
        return { values: toValues(new Map([[only.name, [from, end]]])), start: origin[from]!, end: origin[end]! };
    }
    const head = (parts[textAt] as { text: string }).text;
    const lead = textAt === 1 ? parts[0]! : null;
    let from = 0;
    for (let tries = 0; tries < PATTERN_MAX_TRIES; tries++) {
        const at = folded.indexOf(head, from);
        if (at < 0) return null;
        from = at + 1;
        const spans = new Map<string, [number, number]>();
        let start = at;
        if (lead?.k === "slot") {
            start = leadStart(folded, at, lead.kind);
            if (start < 0) continue;
            spans.set(lead.name, [start, at]);
        } else if (lead?.k === "skip") start = 0;
        const end = walk(parts, textAt, at, folded, spans);
        if (end >= 0) return { values: toValues(spans), start: origin[start]!, end: origin[end]! };
    }
    return null;
}
