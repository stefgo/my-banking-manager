export const cleanIban = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const groupIban = (s: string): string => cleanIban(s).replace(/(.{4})/g, "$1 ").trim();

/** Card number in blocks of four digits. */
export const groupCardNumber = (s: string): string => s.replace(/\s/g, "").replace(/(.{4})/g, "$1 ").trim();

function mod97(str: string): number {
    let r = 0;
    for (const ch of str) {
        const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
        for (const d of v) r = (r * 10 + Number(d)) % 97;
    }
    return r;
}

/**
 * Length of the IBAN per country code, from the SWIFT IBAN Registry (ISO 13616-2), 89 countries.
 * Territories without an entry of their own use their country's code (French overseas
 * territories FR, Isle of Man, Guernsey and Jersey GB, Åland FI).
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
    AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28,
    CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
    FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
    IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
    LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
    NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
    SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
    UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** The length an IBAN of this country has, or null for a code without IBAN. */
export const ibanLength = (raw: string): number | null => IBAN_LENGTHS[cleanIban(raw).slice(0, 2)] ?? null;

/**
 * What is wrong with an IBAN, as a sentence for the form; null when it is valid. Checks country
 * code, the length of that country, the characters and the check digits (ISO 7064 MOD 97-10).
 */
export function ibanProblem(raw: string): string | null {
    const s = cleanIban(raw);
    const cc = s.slice(0, 2);
    const len = IBAN_LENGTHS[cc];
    if (!/^[A-Z]{2}/.test(s)) return "Eine IBAN beginnt mit dem Länderkürzel, z. B. DE.";
    if (!len) return `Für „${cc}“ gibt es keine IBAN.`;
    if (s.length !== len) return `Eine IBAN aus ${cc} hat ${len} Zeichen, diese hat ${s.length}.`;
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s) || mod97(s.slice(4) + s.slice(0, 4)) !== 1) return "Die Prüfziffer stimmt nicht. Bitte die IBAN prüfen.";
    return null;
}

/** Checks country code, the length of that country and the check digits. */
export const isValidIban = (raw: string): boolean => ibanProblem(raw) === null;
