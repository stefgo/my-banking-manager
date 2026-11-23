// Bookings that give back an earlier one: return debits, returned transfers, cancellations.

const RETURN_TEXT = /ruecklastschrift|rueckbuchung|rueckueberweisung|rueckgabe|retoure|storno/;

/** Does a bank's or a file's kind of booking name a return? */
export const isReturnText = (text: string | null | undefined): boolean =>
    RETURN_TEXT.test(
        (text ?? "")
            .normalize("NFC")
            .toLowerCase()
            .replace(/ü/g, "ue")
            .replace(/[^a-z]/g, ""),
    );

/** SEPA reason codes (ISO 20022) that returns commonly carry. */
const RETURN_REASONS: Readonly<Record<string, string>> = {
    AC01: "Kontokennung ungültig",
    AC04: "Konto geschlossen",
    AC06: "Konto gesperrt",
    AG01: "Für dieses Konto nicht zulässig",
    AG02: "Ungültiger Vorgang",
    AM04: "Keine Deckung",
    AM05: "Doppelte Einreichung",
    BE05: "Einreicher unbekannt",
    MD01: "Kein gültiges Mandat",
    MD02: "Mandatsdaten fehlen oder sind falsch",
    MD06: "Widerspruch des Zahlungspflichtigen",
    MD07: "Kontoinhaber verstorben",
    MS02: "Vom Kunden abgelehnt",
    MS03: "Grund von der Bank nicht genannt",
    RC01: "BIC ungültig",
    SL01: "Sperre oder besondere Vereinbarung der Bank",
};

/** The reason in words with its code; a code not known here stays as it is. */
export function returnReasonText(code: string): string {
    const c = code.trim();
    const text = RETURN_REASONS[c.toUpperCase()];
    return text ? `${text} (${c.toUpperCase()})` : c;
}
