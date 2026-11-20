// Credit card transactions: HIKKU v1 (standard, answer to HKKKU) and DIKKU v2 (proprietary
// predecessor, answer to DKKKU). Neither is in the DK documents at hand; the layouts follow
// lib-fints and hbci4java, which agree.
//
// Segment elements (both): card number, account id / reference, balance
// (C/D:amount:currency:date[:time]), two dates (HIKKU: last and next statement), then one group
// per booking. The booking groups differ.
//
// HIKKU booking:
//   0 card number   1 receipt date   2 booking date   3 statement date   4 value date
//   5–8 original amount, currency, C/D mark, exchange rate (empty in account currency)
//   9 amount  10 currency  11 C/D mark  12–19 description lines  20 country  21 merchant
//   22 terminal  23 billed J/N  24 booking reference
//
// DIKKU booking:
//   0 card number   1 booking date   2 value date   3 reference
//   4–7 original amount, currency, C/D mark, exchange rate
//   8 amount  9 currency  10 C/D mark  11 purpose  12 location  13–19 details  20 billed J/N
//
// Some banks send a signed amount in addition to the C/D mark; the mark decides.

import { dat, text, wrtCents } from "../syntax/formats.js";
import type { Element, Segment } from "../syntax/types.js";
import { emptyTransaction, type Transaction } from "./transaction.js";

export interface CardBalance {
    cents: number;
    currency: string;
    date: string | null;
}

export interface CardStatement {
    cardNumber: string;
    balance: CardBalance | null;
    transactions: Transaction[];
}

export function parseCardStatement(s: Segment): CardStatement {
    const e = s.elements;
    return {
        cardNumber: text(e[0]),
        balance: balance(e[2]),
        transactions: e.slice(5).map(s.id === "DIKKU" ? dikkuBooking : hikkuBooking).filter((t): t is Transaction => t !== null),
    };
}

function balance(el: Element | undefined): CardBalance | null {
    const mark = text(el, 0);
    const cents = unsigned(el, 1);
    if (!mark || cents === null) return null;
    return { cents: mark === "D" ? -cents : cents, currency: text(el, 2) || "EUR", date: safe(() => dat(el, 3)) };
}

function hikkuBooking(el: Element): Transaction | null {
    const booked = safe(() => dat(el, 2)) ?? safe(() => dat(el, 1));
    const cents = unsigned(el, 9);
    if (!booked || cents === null) return null;
    const lines: string[] = [];
    for (let i = 12; i <= 19; i++) if (text(el, i).trim()) lines.push(text(el, i).trim());
    const merchant = text(el, 21).trim();
    return {
        ...emptyTransaction(),
        bookingDate: booked,
        valueDate: safe(() => dat(el, 4)),
        amount: text(el, 11) === "D" ? -cents : cents,
        currency: text(el, 10) || "EUR",
        status: "booked",
        counterpartyName: merchant || lines[0] || "",
        remittance: lines.join(" "),
        bookingText: "Kartenumsatz",
        bankReference: text(el, 24).trim() || null,
    };
}

function dikkuBooking(el: Element): Transaction | null {
    const valueDate = safe(() => dat(el, 2));
    const booked = safe(() => dat(el, 1)) ?? valueDate;
    const cents = unsigned(el, 8);
    if (!booked || cents === null) return null;
    const purpose = text(el, 11).trim();
    const location = text(el, 12).trim();
    return {
        ...emptyTransaction(),
        bookingDate: booked,
        valueDate,
        amount: text(el, 10) === "D" ? -cents : cents,
        currency: text(el, 9) || "EUR",
        status: "booked",
        counterpartyName: purpose || location,
        remittance: [purpose, location].filter(Boolean).join(" "),
        bookingText: "Kartenumsatz",
        bankReference: text(el, 3).trim() || null,
    };
}

/** Amount without sign (wrt, tolerating a leading + or -); null if empty or unreadable. */
function unsigned(el: Element | undefined, i: number): number | null {
    const t = text(el, i).trim().replace(/^[+-]/, "");
    return safe(() => wrtCents([t], 0));
}

function safe<T>(f: () => T): T | null {
    try {
        return f();
    } catch {
        return null;
    }
}
