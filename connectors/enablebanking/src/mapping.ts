// From the answers of Enable Banking to the connector contract. The rules come from a look at real
// answers (PayPal, plan "PSD2 über Enable Banking", Schritt 0) and the Berlin-Group fields Enable
// Banking passes on; they hold for every bank, PayPal is the case they were checked against.

import { createHash } from "node:crypto";
import type { ConnectorAccount, ConnectorBalance, ConnectorTransaction } from "@mbm/shared";
import type { StoredAccount } from "./state.js";

// ---------- Answers of Enable Banking (only the fields used) ----------

export interface EbAmount {
    currency?: string | null;
    amount?: string | null;
}

export interface EbAccountId {
    iban?: string | null;
    other?: { identification?: string | null; scheme_name?: string | null } | null;
}

export interface EbAccount {
    uid?: string | null;
    account_id?: EbAccountId | null;
    all_account_ids?: { identification?: string | null; scheme_name?: string | null }[] | null;
    name?: string | null;
    details?: string | null;
    product?: string | null;
    cash_account_type?: string | null;
    currency?: string | null;
    identification_hash: string;
}

export interface EbBalance {
    balance_amount?: EbAmount | null;
    balance_type?: string | null;
    reference_date?: string | null;
    last_change_date_time?: string | null;
}

export interface EbParty {
    name?: string | null;
    contact_details?: { email_address?: string | null } | null;
}

export interface EbTransaction {
    entry_reference?: string | null;
    transaction_id?: string | null;
    transaction_amount?: EbAmount | null;
    credit_debit_indicator?: string | null;
    status?: string | null;
    booking_date?: string | null;
    value_date?: string | null;
    transaction_date?: string | null;
    creditor?: EbParty | null;
    debtor?: EbParty | null;
    creditor_account?: EbAccountId | null;
    debtor_account?: EbAccountId | null;
    creditor_agent?: { bic_fi?: string | null } | null;
    debtor_agent?: { bic_fi?: string | null } | null;
    bank_transaction_code?: { description?: string | null; code?: string | null; sub_code?: string | null } | null;
    remittance_information?: string[] | null;
    note?: string | null;
}

// ---------- Helpers ----------

const text = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");
const DATE = /^\d{4}-\d{2}-\d{2}/;
const dateOf = (v: string | null | undefined): string | null => (typeof v === "string" && DATE.test(v) ? v.slice(0, 10) : null);

/** Amount as Enable Banking sends it ("12.5", "-3.00") in cents; null if it is no decimal. */
export function decimalToCents(value: string | null | undefined): number | null {
    const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text(value));
    if (!m) return null;
    const fraction = (m[3] ?? "").padEnd(3, "0");
    let cents = Number(m[2]) * 100 + Number(fraction.slice(0, 2));
    if (Number(fraction[2]) >= 5) cents += 1; // half away from zero; banks send two places anyway
    return m[1] ? -cents : cents;
}

// ---------- Accounts ----------

/** Over PSD2 there are only payment accounts: whatever is not savings, card or loan is a current account. */
const KIND: Record<string, ConnectorAccount["kind"]> = { SVGS: "savings", CARD: "credit_card", LOAN: "loan" };

/** "XXX" stands for several currencies (PayPal); MBM keeps such an account in euro. */
export const accountCurrency = (currency: string | null | undefined): string => {
    const c = text(currency).toUpperCase();
    return /^[A-Z]{3}$/.test(c) && c !== "XXX" ? c : "EUR";
};

/** The account as the state keeps it; `aspsp` names the bank, `single` says it is the only account. */
export function storedAccount(a: EbAccount, aspsp: string, single: boolean): StoredAccount {
    const iban = text(a.account_id?.iban).replace(/\s/g, "").toUpperCase() || null;
    const other = text(a.account_id?.other?.identification) || text(a.all_account_ids?.[0]?.identification);
    // Without IBAN and identification: a stable short key from the hash Enable Banking keeps across sessions.
    const accountNumber = (other || iban || createHash("sha256").update(a.identification_hash).digest("hex")).slice(0, 35);
    const currency = accountCurrency(a.currency);
    const label = text(a.details) || text(a.product);
    return {
        hash: a.identification_hash,
        uid: text(a.uid) || null,
        externalId: iban ?? accountNumber,
        accountNumber,
        iban,
        name: single ? aspsp : `${aspsp} ${label || currency}`,
        // Enable Banking has no owner field; "name" is what the bank calls the account (PayPal: the holder).
        owner: text(a.name),
        currency,
        kind: KIND[text(a.cash_account_type).toUpperCase()] ?? "giro",
        ...(/paypal/i.test(aspsp) ? { icon: "wallet" } : {}),
    };
}

export function connectorAccount(s: StoredAccount): ConnectorAccount {
    return {
        accountNumber: s.accountNumber,
        subAccount: "",
        iban: s.iban,
        bic: null,
        externalId: s.externalId,
        name: s.name,
        owner: s.owner,
        currency: s.currency,
        kind: s.kind,
        capabilities: {
            balance: true,
            transactions: true,
            cardTransactions: false,
            transfer: false,
            instantTransfer: false,
            standingOrders: false,
            scheduledTransfers: false,
            standingOrdersTan: false,
            scheduledTransfersTan: false,
            payeeVerification: false,
            createScheduledTransfer: false,
            changeScheduledTransfer: false,
            deleteScheduledTransfer: false,
            createStandingOrder: false,
            changeStandingOrder: false,
            deleteStandingOrder: false,
            orderRules: null,
        },
        ...(s.icon ? { icon: s.icon } : {}),
    };
}

// ---------- Balances ----------

/** Which balance counts as the booked one, best first (PayPal sends only XPCD). */
const BOOKED_ORDER = ["CLBD", "ITBD", "XPCD", "CLAV", "ITAV", "OPBD", "PRCD", "VALU", "OTHR", "INFO", "FWAV", "OPAV"];
const AVAILABLE_ORDER = ["ITAV", "CLAV", "FWAV", "OPAV"];

export function connectorBalance(s: StoredAccount, balances: EbBalance[], today: string): ConnectorBalance | null {
    const usable = balances.filter((b) => text(b.balance_amount?.currency).toUpperCase() === s.currency && decimalToCents(b.balance_amount?.amount) !== null);
    const pick = (order: string[]) => order.map((t) => usable.find((b) => text(b.balance_type).toUpperCase() === t)).find((b) => b !== undefined);
    const booked = pick(BOOKED_ORDER) ?? usable[0];
    if (!booked) return null;
    const available = pick(AVAILABLE_ORDER.filter((t) => t !== text(booked.balance_type).toUpperCase()));
    return {
        externalId: s.externalId,
        booked: decimalToCents(booked.balance_amount?.amount)!,
        currency: s.currency,
        date: dateOf(booked.reference_date) ?? dateOf(booked.last_change_date_time) ?? today,
        pending: null,
        available: available ? decimalToCents(available.balance_amount?.amount) : null,
        creditLine: null,
    };
}

// ---------- Transactions ----------

/** Booking texts for the codes PayPal sends (code PAYMENT); other codes stay as they come. */
const SUB_CODE_TEXT: Record<string, string> = { PAYMENT: "Zahlung", REFUND: "Erstattung", LOAN: "Kredit", MONEY_TRANSFER: "Geldtransfer" };

export function bookingText(code: EbTransaction["bank_transaction_code"]): string {
    const description = text(code?.description);
    if (description) return description;
    const sub = text(code?.sub_code);
    if (sub) return SUB_CODE_TEXT[sub.toUpperCase()] ?? sub;
    return text(code?.code);
}

export type MappedTransaction = { kind: "ok"; tx: ConnectorTransaction } | { kind: "skipped" } | { kind: "foreign_currency" };

/** One booking; rejected, cancelled and scheduled ones move no money and are left out. */
export function connectorTransaction(t: EbTransaction, accountCurrencyCode: string, today: string): MappedTransaction {
    const status = text(t.status).toUpperCase();
    if (status !== "BOOK" && status !== "PDNG" && status !== "HOLD") return { kind: "skipped" };
    const currency = text(t.transaction_amount?.currency).toUpperCase();
    if (currency && currency !== accountCurrencyCode) return { kind: "foreign_currency" };
    const cents = decimalToCents(t.transaction_amount?.amount);
    if (cents === null) return { kind: "skipped" };
    const debit = text(t.credit_debit_indicator).toUpperCase() === "DBIT";
    // Banks send the amount without sign and the direction apart; a sign of their own is kept.
    const amount = debit ? -Math.abs(cents) : cents;
    const party = debit ? t.creditor : t.debtor;
    const account = debit ? t.creditor_account : t.debtor_account;
    const agent = debit ? t.creditor_agent : t.debtor_agent;
    const name = text(party?.name);
    const email = text(party?.contact_details?.email_address);
    const remittance = [...(t.remittance_information ?? []).map(text), text(t.note)].filter(Boolean).join(" ");
    return {
        kind: "ok",
        tx: {
            bookingDate: dateOf(t.booking_date) ?? dateOf(t.transaction_date) ?? dateOf(t.value_date) ?? today,
            valueDate: dateOf(t.value_date),
            amount,
            currency: currency || accountCurrencyCode,
            status: status === "BOOK" ? "booked" : "pending",
            counterpartyName: name || email,
            ultimateParty: "",
            counterpartyIban: text(account?.iban).replace(/\s/g, "").toUpperCase() || null,
            counterpartyBic: text(agent?.bic_fi) || null,
            counterpartyAccount: text(account?.other?.identification),
            counterpartyBankCode: "",
            // No purpose (PayPal): the e-mail of the counterparty keeps it searchable.
            remittance: [remittance, name && email ? email : ""].filter(Boolean).join(" / "),
            endToEndId: null,
            customerReference: null,
            mandateId: null,
            creditorId: null,
            bookingText: bookingText(t.bank_transaction_code),
            bankReference: text(t.entry_reference) || text(t.transaction_id) || null,
            isReturn: false,
            returnReason: "",
            replaces: null,
        },
    };
}
