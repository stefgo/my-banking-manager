// Transfers in the web client: texts for states and the verification of payee, the form's
// checks, and how other places start a transfer with prefilled data.

import { useNavigate } from "@tanstack/react-router";
import {
    BIC_PATTERN,
    cleanIban,
    groupIban,
    ibanLength,
    ibanProblem,
    joinRemittance,
    needsBic,
    parseAmount,
    REMITTANCE_LINE_MAX,
    REMITTANCE_LINES,
    SEPA_NAME_MAX,
    SEPA_REMITTANCE_MAX,
    sepaCharsMessage,
    TRANSFER_MAX_CENTS,
    type TransferStatus,
    type VopResult,
} from "@mbm/shared";
import type { FieldErrors } from "./fields";
import { ui, type TransferDraft } from "./ui";

export const STATUS_LABEL: Record<TransferStatus, string> = {
    submitting: "wird gesendet",
    awaiting_vop_confirm: "wartet auf deine Bestätigung",
    awaiting_tan: "wartet auf die Freigabe",
    executed: "ausgeführt",
    rejected: "abgelehnt",
    failed: "nicht gesendet",
    cancelled: "abgebrochen",
    unknown: "Ausgang unbekannt",
};

export type Tone = "ok" | "warn" | "bad" | "neutral";

export const isRunning = (s: TransferStatus): boolean => s === "submitting" || s === "awaiting_vop_confirm" || s === "awaiting_tan";

/** Waits for something the user does. */
export const needsUser = (s: TransferStatus): boolean => s === "awaiting_vop_confirm" || s === "awaiting_tan";

export const VOP_VIEW: Record<VopResult, { tone: Tone; title: string } | null> = {
    match: { tone: "ok", title: "Name passt" },
    close_match: { tone: "warn", title: "Name passt fast" },
    no_match: { tone: "bad", title: "Name passt nicht" },
    not_applicable: { tone: "warn", title: "Name konnte nicht geprüft werden" },
    pending: { tone: "warn", title: "Ergebnis der Prüfung steht noch aus" },
    none: null,
};

/** Results after which the user has to tick a box before going on. */
export const needsSecondConfirm = (r: VopResult): boolean => r === "no_match" || r === "not_applicable" || r === "pending";

export interface TransferForm {
    accountId: string;
    payeeName: string;
    payeeIban: string;
    /** Only sent for SEPA countries outside the EEA (`needsBic`). */
    payeeBic: string;
    amount: string;
    /** The lines of the remittance information; the bank gets them joined (`joinRemittance`). */
    remittance: string[];
    instant: boolean;
    pin: string;
}

export const emptyLines = (): string[] => Array.from({ length: REMITTANCE_LINES }, () => "");

export const emptyForm = (accountId = ""): TransferForm => ({ accountId, payeeName: "", payeeIban: "", payeeBic: "", amount: "", remittance: emptyLines(), instant: false, pin: "" });

/** The BIC the transfer carries: only where the form offers it, and only if one is entered. */
export const bicToSend = (f: TransferForm): string | null => {
    const bic = f.payeeBic.trim().toUpperCase();
    return bic && needsBic(cleanIban(f.payeeIban)) ? bic : null;
};

/** The longest IBAN there is (ISO 13616). */
const IBAN_MAX = 34;

/**
 * An IBAN as typed, in its paper form (groups of four) while it is entered, and where the caret
 * goes: behind the same character it was behind before. `pos` is the caret in `raw`. Never longer
 * than the IBAN of its country, or than 34 characters while the country is not known.
 */
export function ibanAsTyped(raw: string, pos: number): { value: string; caret: number } {
    const all = cleanIban(raw);
    const clean = all.slice(0, ibanLength(all) ?? IBAN_MAX);
    const before = Math.min(cleanIban(raw.slice(0, pos)).length, clean.length);
    const value = groupIban(clean);
    // After the fourth character of a group the caret stays in front of the space
    return { value, caret: before === 0 ? 0 : before + Math.floor((before - 1) / 4) };
}

/**
 * Characters that can still be written: on in the last line used and in the empty lines below
 * it, and at most what the 140 of SEPA leave, where each further line costs its joining space.
 */
export function remittanceLeft(lines: readonly string[]): number {
    let avail = SEPA_REMITTANCE_MAX - joinRemittance(lines).length;
    let k = lines.length - 1;
    while (k >= 0 && !lines[k]!.trim()) k--;
    let left = 0;
    if (k >= 0) {
        const take = Math.max(0, Math.min(REMITTANCE_LINE_MAX - lines[k]!.length, avail));
        left += take;
        avail -= take;
    }
    for (let i = k + 1; i < lines.length; i++) {
        const sep = i > 0 && k >= 0 ? 1 : 0;
        const take = Math.min(REMITTANCE_LINE_MAX, avail - sep);
        if (take <= 0) break;
        left += take;
        avail -= take + sep;
        k = i;
    }
    return Math.max(0, left);
}

function remittanceProblem(lines: string[]): string | undefined {
    const long = lines.findIndex((l) => l.trim().length > REMITTANCE_LINE_MAX);
    if (long >= 0) return `Zeile ${long + 1} hat mehr als ${REMITTANCE_LINE_MAX} Zeichen.`;
    const text = joinRemittance(lines);
    if (text.length > SEPA_REMITTANCE_MAX) return `Höchstens ${SEPA_REMITTANCE_MAX} Zeichen, mit je einem Leerzeichen zwischen den Zeilen.`;
    return sepaCharsMessage(text) ?? undefined;
}

/** The form's errors by field id; the server checks the same once more. */
export function checkTransfer(f: TransferForm, pinRequired: boolean): FieldErrors {
    const cents = parseAmount(f.amount);
    const iban = cleanIban(f.payeeIban);
    const name = f.payeeName.trim();
    return {
        "tr-acc": f.accountId ? undefined : "Bitte ein Konto wählen.",
        "tr-name": !name ? "Bitte den Empfänger eingeben." : name.length > SEPA_NAME_MAX ? `Höchstens ${SEPA_NAME_MAX} Zeichen.` : (sepaCharsMessage(name) ?? undefined),
        "tr-iban": !iban ? "Bitte die IBAN eingeben." : (ibanProblem(iban) ?? undefined),
        "tr-bic": bicToSend(f) !== null && !BIC_PATTERN.test(bicToSend(f)!) ? "Die BIC hat 8 oder 11 Buchstaben und Ziffern." : undefined,
        "tr-amount": cents === null || cents <= 0 ? "Bitte einen Betrag größer als 0 eingeben." : cents > TRANSFER_MAX_CENTS ? "Der Betrag ist zu groß." : undefined,
        "tr-purpose": remittanceProblem(f.remittance),
        "tr-pin": pinRequired && !f.pin ? "Bitte die PIN eingeben." : undefined,
    };
}

/**
 * A request ID (UUID v4) for one transfer form. `crypto.randomUUID` exists only in a secure
 * context (HTTPS or localhost); `getRandomValues` everywhere.
 */
export function newRequestId(): string {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Bank code of a German IBAN, for the bank's name from the directory; null otherwise. */
export const blzOfIban = (iban: string): string | null => {
    const s = cleanIban(iban);
    return /^DE\d{20}$/.test(s) ? s.slice(4, 12) : null;
};

/** Opens the transfer page with the dialog of a prefilled form. */
export function useStartTransfer() {
    const navigate = useNavigate();
    return (draft: TransferDraft = {}) => {
        ui.newTransfer(draft);
        void navigate({ to: "/transfer" });
    };
}
