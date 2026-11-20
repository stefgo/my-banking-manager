// Message frame and PIN/TAN security envelope.
// Formals B.5.2/B.5.3/B.8, Security HBCI B.5, Security PIN/TAN B.9 (fill values for PIN/TAN).

import { toDat, toTim } from "../syntax/formats.js";
import type { SegmentInput } from "../syntax/types.js";
import { COUNTRY_DE } from "./common.js";

/** Width of the message size in HNHBK (format dig, fixed length 12). */
export const SIZE_WIDTH = 12;
export const HBCI_VERSION = "300";

/** Message header; the size is filled in after the message is complete. */
export const hnhbk = (size: number, dialogId: string, messageNumber: number): SegmentInput => ({
    id: "HNHBK",
    version: 3,
    elements: [String(size).padStart(SIZE_WIDTH, "0"), HBCI_VERSION, dialogId, messageNumber],
});

export const hnhbs = (messageNumber: number): SegmentInput => ({ id: "HNHBS", version: 1, elements: [messageNumber] });

/** Who signs: the user's identity and the Kundensystem-ID. */
export interface Signer {
    blz: string;
    /** Benutzerkennung (login name). */
    userId: string;
    /** Kundensystem-ID; "0" before the synchronisation. */
    systemId: string;
    /** Sicherheitsfunktion: "999" one-step, "900"–"997" the chosen two-step method. */
    securityFunction: string;
}

/** Sicherheitsprofil: "PIN" plus "1" (one-step) or "2" (two-step), PIN/TAN B.9.1. */
const profile = (securityFunction: string): string[] => ["PIN", securityFunction === "999" ? "1" : "2"];

/** Sicherheitsdatum und -uhrzeit, code 1 = Sicherheitszeitstempel. */
const securityDate = (now: Date): string[] => ["1", toDat(now), toTim(now)];

/** Schlüsselname with fill values for key number and version (PIN/TAN B.9.2). */
const keyName = (s: Signer, keyType: "S" | "V"): string[] => [COUNTRY_DE, s.blz, s.userId, keyType, "0", "0"];

/** Verschlüsselungskopf (HNVSK v3), always number 998. */
export const hnvsk = (s: Signer, now: Date): SegmentInput => ({
    id: "HNVSK",
    version: 3,
    elements: [
        profile(s.securityFunction),
        "998", // Sicherheitsfunktion: Klartext (B.9.8)
        "1", // Rolle des Sicherheitslieferanten: ISS
        ["1", "", s.systemId], // Sicherheitsidentifikation: Bezeichner, CID (empty), Kundensystem-ID
        securityDate(now),
        // Verschlüsselungsalgorithmus: use, mode, algorithm, key (fill value), key parameter, IV parameter
        ["2", "2", "13", new Uint8Array(8), "5", "1"],
        keyName(s, "V"),
        "0", // Komprimierungsfunktion: none
    ],
});

/** Verschlüsselte Daten (HNVSD v1), always number 999; holds the signed segments in clear text. */
export const hnvsd = (data: Uint8Array): SegmentInput => ({ id: "HNVSD", version: 1, elements: [data] });

/** Signaturkopf (HNSHK v4). */
export const hnshk = (s: Signer, controlRef: string, now: Date): SegmentInput => ({
    id: "HNSHK",
    version: 4,
    elements: [
        profile(s.securityFunction),
        s.securityFunction,
        controlRef, // Sicherheitskontrollreferenz, repeated in HNSHA
        "1", // Bereich der Sicherheitsapplikation: SHM
        "1", // Rolle des Sicherheitslieferanten: ISS
        ["1", "", s.systemId],
        "1", // Sicherheitsreferenznummer
        securityDate(now),
        ["1", "999", "1"], // Hashalgorithmus: fill values
        ["6", "10", "16"], // Signaturalgorithmus: fill values (B.9.6)
        keyName(s, "S"),
    ],
});

/** Signaturabschluss (HNSHA v2) with PIN and, in the one-step method only, a TAN. */
export const hnsha = (controlRef: string, pin: string, tan?: string): SegmentInput => ({
    id: "HNSHA",
    version: 2,
    elements: [controlRef, null, tan ? [pin, tan] : [pin]],
});
