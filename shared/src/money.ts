// Amounts are whole cents everywhere (server, API, clients). Only EUR exists in v1.

const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

/** "1.234,56 €", with a real minus sign for negative amounts. */
export function formatCents(cents: number): string {
    return (cents < 0 ? "−" : "") + eur.format(Math.abs(cents) / 100);
}

/** "+1.234,56 €" / "−12,30 €" / "0,00 €". */
export function formatSignedCents(cents: number): string {
    return (cents > 0 ? "+" : cents < 0 ? "−" : "") + eur.format(Math.abs(cents) / 100);
}

/** The decimal separator of an amount; "auto" tells it from the form of the number. */
export type DecimalSeparator = "auto" | "," | ".";

/**
 * Reads an amount as people and banks write it: "1.234,56", "-12,3", "12.30", "1,234.56",
 * "−5 €", "(12,00)". Returns cents, or null when the text is no amount.
 */
export function parseAmount(input: string, decimal: DecimalSeparator = "auto"): number | null {
    let s = input.trim().replace(/[\s\u00a0€]|EUR/gi, "").replace(/[−–]/g, "-");
    if (!s) return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) {
        negative = true;
        s = s.slice(1, -1);
    }
    if (s.startsWith("-")) {
        negative = !negative;
        s = s.slice(1);
    } else if (s.startsWith("+")) {
        s = s.slice(1);
    } else if (s.endsWith("-")) {
        negative = !negative;
        s = s.slice(0, -1);
    }
    if (!/^[\d.,']+$/.test(s)) return null;
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    let decimalSep: string | null = null;
    if (decimal !== "auto") {
        // A fixed decimal separator appears once at most; the other one groups thousands
        if (s.indexOf(decimal) !== s.lastIndexOf(decimal)) return null;
        decimalSep = s.includes(decimal) ? decimal : null;
    } else if (lastComma >= 0 && lastDot >= 0) {
        decimalSep = lastComma > lastDot ? "," : ".";
    } else if (lastComma >= 0) {
        // "12,5" or "12,50" is a decimal comma; "1,234" alone is ambiguous and read as German too
        decimalSep = ",";
    } else if (lastDot >= 0) {
        // "1.234" (exactly three digits after a single dot) is a German thousands separator
        const parts = s.split(".");
        decimalSep = parts.length === 2 && parts[1]!.length !== 3 ? "." : null;
    }
    let intPart = s;
    let fracPart = "";
    if (decimalSep) {
        const at = s.lastIndexOf(decimalSep);
        intPart = s.slice(0, at);
        fracPart = s.slice(at + 1);
    }
    intPart = intPart.replace(/[.,']/g, "");
    if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart) || fracPart.length > 2) return null;
    if (!intPart && !fracPart) return null;
    const cents = Number(intPart || "0") * 100 + Number(fracPart.padEnd(2, "0") || "0");
    if (!Number.isSafeInteger(cents)) return null;
    return negative ? -cents : cents;
}

/** Cents as an editable German number without currency: 123456 → "1.234,56". */
export function centsToInput(cents: number): string {
    const s = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(cents) / 100);
    return (cents < 0 ? "-" : "") + s;
}

/** An amount as typed, completed to whole cents once it reads as one: "1" → "1,00", "1,1" → "1,10". */
export function completeAmountInput(input: string): string {
    const cents = parseAmount(input);
    return cents === null ? input : centsToInput(cents);
}
