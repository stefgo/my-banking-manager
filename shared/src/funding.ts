// Where PayPal took the money for a payment from, worked out from the balance: PayPal reports the
// payment, not the debit from the bank account or card that funded it. "Balance first": a payment
// takes what the PayPal balance holds, PayPal fetches the rest from outside. A purchase with
// "Pay in 30 days" is paid by the credit and takes nothing; its repayment about 30 days later is
// what PayPal fetches. Used by the server (derived bookings) and the connector's eb-info analysis.

export interface FundingItem {
    /** Signed, in cents. */
    amount: number;
    date: string;
    /** Bought with "Pay in 30 days": touches neither the balance nor the outside. */
    onCredit?: boolean;
    /** Never funded from outside (a payout to the bank account): takes the balance, even below zero. */
    noFunding?: boolean;
}

export interface FundingRun {
    /** The balance after the last item. */
    end: number;
    /** Per item: what PayPal fetched from outside for it (0 for credits and items on credit). */
    outside: number[];
}

const dayOf = (date: string): number => Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 86_400_000);

/** By date; on the same day credits first (money comes in before it goes out), else as given. */
export function fundingOrder<T extends { amount: number; date: string }>(items: readonly T[]): T[] {
    return items
        .map((item, i) => ({ item, i }))
        .sort((a, b) => a.item.date.slice(0, 10).localeCompare(b.item.date.slice(0, 10)) || Number(a.item.amount < 0) - Number(b.item.amount < 0) || a.i - b.i)
        .map((x) => x.item);
}

/** Runs items in the order given (see `fundingOrder`) from the balance `start`. */
export function runFunding(items: readonly FundingItem[], start: number): FundingRun {
    let balance = start;
    const outside = items.map((item) => {
        if (item.onCredit) return 0;
        if (item.amount >= 0) {
            balance += item.amount;
            return 0;
        }
        const need = -item.amount;
        if (item.noFunding) {
            balance -= need;
            return 0;
        }
        const take = Math.min(Math.max(balance, 0), need);
        balance -= take;
        return need - take;
    });
    return { end: balance, outside };
}

/** The smallest start balance ≥ 0 with which the run ends at `balance`; null if none does. */
export function minimalStart(items: readonly FundingItem[], balance: number): number | null {
    if (runFunding(items, 0).end > balance) return null;
    // The end grows with the start, by at most one cent per cent: the first start that reaches it hits it
    let lo = 0;
    let hi = Math.max(1, balance + items.reduce((sum, item) => sum + Math.abs(item.amount), 0));
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (runFunding(items, mid).end >= balance) hi = mid;
        else lo = mid + 1;
    }
    return runFunding(items, lo).end === balance ? lo : null;
}

/** Days from a purchase to its repayment with "Pay in 30 days" (seen: 29 and 30). */
export const PAY_LATER_DAYS = { min: 25, max: 35 } as const;

export interface PayLaterItem {
    amount: number;
    date: string;
    /** A repayment of "Pay in 30 days". */
    repayment: boolean;
    /** Could be a purchase: an ordinary payment. */
    purchase: boolean;
}

/**
 * Purchases with "Pay in 30 days", each with its repayment: a payment of the same amount 25–35 days
 * before the repayment, where exactly one fits (a subscription of the same amount every month must
 * not be taken for it). Each purchase goes to one repayment, earlier repayments first.
 */
export function payLaterPairs<T extends PayLaterItem>(items: readonly T[]): Map<T, T> {
    const pairs = new Map<T, T>(); // purchase → repayment
    const repayments = items.filter((r) => r.repayment && r.amount < 0).sort((a, b) => a.date.localeCompare(b.date));
    for (const r of repayments) {
        const day = dayOf(r.date);
        const fits = items.filter((p) => p.purchase && p.amount === r.amount && !pairs.has(p) && day - dayOf(p.date) >= PAY_LATER_DAYS.min && day - dayOf(p.date) <= PAY_LATER_DAYS.max);
        if (fits.length === 1) pairs.set(fits[0]!, r);
    }
    return pairs;
}
