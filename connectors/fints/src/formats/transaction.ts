// The one transaction format every statement format is turned into (same as the contract).

import type { ConnectorTransaction } from "@mbm/shared";

export type Transaction = ConnectorTransaction;

export const emptyTransaction = (): Transaction => ({
    bookingDate: "",
    valueDate: null,
    amount: 0,
    currency: "EUR",
    status: "booked",
    counterpartyName: "",
    counterpartyIban: null,
    counterpartyBic: null,
    remittance: "",
    endToEndId: null,
    mandateId: null,
    creditorId: null,
    bookingText: "",
    bankReference: null,
});

/** SEPA references that are no references (DFÜ-Abkommen fill value). */
export const cleanRef = (s: string | null | undefined): string | null => {
    const t = (s ?? "").trim();
    return t === "" || t === "NOTPROVIDED" ? null : t;
};

/**
 * Splits structured remittance as banks put it into MT940 :86: and camt "Ustrd" lines:
 * "EREF+…", "MREF+…", "CRED+…", "SVWZ+…" (DFÜ-Abkommen, SEPA identifiers).
 */
export function splitSepaPurpose(text: string): { remittance: string; endToEndId: string | null; mandateId: string | null; creditorId: string | null; name: string | null } {
    const re = /(EREF|KREF|MREF|CRED|DEBT|SVWZ|ABWA|ABWE|COAM|OAMT|BREF|IBAN|BIC)\+/g;
    const marks = [...text.matchAll(re)];
    if (marks.length === 0 || marks[0]!.index !== 0) {
        return { remittance: text.trim(), endToEndId: null, mandateId: null, creditorId: null, name: null };
    }
    const parts: Record<string, string> = {};
    marks.forEach((m, i) => {
        const start = m.index! + m[0].length;
        const end = i + 1 < marks.length ? marks[i + 1]!.index! : text.length;
        parts[m[1]!] = text.slice(start, end).trim();
    });
    return {
        remittance: parts.SVWZ ?? "",
        endToEndId: cleanRef(parts.EREF),
        mandateId: cleanRef(parts.MREF),
        creditorId: cleanRef(parts.CRED),
        name: parts.ABWA || null,
    };
}
