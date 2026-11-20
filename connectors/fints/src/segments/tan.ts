// Two-step TAN (Security PIN/TAN B.5, C.3.1) and synchronisation (Formals C.8).

import { jn, num, text } from "../syntax/formats.js";
import type { Element, Segment, SegmentInput } from "../syntax/types.js";
import type { BankParameters } from "./bpd.js";

// ---------- HITANS: the bank's two-step methods ----------

export interface DecoupledParams {
    maxPolls: number | null;
    /** Seconds before the first and between further status queries. */
    firstDelay: number | null;
    nextDelay: number | null;
    manualConfirm: boolean;
    autoPoll: boolean;
}

export interface TanMethod {
    /** Sicherheitsfunktion, kodiert: "900"–"997". */
    securityFunction: string;
    /** Version of HKTAN this method belongs to. */
    hktanVersion: number;
    /** TAN-Prozess: 1 or 2 (process variant). */
    process: string;
    technicalId: string;
    /** DK TAN-Verfahren, e.g. "Decoupled", "HHD", "mobileTAN". */
    dkName: string;
    name: string;
    maxTanLength: number | null;
    /** Bezeichnung des TAN-Mediums erforderlich: 0 not allowed, 1 optional, 2 required. */
    mediumRequired: number;
    activeMediaCount: number | null;
    /** Present for decoupled methods (approval in an app, no TAN entry). */
    decoupled: DecoupledParams | null;
}

/** Components per method in "Verfahrensparameter Zwei-Schritt-Verfahren" (v6: 21, v7: 26). */
const METHOD_WIDTH: Record<number, number> = { 6: 21, 7: 26 };

/** All two-step methods of the bank in HKTAN versions we support, highest version first. */
export function parseTanMethods(bpd: BankParameters): TanMethod[] {
    const out: TanMethod[] = [];
    const seen = new Set<string>();
    for (const job of [...(bpd.jobs.HKTAN ?? [])].reverse()) {
        const width = METHOD_WIDTH[job.version];
        const p = job.params[0];
        if (!width || !p) continue;
        // Einschritt-Verfahren erlaubt, mehr als ein TAN-pflichtiger Auftrag, Hashwertverfahren, then methods
        // Nested groups are never shortened, except at the very end of the segment.
        for (let i = 3; i < p.length; i += width) {
            const m = p.slice(i, i + width);
            const f = text(m, 0);
            if (!/^9\d\d$/.test(f) || seen.has(f)) continue;
            seen.add(f);
            const dkName = text(m, 3);
            const isDecoupled = job.version >= 7 && /^decoupled/i.test(dkName);
            out.push({
                securityFunction: f,
                hktanVersion: job.version,
                process: text(m, 1),
                technicalId: text(m, 2),
                dkName,
                name: text(m, 5),
                maxTanLength: num(m, 6),
                mediumRequired: num(m, 18) ?? 0,
                activeMediaCount: num(m, 20),
                decoupled: isDecoupled
                    ? { maxPolls: num(m, 21), firstDelay: num(m, 22), nextDelay: num(m, 23), manualConfirm: jn(m, 24), autoPoll: jn(m, 25) }
                    : null,
            });
        }
    }
    return out;
}

// ---------- HKTAN / HITAN ----------

/** HKTAN process 4: start a strong authentication for `segmentId` (HKIDN at dialog start, or a job). */
export const hktan4 = (version: number, segmentId: string, medium?: string): SegmentInput => ({
    id: "HKTAN",
    version,
    // TAN-Prozess, Segmentkennung, kti, Hashwert, Auftragsreferenz, Weitere TAN folgt, Storno,
    // SMS-Abbuchungskonto, Challenge-Klasse, Parameter Challenge-Klasse, Bezeichnung des TAN-Mediums
    elements: ["4", segmentId, null, null, null, null, null, null, null, null, medium || null],
});

/** HKTAN process 2 (TAN goes into HNSHA) or S (status query of a decoupled approval). */
export const hktanFollowUp = (version: number, process: "2" | "S", orderRef: string): SegmentInput => ({
    id: "HKTAN",
    version,
    elements: [process, null, null, null, orderRef, "N"],
});

export interface TanAnswer {
    process: string;
    orderRef: string;
    challenge: string;
    /** "JJJJ-MM-TTThh:mm:ss" (bank's local time), "" if not given. */
    validUntil: string;
    medium: string;
}

/** FinTS fill values in a dummy HITAN (PIN/TAN B.4.3.4). */
export const NO_REF = "noref";
export const NO_CHALLENGE = "nochallenge";

export function parseHitan(s: Segment): TanAnswer {
    const e = s.elements;
    const validity = e[5];
    const d = text(validity, 0);
    const t = text(validity, 1);
    const challenge = text(e[3]);
    return {
        process: text(e[0]),
        orderRef: text(e[2]) === NO_REF ? "" : text(e[2]),
        challenge: challenge === NO_CHALLENGE ? "" : challenge,
        validUntil: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${(/^\d{6}$/.test(t) ? t : "000000").replace(/(\d\d)(\d\d)(\d\d)/, "$1:$2:$3")}` : "",
        medium: text(e[6]),
    };
}

// ---------- HKTAB / HITAB: TAN media ----------

/** HKTAB versions we can read; Sparkassen offer only up to v4. */
const HKTAB_VERSIONS = [4, 5];

/** Highest HKTAB version both sides support; null if the bank offers none of them. */
export function hktabVersion(bpd: BankParameters | null): number | null {
    const offered = (bpd?.jobs.HKTAB ?? []).map((j) => j.version).filter((v) => HKTAB_VERSIONS.includes(v));
    return offered.length > 0 ? Math.max(...offered) : null;
}

/**
 * HKTAB v4/v5: all media (Art 0) of all classes (A); both versions have the same fields. Art 0
 * because some banks accept nothing else (Sparkasse: "Zulässig ist ausschließlich 0"); callers
 * pick the active ones by status.
 */
export const hktab = (version: number): SegmentInput => ({ id: "HKTAB", version, elements: ["0", "A"] });

export interface TanMedium {
    /** TAN-Medium-Klasse: G generator, M mobile, S secoder, B bilateral, L list. */
    kind: string;
    /** 1 aktiv, 2 verfügbar, 3 aktiv Folgekarte, 4 verfügbar Folgekarte. */
    status: string;
    name: string;
}

/**
 * HITAB v4/v5: one "TAN-Medium-Liste" per element after the TAN-Einsatzoption. v5 adds the
 * Sicherheitsfunktion after the status, which moves the Bezeichnung from 12 to 13.
 */
export function parseHitab(s: Segment): TanMedium[] {
    const nameAt = s.version === 5 ? 13 : s.version === 4 ? 12 : null;
    if (nameAt === null) return [];
    return s.elements.slice(1).map((m: Element) => ({ kind: text(m, 0), status: text(m, 1), name: text(m, nameAt) }));
}

// ---------- HKSYN / HISYN ----------

/** HKSYN v3, mode 0: request a new Kundensystem-ID. */
export const hksyn = (): SegmentInput => ({ id: "HKSYN", version: 3, elements: ["0"] });

export const parseHisynSystemId = (s: Segment): string => text(s.elements[0]);
