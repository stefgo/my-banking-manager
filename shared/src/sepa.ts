// Rules for SEPA credit transfers that server, clients and connector check alike (DFÜ-Abkommen,
// Anlage 3: character set and field lengths).

/** Longest payee name and remittance information a SEPA credit transfer carries. */
export const SEPA_NAME_MAX = 70;
export const SEPA_REMITTANCE_MAX = 140;
/** Largest amount MBM accepts in one transfer, in cents. */
export const TRANSFER_MAX_CENTS = 99_999_999_999;

/**
 * Characters allowed in names and remittance information: the SEPA Latin set plus the German
 * extension of the DK (umlauts, ß, &, *, $, %).
 */
const SEPA_CHAR = /[A-Za-z0-9/?:().,'+\- ÄÖÜäöüß&*$%]/;

/** The characters of `s` outside the SEPA character set, each once, in order. */
export function invalidSepaChars(s: string): string[] {
    const out: string[] = [];
    for (const ch of s) if (!SEPA_CHAR.test(ch) && !out.includes(ch)) out.push(ch);
    return out;
}

/** German message for a text with characters outside the set; null if it is fine. */
export function sepaCharsMessage(s: string): string | null {
    const bad = invalidSepaChars(s);
    if (bad.length === 0) return null;
    const shown = bad.map((c) => `„${c}“`).join(", ");
    return `${bad.length === 1 ? "Dieses Zeichen ist" : "Diese Zeichen sind"} in Überweisungen nicht erlaubt: ${shown}`;
}

/** The form writes the remittance information in lines, as banking software has done for long. */
export const REMITTANCE_LINES = 4;
export const REMITTANCE_LINE_MAX = 35;

/**
 * The text a transfer carries for the lines of the form. SEPA has a single field without line
 * breaks, so the lines are joined with a space; empty lines drop out.
 */
export function joinRemittance(lines: readonly string[]): string {
    return lines
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ");
}

/**
 * Lines of at most `width` characters for a text, broken between words; a word longer than a
 * line is cut. Line breaks in the text start a new line.
 */
export function wrapRemittance(text: string, width = REMITTANCE_LINE_MAX): string[] {
    const out: string[] = [];
    for (const para of text.split(/\r?\n/)) {
        let line = "";
        for (let word of para.split(/\s+/).filter(Boolean)) {
            while (word.length > width) {
                if (line) out.push(line);
                out.push(word.slice(0, width));
                word = word.slice(width);
                line = "";
            }
            if (!word) continue;
            if (!line) line = word;
            else if (line.length + 1 + word.length <= width) line += ` ${word}`;
            else {
                out.push(line);
                line = word;
            }
        }
        if (line) out.push(line);
    }
    return out;
}

/**
 * The form's lines for a stored text (e.g. to send a transfer again): broken between words, or,
 * where that needs more than four lines, cut every 35 characters. Always four entries.
 */
export function splitRemittance(text: string): string[] {
    const flat = text.replace(/\s+/g, " ").trim();
    let lines = wrapRemittance(flat);
    if (lines.length > REMITTANCE_LINES) {
        lines = [];
        for (let i = 0; i < flat.length; i += REMITTANCE_LINE_MAX) lines.push(flat.slice(i, i + REMITTANCE_LINE_MAX));
        // Longer than four lines can hold: the rest stays in the last line, where the form flags it
        if (lines.length > REMITTANCE_LINES) lines = [...lines.slice(0, REMITTANCE_LINES - 1), lines.slice(REMITTANCE_LINES - 1).join("")];
    }
    return Array.from({ length: REMITTANCE_LINES }, (_, i) => lines[i] ?? "");
}

/**
 * SEPA countries outside the EEA (EPC list of SEPA countries). Transfers there may need the
 * payee's BIC; within the EEA the IBAN is enough.
 */
const NON_EEA_SEPA = new Set(["AD", "AL", "CH", "GB", "GI", "MC", "MD", "ME", "MK", "RS", "SM", "VA"]);

/** Whether the form offers the BIC for this IBAN: its country is in SEPA but not in the EEA. */
export const needsBic = (iban: string): boolean => NON_EEA_SEPA.has(iban.replace(/\s/g, "").slice(0, 2).toUpperCase());

/** Form of a BIC: 8 or 11 letters and digits. */
export const BIC_PATTERN = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/;
