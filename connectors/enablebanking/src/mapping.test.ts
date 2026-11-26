import { describe, expect, it } from "vitest";
import { accountCurrency, bookingText, connectorBalance, connectorTransaction, connectorTransactions, decimalToCents, storedAccount, type EbTransaction } from "./mapping.js";
import { paypalAccount } from "./testing/index.js";

const TODAY = "2026-11-26";

describe("decimalToCents", () => {
    it("reads the decimals Enable Banking sends", () => {
        expect(decimalToCents("19.99")).toBe(1999);
        expect(decimalToCents("5")).toBe(500);
        expect(decimalToCents("0.5")).toBe(50);
        expect(decimalToCents("-3.00")).toBe(-300);
        expect(decimalToCents("1.005")).toBe(101);
        expect(decimalToCents("12,50")).toBeNull();
        expect(decimalToCents("")).toBeNull();
        expect(decimalToCents(null)).toBeNull();
    });
});

describe("storedAccount", () => {
    it("keeps a PayPal account without IBAN in euro as a current account", () => {
        const a = storedAccount({ ...paypalAccount().account, uid: "u1" }, "PayPal", true);
        expect(a).toMatchObject({
            hash: "hash-paypal-1",
            uid: "u1",
            externalId: "PAYPALACCOUNT00000000000001",
            accountNumber: "PAYPALACCOUNT00000000000001",
            iban: null,
            name: "PayPal",
            owner: "Alex Beispiel",
            currency: "EUR",
            kind: "giro",
            icon: "wallet",
        });
    });

    it("takes the IBAN as key and the kind from the cash account type", () => {
        const base = { identification_hash: "h", account_id: { iban: "DE02 1203 0000 0000 2020 51" }, currency: "EUR", product: "Tagesgeld" };
        const a = storedAccount({ ...base, cash_account_type: "SVGS" }, "Testbank", false);
        expect(a).toMatchObject({ externalId: "DE02120300000000202051", iban: "DE02120300000000202051", kind: "savings", name: "Testbank Tagesgeld" });
        expect(a.icon).toBeUndefined();
        expect(storedAccount({ ...base, cash_account_type: "CARD" }, "Testbank", true).kind).toBe("credit_card");
        expect(storedAccount({ ...base, cash_account_type: "LOAN" }, "Testbank", true).kind).toBe("loan");
        expect(storedAccount({ ...base, cash_account_type: "CACC" }, "Testbank", true).kind).toBe("giro");
        expect(storedAccount({ ...base, cash_account_type: "CASH" }, "Testbank", true).kind).toBe("giro");
    });

    it("finds a short stable key when the bank names no account at all", () => {
        const a = storedAccount({ identification_hash: "only-a-hash" }, "Testbank", true);
        expect(a.accountNumber).toMatch(/^[0-9a-f]{35}$/);
        expect(storedAccount({ identification_hash: "only-a-hash" }, "Testbank", true).accountNumber).toBe(a.accountNumber);
    });

    it("keeps known currencies and takes euro for several", () => {
        expect(accountCurrency("usd")).toBe("USD");
        expect(accountCurrency("XXX")).toBe("EUR");
        expect(accountCurrency(null)).toBe("EUR");
    });
});

describe("connectorBalance", () => {
    const account = storedAccount(paypalAccount().account, "PayPal", true);

    it("takes the instant balance when there is no booked one", () => {
        expect(connectorBalance(account, paypalAccount().balances, TODAY)).toEqual({
            externalId: account.externalId,
            booked: 12345,
            currency: "EUR",
            date: TODAY,
            pending: null,
            available: null,
            creditLine: null,
        });
    });

    it("prefers the booked balance and reports the available one beside it", () => {
        const b = connectorBalance(
            account,
            [
                { balance_type: "XPCD", balance_amount: { currency: "EUR", amount: "1.00" } },
                { balance_type: "ITAV", balance_amount: { currency: "EUR", amount: "250.00" } },
                { balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "200.00" }, reference_date: "2026-11-25" },
                { balance_type: "CLBD", balance_amount: { currency: "USD", amount: "999.00" } },
            ],
            TODAY,
        );
        expect(b).toMatchObject({ booked: 20000, available: 25000, date: "2026-11-25" });
    });

    it("gives none when no balance is in the account's currency", () => {
        expect(connectorBalance(account, [{ balance_type: "CLBD", balance_amount: { currency: "USD", amount: "1.00" } }], TODAY)).toBeNull();
    });
});

describe("connectorTransaction", () => {
    const [shop, refund, rejected, foreign] = paypalAccount().transactions;

    it("signs a debit, takes the transaction date and keeps the e-mail searchable", () => {
        const m = connectorTransaction(shop!, "EUR", TODAY);
        expect(m).toEqual({
            kind: "ok",
            tx: expect.objectContaining({
                bookingDate: "2026-11-20",
                valueDate: null,
                amount: -1999,
                currency: "EUR",
                status: "booked",
                counterpartyName: "Beispiel Shop GmbH",
                counterpartyIban: null,
                remittance: "shop@example.com",
                bookingText: "Zahlung",
                bankReference: "1AB23456CD789012E",
            }),
        });
    });

    it("names a credit by the debtor's e-mail when the name is missing", () => {
        const m = connectorTransaction(refund!, "EUR", TODAY);
        expect(m.kind === "ok" && m.tx).toMatchObject({ amount: 500, counterpartyName: "erika@example.com", remittance: "", bookingText: "Erstattung" });
    });

    it("leaves out bookings that move no money and counts other currencies", () => {
        expect(connectorTransaction(rejected!, "EUR", TODAY)).toEqual({ kind: "skipped" });
        expect(connectorTransaction({ ...shop!, status: "CNCL" }, "EUR", TODAY)).toEqual({ kind: "skipped" });
        expect(connectorTransaction({ ...shop!, status: "SCHD" }, "EUR", TODAY)).toEqual({ kind: "skipped" });
        expect(connectorTransaction(foreign!, "EUR", TODAY)).toEqual({ kind: "foreign_currency" });
    });

    it("marks pending bookings and prefers booking and value dates of other banks", () => {
        const m = connectorTransaction(
            {
                ...shop!,
                status: "PDNG",
                booking_date: "2026-11-21",
                value_date: "2026-11-22",
                remittance_information: ["Rechnung 4711", "Kunde 1"],
                creditor_account: { iban: "DE89370400440532013000" },
                creditor_agent: { bic_fi: "COBADEFFXXX" },
            },
            "EUR",
            TODAY,
        );
        expect(m.kind === "ok" && m.tx).toMatchObject({
            status: "pending",
            bookingDate: "2026-11-21",
            valueDate: "2026-11-22",
            remittance: "Rechnung 4711 Kunde 1 / shop@example.com",
            counterpartyIban: "DE89370400440532013000",
            counterpartyBic: "COBADEFFXXX",
        });
    });

    it("keeps a sign the bank sends itself", () => {
        const m = connectorTransaction({ ...shop!, transaction_amount: { currency: "EUR", amount: "-19.99" } }, "EUR", TODAY);
        expect(m.kind === "ok" && m.tx.amount).toBe(-1999);
    });
});

describe("bookingText", () => {
    it("takes the description, else the translated sub code, else the code", () => {
        expect(bookingText({ description: "Kartenzahlung", sub_code: "PAYMENT" })).toBe("Kartenzahlung");
        expect(bookingText({ code: "PAYMENT", sub_code: "MONEY_TRANSFER" })).toBe("Geldtransfer");
        expect(bookingText({ code: "PAYMENT", sub_code: "LOAN" })).toBe("Kredit");
        expect(bookingText({ code: "PMNT", sub_code: "ICDT" })).toBe("ICDT");
        expect(bookingText({ code: "PMNT" })).toBe("PMNT");
        expect(bookingText(null)).toBe("");
    });
});

describe("PayPal's own movements", () => {
    const tx = (dir: "DBIT" | "CRDT", sub: string, party: EbTransaction["creditor"], extra: Partial<EbTransaction> = {}): EbTransaction => ({
        entry_reference: `R${sub}${dir}`,
        transaction_amount: { currency: "EUR", amount: "50.00" },
        credit_debit_indicator: dir,
        status: "BOOK",
        transaction_date: "2026-11-10",
        [dir === "DBIT" ? "creditor" : "debtor"]: party,
        bank_transaction_code: { code: "PAYMENT", sub_code: sub },
        ...extra,
    });
    const mapped = (t: EbTransaction) => {
        const m = connectorTransaction(t, "EUR", TODAY);
        return m.kind === "ok" ? m.tx : null;
    };

    it("marks the repayment and other credit bookings of Pay in 30 days", () => {
        expect(mapped(tx("DBIT", "LOAN", { name: "PayPal (Europe) S.a r.l. et Cie, S.C.A." }))).toMatchObject({ transfer: "repayment", bookingText: "Rückzahlung Später bezahlen", amount: -5000 });
        expect(mapped(tx("CRDT", "LOAN", { name: "PayPal (Europe) S.a r.l. et Cie, S.C.A." }))).toMatchObject({ transfer: "credit", bookingText: "Später bezahlen" });
        expect(mapped(tx("DBIT", "LOAN", null))).toMatchObject({ transfer: "repayment" });
    });

    it("keeps a LOAN booking to a shop a purchase", () => {
        expect(mapped(tx("DBIT", "LOAN", { name: "Möbel Muster GmbH" }))).toMatchObject({ transfer: null, bookingText: "Kredit", counterpartyName: "Möbel Muster GmbH" });
    });

    it("names a payout to the own bank account", () => {
        expect(mapped(tx("DBIT", "MONEY_TRANSFER", {}))).toMatchObject({ transfer: "payout", bookingText: "Auszahlung auf Bankkonto", counterpartyName: "Bankkonto" });
        expect(mapped(tx("DBIT", "MONEY_TRANSFER", { name: "Erika Mustermann" }))).toMatchObject({ transfer: null, counterpartyName: "Erika Mustermann" });
    });

    it("leaves ordinary payments unmarked", () => {
        expect(mapped(tx("DBIT", "PAYMENT", { name: "Shop" }))).toMatchObject({ transfer: null, bookingText: "Zahlung" });
    });
});

describe("connectorTransactions", () => {
    const base = (ref: string, date: string, dir: "DBIT" | "CRDT", status: string, name: string, sub = "PAYMENT"): EbTransaction => ({
        entry_reference: ref,
        transaction_amount: { currency: "EUR", amount: "15.00" },
        credit_debit_indicator: dir,
        status,
        transaction_date: date,
        [dir === "DBIT" ? "creditor" : "debtor"]: { name },
        bank_transaction_code: { code: "PAYMENT", sub_code: sub },
    });

    it("marks the refund of a rejected payment of the same counterparty, on the day or later", () => {
        const { transactions } = connectorTransactions(
            [
                base("4", "2026-11-20", "CRDT", "BOOK", "Shop C", "REFUND"),
                base("3", "2026-11-12", "CRDT", "BOOK", "Shop D", "REFUND"),
                base("2", "2026-11-05", "DBIT", "RJCT", "Shop C"),
                base("1", "2026-11-05", "DBIT", "CNCL", "Shop D"),
            ],
            "EUR",
            TODAY,
        );
        expect(transactions.map((t) => [t.bankReference, t.transfer, t.bookingText])).toEqual([
            ["4", "refund", "Erstattung zu abgelehnter Zahlung"],
            ["3", "refund", "Erstattung zu abgelehnter Zahlung"],
        ]);
    });

    it("leaves a refund alone without such a payment: other counterparty, other amount, before it or too late", () => {
        const { transactions } = connectorTransactions(
            [
                base("5", "2026-12-30", "CRDT", "BOOK", "Shop C", "REFUND"),
                base("4", "2026-11-04", "CRDT", "BOOK", "Shop C", "REFUND"),
                { ...base("3", "2026-11-06", "CRDT", "BOOK", "Shop C", "REFUND"), transaction_amount: { currency: "EUR", amount: "14.00" } },
                base("2", "2026-11-06", "CRDT", "BOOK", "Shop X", "REFUND"),
                base("1", "2026-11-05", "DBIT", "RJCT", "Shop C"),
            ],
            "EUR",
            TODAY,
        );
        expect(transactions.map((t) => t.transfer)).toEqual([null, null, null, null]);
    });

    it("gives one rejected payment to one refund only, the earliest", () => {
        const { transactions } = connectorTransactions(
            [base("3", "2026-11-09", "CRDT", "BOOK", "Shop C"), base("2", "2026-11-07", "CRDT", "BOOK", "Shop C"), base("1", "2026-11-05", "DBIT", "RJCT", "Shop C")],
            "EUR",
            TODAY,
        );
        expect(transactions.map((t) => [t.bankReference, t.transfer])).toEqual([
            ["3", null],
            ["2", "refund"],
        ]);
    });

    it("uses what lies before the start only to find such payments", () => {
        const { transactions, foreignCurrency } = connectorTransactions(
            [
                base("3", "2026-11-12", "CRDT", "BOOK", "Shop C"),
                { ...base("2", "2026-11-03", "DBIT", "BOOK", "Shop E"), transaction_amount: { currency: "USD", amount: "1.00" } },
                base("1", "2026-11-01", "DBIT", "RJCT", "Shop C"),
            ],
            "EUR",
            TODAY,
            "2026-11-10",
        );
        expect(transactions.map((t) => [t.bankReference, t.transfer])).toEqual([["3", "refund"]]);
        expect(foreignCurrency).toBe(0);
    });
});
