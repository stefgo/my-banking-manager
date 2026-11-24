// S.W.I.F.T. MT940 (booked) and MT942 (pending) as German banks deliver them over FinTS
// (HIKAZ, format "SRG 2001" with the SEPA allocation of the DFÜ-Abkommen).

import { isReturnText } from "@mbm/shared";
import { cleanAccountId, cleanRef, emptyTransaction, partiesOf, splitSepaPurpose, type Transaction } from "./transaction.js";

/** Business transaction code of a returned SEPA core direct debit. */
const GVC_RETURN_DEBIT = "109";

/** Parses all statements in an MT940/MT942 text into transactions. */
export function parseMt940(data: string | Uint8Array, status: "booked" | "pending"): Transaction[] {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
    const out: Transaction[] = [];
    let currency = "EUR";
    let current: Transaction | null = null;
    for (const field of fields(text)) {
        if (field.tag === "61") {
            current = parse61(field.value, currency, status);
            if (current) out.push(current);
            continue;
        }
        // A :86: belongs to the :61: right before it. One after the closing balance (:62F:,
        // :64:, …) is information on the whole statement and must not overwrite the last booking.
        if (field.tag === "86" && current) apply86(current, field.value);
        current = null;
        if (field.tag === "60F" || field.tag === "60M" || field.tag === "34F") {
            const m = /^[CD]?\d{0,6}([A-Z]{3})/.exec(field.value);
            if (m) currency = m[1]!;
        }
    }
    return out;
}

interface Field {
    tag: string;
    value: string;
}

/** Splits into fields ":tag:value"; a field continues on following lines that start no tag. */
function fields(text: string): Field[] {
    const out: Field[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\r$/, "");
        const m = /^:(\d\d[A-Z]?):(.*)$/.exec(line);
        if (m) out.push({ tag: m[1]!, value: m[2]! });
        else if (line === "-" || line.startsWith("@@")) continue;
        else if (out.length > 0) out[out.length - 1]!.value += "\n" + line;
    }
    return out;
}

/**
 * :61: value date YYMMDD, booking date MMDD (optional), mark C/D/RC/RD, funds code (optional),
 * amount "123,45", type N/F/S + 3 chars, customer reference, "//" bank reference, details.
 */
function parse61(value: string, currency: string, status: "booked" | "pending"): Transaction | null {
    const firstLine = value.split("\n")[0]!;
    const m = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([NSF][A-Z0-9]{3})(.*)$/.exec(firstLine);
    if (!m) return null;
    const [, vd, bd, mark, , amountText, , refs] = m;
    const valueDate = yymmdd(vd!);
    let bookingDate = valueDate;
    if (bd) {
        // The booking date has no year: take the value date's year, across a year boundary if needed.
        const y = Number(valueDate.slice(0, 4));
        const vm = Number(valueDate.slice(5, 7));
        const bm = Number(bd.slice(0, 2));
        const year = vm === 12 && bm === 1 ? y + 1 : vm === 1 && bm === 12 ? y - 1 : y;
        bookingDate = `${year}-${bd.slice(0, 2)}-${bd.slice(2, 4)}`;
    }
    const [whole, frac = ""] = amountText!.split(",");
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
    // RC (reversal of a credit) reduces the balance, RD (reversal of a debit) raises it.
    const negative = mark === "D" || mark === "RC";
    const [customerRef, bankRef] = (refs ?? "").split("//");
    return {
        ...emptyTransaction(),
        bookingDate,
        valueDate,
        amount: negative ? -cents : cents,
        currency,
        status,
        customerReference: customerRef?.trim() === "NONREF" ? null : cleanRef(customerRef),
        bankReference: bankRef?.trim() || null,
        isReturn: mark === "RC" || mark === "RD",
    };
}

const yymmdd = (s: string): string => {
    const yy = Number(s.slice(0, 2));
    return `${yy < 70 ? 2000 + yy : 1900 + yy}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
};

/**
 * :86: structured: GVC (3 digits), then subfields "?nn": 00 booking text, 10 primanota,
 * 20–29 and 60–63 remittance, 30 bank code/BIC, 31 account/IBAN, 32–33 name, 34 extra code.
 */
function apply86(t: Transaction, value: string): void {
    const v = value.replace(/\n/g, "");
    if (!/^\d{3}\?/.test(v) && !/^\d{3}$/.test(v)) {
        t.remittance = v.trim();
        return;
    }
    const sub: Record<string, string> = {};
    const purpose: string[] = [];
    // The separator is "?" by default; a few banks use another character, given right after the GVC.
    const sep = v[3] ?? "?";
    for (const part of v.slice(4).split(sep)) {
        const key = part.slice(0, 2);
        const content = part.slice(2);
        if (!/^\d\d$/.test(key)) continue;
        const n = Number(key);
        if ((n >= 20 && n <= 29) || (n >= 60 && n <= 63)) purpose.push(content);
        else sub[key] = (sub[key] ?? "") + content;
    }
    t.bookingText = (sub["00"] ?? "").trim();
    if (v.startsWith(GVC_RETURN_DEBIT) || isReturnText(t.bookingText)) t.isReturn = true;
    // Kept as sent: what these keys mean differs from the ISO codes of camt
    if (t.isReturn) t.returnReason = (sub["34"] ?? "").trim();
    const account = (sub["31"] ?? "").trim();
    const bank = (sub["30"] ?? "").trim();
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(account)) t.counterpartyIban = account;
    else {
        t.counterpartyAccount = cleanAccountId(account);
        if (/^\d{8}$/.test(bank)) t.counterpartyBankCode = cleanAccountId(bank);
    }
    if (/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bank)) t.counterpartyBic = bank;
    const sepa = splitSepaPurpose(purpose.join(""));
    t.remittance = sepa.remittance || purpose.join(" ").trim();
    t.endToEndId = sepa.endToEndId;
    // KREF of :86: is complete; :61: holds at most 16 characters, often of the EREF or the mandate
    const short = t.customerReference;
    const repeats = short !== null && [sepa.endToEndId, sepa.mandateId].some((r) => r?.startsWith(short));
    t.customerReference = sepa.customerReference ?? (repeats ? null : short);
    t.mandateId = sepa.mandateId;
    t.creditorId = sepa.creditorId;
    Object.assign(t, partiesOf(`${sub["32"] ?? ""}${sub["33"] ?? ""}`, sepa.ultimate));
}
