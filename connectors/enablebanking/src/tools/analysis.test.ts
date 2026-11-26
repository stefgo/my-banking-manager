import { describe, expect, it } from "vitest";
import { analyse, bookingOf, chronological, simulate, startBalance } from "./analysis.js";

const HOLDER = "Alex Beispiel";

const tx = (ref: string, date: string, amount: string, dir: "DBIT" | "CRDT", sub: string, party: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    entry_reference: ref,
    transaction_amount: { currency: "EUR", amount },
    credit_debit_indicator: dir,
    status: "BOOK",
    transaction_date: date,
    [dir === "DBIT" ? "creditor" : "debtor"]: party,
    bank_transaction_code: { code: "PAYMENT", sub_code: sub },
    remittance_information: [],
    ...extra,
});

// Newest first, as banks answer. Invented: a payment from outside, Pay in 30 days (credit and
// repayment), a refund spent from the balance, a rejected payment tried again, a payout.
const bookings = [
    tx("9ZZ00000000000009", "2026-11-04", "50.00", "DBIT", "LOAN", { name: "PayPal (Europe) S.a r.l. et Cie, S.C.A." }),
    tx("8ZZ00000000000008", "2026-10-20", "12.00", "DBIT", "MONEY_TRANSFER", { name: HOLDER }),
    tx("8ZZ00000000000007", "2026-10-20", "12.00", "CRDT", "PAYMENT", { name: "Freundin Fiktiv", contact_details: { email_address: "f@example.com" } }),
    tx("7ZZ00000000000006", "2026-10-14", "7.50", "DBIT", "PAYMENT", { name: "Kiosk Erfunden" }),
    tx("6ZZ00000000000005", "2026-10-12", "7.50", "DBIT", "PAYMENT", { name: "Kiosk Erfunden" }, { status: "RJCT" }),
    tx("5ZZ00000000000004", "2026-10-12", "3.00", "DBIT", "PAYMENT", { name: "Bäckerei Probe" }),
    tx("4ZZ00000000000003", "2026-10-10", "5.00", "CRDT", "REFUND", { contact_details: { email_address: "erika@example.com" } }),
    tx("3ZZ00000000000002", "2026-10-05", "50.00", "DBIT", "PAYMENT", { name: "Möbel Muster GmbH", contact_details: { email_address: "shop@example.com" } }),
    tx("2ZZ00000000000001", "2026-10-05", "50.00", "CRDT", "LOAN", { name: "PayPal (Europe) S.a r.l. et Cie, S.C.A." }),
    tx("1ZZ00000000000000", "2026-10-01", "19.99", "DBIT", "PAYMENT", { name: "Shop Beispiel" }, { merchant_category_code: "5732" }),
];
const balances = [{ balance_type: "XPCD", balance_amount: { currency: "EUR", amount: "0.00" } }];

describe("analyse", () => {
    const text = analyse({ transactions: bookings, balances, accountName: HOLDER }).join("\n");

    it("shows no names, e-mail addresses, amounts, dates or references", () => {
        for (const secret of ["Alex", "Beispiel", "Möbel", "Kiosk", "Fiktiv", "erika", "example.com", "19.99", "1999", "50.00", "5000", "2026-", "ZZ0000", "5732", "Europe"]) {
            expect(text).not.toContain(secret);
        }
    });

    it("reconciles the balance under 'balance first'", () => {
        // From the balance: the 50.00 after the loan credit, the 3.00 after the refund, the 12.00 payout
        // after the 12.00 received; partly: 7.50 with 2.00 left; from outside: 19.99 and the repayment.
        expect(text).toMatch(/balance first\s+start zero; from balance 3, partly 1, all from outside 2/);
        expect(text).toMatch(/balance first[^\n]*\n\s+fetched for\s+PAYMENT\/DBIT 2, LOAN\/DBIT 1/);
    });

    it("finds bookings that belong together and how far apart they are", () => {
        expect(text).toMatch(/LOAN\/CRDT → PAYMENT\/DBIT, opposite, same day\s+1/);
        expect(text).toMatch(/PAYMENT\/DBIT → LOAN\/DBIT, same sign, 26–35 days\s+1/);
        expect(text).toMatch(/LOAN\/CRDT → LOAN\/DBIT, opposite, 26–35 days\s+1/);
    });

    it("tells counterparties apart without naming them", () => {
        expect(text).toMatch(/LOAN\/CRDT\s+PayPal 1/);
        expect(text).toMatch(/MONEY_TRANSFER\/DBIT, party holder, own side empty\s+1/);
        expect(text).toMatch(/REFUND\/CRDT\s+e-mail only 1/);
    });

    it("describes each LOAN booking and its neighbours", () => {
        expect(text).toMatch(/LOAN 1: LOAN\/CRDT\s+party PayPal; own side empty; same amount: none before, PAYMENT\/DBIT same day, none after; other LOAN: LOAN\/DBIT \+30 d/);
        expect(text).toMatch(/LOAN 2: LOAN\/DBIT\s+party PayPal; .*same amount: PAYMENT\/DBIT 30 d before, none same day, none after/);
    });

    it("lists filled fields MBM does not read and bookings that were not booked", () => {
        expect(text).toMatch(/merchant_category_code\s+1\/10/);
        expect(text).toMatch(/PAYMENT\/DBIT RJCT\s+booked twin PAYMENT\/DBIT \+2 d/);
        expect(text).toMatch(/order of the answer\s+newest first/);
    });

    it("says when the balance cannot come from the bookings", () => {
        const high = analyse({ transactions: bookings, balances: [{ balance_type: "XPCD", balance_amount: { currency: "EUR", amount: "-1.00" } }], accountName: HOLDER }).join("\n");
        expect(high).toMatch(/balance first\s+does not add up/);
    });
});

describe("Pay in 30 days and refunded payments", () => {
    const d = (n: number) => new Date(Date.UTC(2026, 2, 1 + n)).toISOString().slice(0, 10);
    const list = [
        tx("L3", d(40), "10.00", "CRDT", "LOAN", { name: "PayPal Europe" }),
        tx("L2", d(32), "20.00", "DBIT", "LOAN", { name: "PayPal Europe" }),
        tx("L1", d(29), "40.00", "DBIT", "LOAN", { name: "PayPal Europe" }),
        tx("C1", d(20), "25.00", "CRDT", "PAYMENT", { name: "Freund Fiktiv" }),
        tx("R2", d(15), "15.00", "CRDT", "REFUND", { name: "Shop C" }),
        tx("R1", d(10), "10.00", "CRDT", "REFUND", { name: "Shop B" }),
        tx("M1", d(9), "25.00", "DBIT", "MONEY_TRANSFER", {}),
        tx("X1", d(5), "15.00", "DBIT", "PAYMENT", { name: "Shop C" }, { status: "RJCT" }),
        tx("P2", d(2), "30.00", "DBIT", "PAYMENT", { name: "Shop B" }),
        tx("P1", d(0), "40.00", "DBIT", "PAYMENT", { name: "Shop A" }),
    ];
    const text = analyse({ transactions: list, balances: [{ balance_type: "XPCD", balance_amount: { currency: "EUR", amount: "10.00" } }], accountName: HOLDER }).join("\n");

    it("pairs a repayment with its purchase and explains one without", () => {
        expect(text).toMatch(/Pay in 30 days purchases found\s+1/);
        expect(text).toMatch(/repayments with exactly one purchase\s+1, after 29 d 1/);
        expect(text).toMatch(/unpaired LOAN\/DBIT\s+purchase 30 d before minus a refund of the same counterparty/);
        expect(text).toMatch(/LOAN\/CRDT\s+8 d after a repayment, smaller; that repayment has no unique purchase/);
    });

    it("finds refunded payments among the rejected ones and payouts that cannot be", () => {
        expect(text).toMatch(/RJCT\/CNCL debits with a refund after\s+1/);
        expect(text).toMatch(/PAYMENT\/DBIT RJCT\s+no booked twin within 10 days; refund REFUND\/CRDT \+10 d same counterparty/);
        expect(text).toMatch(/balance first[^\n]*\n[^\n]*\n\s+implausible\s+1 payout/);
    });

    it("shows none of the names", () => {
        for (const secret of ["Shop", "Freund", "Europe", "2026-"]) expect(text).not.toContain(secret);
    });
});

describe("repayments without a purchase of their amount", () => {
    const d = (n: number) => new Date(Date.UTC(2026, 2, 1 + n)).toISOString().slice(0, 10);

    it("finds purchases that add up to it", () => {
        const list = [
            tx("L1", d(30), "35.00", "DBIT", "LOAN", { name: "PayPal Europe" }),
            tx("P2", d(10), "15.00", "DBIT", "PAYMENT", { name: "Shop B" }),
            tx("P1", d(0), "20.00", "DBIT", "PAYMENT", { name: "Shop A" }),
        ];
        const text = analyse({ transactions: list, balances: [], accountName: HOLDER }).join("\n");
        expect(text).toMatch(/unpaired LOAN\/DBIT\s+2 payment\(s\) PAYMENT\/DBIT 20 d \+ PAYMENT\/DBIT 30 d before add up to it/);
    });

    it("says so plainly when nothing fits", () => {
        const list = [tx("L1", d(30), "35.00", "DBIT", "LOAN", { name: "PayPal Europe" }), tx("P1", d(0), "70.00", "DBIT", "PAYMENT", { name: "Shop A" })];
        const text = analyse({ transactions: list, balances: [], accountName: HOLDER }).join("\n");
        expect(text).toMatch(/unpaired LOAN\/DBIT\s+no fit; purchases in the window: 1, it is 50 % of the largest; 30 d after the first booking; 50 % of the median payment/);
        const none = analyse({ transactions: [list[0]!], balances: [], accountName: HOLDER }).join("\n");
        expect(none).toMatch(/no fit; purchases in the window: 0; 0 d after the first booking; – of the median payment/);
    });
});

describe("balance after the booking", () => {
    it("tells debits paid from outside by an unchanged balance", () => {
        const withAfter = [
            tx("B2", "2026-10-03", "4.00", "DBIT", "PAYMENT", { name: "X" }, { balance_after_transaction: { currency: "EUR", amount: "6.00" } }),
            tx("B1", "2026-10-02", "9.00", "DBIT", "PAYMENT", { name: "Y" }, { balance_after_transaction: { currency: "EUR", amount: "10.00" } }),
            tx("B0", "2026-10-01", "10.00", "CRDT", "PAYMENT", { name: "Z" }, { balance_after_transaction: { currency: "EUR", amount: "10.00" } }),
        ];
        const text = analyse({ transactions: withAfter, balances: [{ balance_type: "XPCD", balance_amount: { currency: "EUR", amount: "6.00" } }], accountName: HOLDER }).join("\n");
        expect(text).toMatch(/booked bookings with it\s+3\/3/);
        expect(text).toMatch(/PAYMENT\/DBIT\s+moved by the booking 1, unchanged \(all from outside\) 1/);
        expect(text).toMatch(/last one equals the balance now\s+yes/);
    });
});

describe("simulate and startBalance", () => {
    const b = (day: string, cents: string, dir: "DBIT" | "CRDT", i: number) => bookingOf(tx(`R${i}`, day, cents, dir, "PAYMENT", {}), i, "")!;

    it("puts credits before debits on the same day", () => {
        const list = chronological([b("2026-10-01", "5.00", "DBIT", 0), b("2026-10-01", "5.00", "CRDT", 1)]);
        expect(list.map((x) => x.debit)).toEqual([false, true]);
    });

    it("finds the smallest start balance that ends at the balance", () => {
        const list = chronological([b("2026-10-01", "10.00", "DBIT", 0), b("2026-10-02", "4.00", "DBIT", 1)]);
        // Balance now 6.00: a start of 20.00 pays both from the balance (20 − 10 − 4); nothing smaller ends there.
        expect(startBalance(list, 600)).toBe(2000);
        expect(simulate(list, 2000)).toMatchObject({ end: 600, fromBalance: 2, external: 0, funded: 0 });
        // Balance now 0: both from outside, the start stays 0.
        expect(startBalance(list, 0)).toBe(0);
        expect(simulate(list, 0)).toMatchObject({ external: 2, funded: 1400 });
    });
});
