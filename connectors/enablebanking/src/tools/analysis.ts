// What the form of the answers cannot tell: which bookings belong together (same amount within a
// few days), whether the balance adds up with the bookings, who the counterparties are, how
// PayPal's "Pay in 30 days" (sub code LOAN) shows. The output holds counts, day spans and shares
// only, never names, e-mail addresses, amounts, dates or references. Used by eb-info.

import { minimalStart, PAY_LATER_DAYS, payLaterPairs as sharedPayLaterPairs, runFunding } from "@mbm/shared";
import { decimalToCents } from "../mapping.js";

type Raw = Record<string, unknown>;

export interface Booking {
    /** Position in the bank's answer. */
    index: number;
    status: string;
    debit: boolean;
    /** Signed, in cents. */
    cents: number;
    currency: string;
    /** Days since 1970-01-01; NaN without any date. */
    day: number;
    /** The date as sent (YYYY-MM-DD), "" without one. */
    date: string;
    hasTime: boolean;
    subCode: string;
    /** Sub code and direction, with the status unless booked: "PAYMENT/DBIT", "LOAN/CRDT RJCT". */
    cls: string;
    /** Who the counterparty is: holder, PayPal, name, e-mail only, empty. */
    party: string;
    /** The counterparty's name or e-mail, normalised: only compared, never shown. */
    partyKey: string;
    /** The own side (debtor of a debit, creditor of a credit): filled at all? */
    ownSide: string;
    balanceAfter: number | null;
}

export interface AnalysisInput {
    transactions: Raw[];
    balances: Raw[];
    /** The name of the account as the bank sends it; PayPal: the holder. Only compared, never shown. */
    accountName: string;
}

// ---------- Reading ----------

const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Raw)[k] : undefined), o);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function partyClass(party: unknown, holder: string): string {
    const name = str(at(party, "name"));
    const email = str(at(party, "contact_details.email_address"));
    if (!name && !email) return "empty";
    if (name && holder && norm(name) === norm(holder)) return "holder";
    if (/paypal/i.test(name) || /@paypal\./i.test(email)) return "PayPal";
    return name ? "name" : "e-mail only";
}

function partyKey(party: unknown): string {
    return norm(str(at(party, "name")) || str(at(party, "contact_details.email_address")));
}

function ownSideClass(party: unknown, account: unknown, holder: string): string {
    const filled = [str(at(account, "iban")) && "IBAN", str(at(account, "other.identification")) && "other id"].filter(Boolean);
    const p = partyClass(party, holder);
    if (p === "empty" && !filled.length) return "empty";
    return [p === "empty" ? "" : `party ${p}`, ...filled].filter(Boolean).join(" + ");
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
function dayOf(v: string): number {
    const m = DAY.exec(v);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 : NaN;
}

export function bookingOf(t: Raw, index: number, holder: string): Booking | null {
    const unsigned = decimalToCents(str(at(t, "transaction_amount.amount")));
    if (unsigned === null) return null;
    const debit = str(t.credit_debit_indicator).toUpperCase() === "DBIT";
    const status = str(t.status).toUpperCase() || "?";
    const subCode = str(at(t, "bank_transaction_code.sub_code")).toUpperCase() || str(at(t, "bank_transaction_code.code")).toUpperCase() || "?";
    const date = [t.booking_date, t.transaction_date, t.value_date].map(str).find(Boolean) ?? "";
    const after = decimalToCents(str(at(t, "balance_after_transaction.amount")));
    return {
        index,
        status,
        debit,
        cents: debit ? -Math.abs(unsigned) : unsigned,
        currency: str(at(t, "transaction_amount.currency")).toUpperCase(),
        day: dayOf(date),
        date: date.slice(0, 10),
        hasTime: date.length > 10,
        subCode,
        cls: `${subCode}/${debit ? "DBIT" : "CRDT"}${status === "BOOK" ? "" : ` ${status}`}`,
        party: partyClass(debit ? t.creditor : t.debtor, holder),
        partyKey: partyKey(debit ? t.creditor : t.debtor),
        ownSide: ownSideClass(debit ? t.debtor : t.creditor, debit ? t.debtor_account : t.creditor_account, holder),
        balanceAfter: after,
    };
}

// ---------- Helpers ----------

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const listing = (m: Map<string, number>) => sorted(m).map(([k, n]) => `${k} ${n}`).join(", ") || "–";
/** A share of `whole`, rounded; amounts themselves are never shown. */
const share = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((100 * part) / whole)} %`);

function lagBucket(days: number): string {
    if (days === 0) return "same day";
    if (days <= 3) return "1–3 days";
    if (days <= 10) return "4–10 days";
    if (days <= 25) return "11–25 days";
    if (days <= 35) return "26–35 days";
    return "36–45 days";
}

/** Chronological; on the same day credits first (money comes in before it goes out), then the bank's order. */
export function chronological(bookings: Booking[]): Booking[] {
    return [...bookings].sort((a, b) => a.day - b.day || Number(a.debit) - Number(b.debit) || a.index - b.index);
}

// ---------- Balance ----------

export interface Simulation {
    end: number;
    fromBalance: number;
    partly: number;
    external: number;
    funded: number;
}

/**
 * Runs the booked bookings from `start` under "balance first" (`runFunding` in shared, as the
 * server derives its bookings). Debits in `onCredit` (bought with "Pay in 30 days") touch neither
 * the balance nor the outside.
 */
export function simulate(bookings: Booking[], start: number, onCredit: ReadonlySet<Booking> = new Set()): Simulation & { fetchedFor: Map<string, number> } {
    const run = runFunding(fundingItems(bookings, onCredit), start);
    const r = { end: run.end, fromBalance: 0, partly: 0, external: 0, funded: 0, fetchedFor: new Map<string, number>() };
    bookings.forEach((b, i) => {
        if (!b.debit || onCredit.has(b)) return;
        const outside = run.outside[i]!;
        r.funded += outside;
        if (outside === 0) r.fromBalance++;
        else {
            if (outside === -b.cents) r.external++;
            else r.partly++;
            bump(r.fetchedFor, b.cls);
        }
    });
    return r;
}

const fundingItems = (bookings: Booking[], onCredit: ReadonlySet<Booking>) => bookings.map((b) => ({ amount: b.cents, date: b.date, onCredit: onCredit.has(b) }));

/** The smallest start balance ≥ 0 with which the run ends at `balance`; null if even 0 ends above it. */
export function startBalance(bookings: Booking[], balance: number, onCredit: ReadonlySet<Booking> = new Set()): number | null {
    return minimalStart(fundingItems(bookings, onCredit), balance);
}

/**
 * Purchases with "Pay in 30 days" (`payLaterPairs` in shared): a booked LOAN debit to PayPal and,
 * 25–35 days before it, the one booked payment of the same amount.
 */
export function payLaterPairs(bookings: Booking[]): Map<Booking, Booking> {
    const items = bookings.map((b) => ({
        b,
        amount: b.cents,
        date: b.date,
        repayment: b.status === "BOOK" && b.subCode === "LOAN" && b.debit && b.party === "PayPal",
        purchase: b.status === "BOOK" && b.subCode === "PAYMENT" && b.debit,
    }));
    return new Map([...sharedPayLaterPairs(items.filter((i) => i.date))].map(([p, r]) => [p.b, r.b]));
}

function currentBalance(balances: Raw[], currency: string): { type: string; cents: number } | null {
    const usable = balances
        .map((b) => ({ type: str(b.balance_type).toUpperCase(), currency: str(at(b, "balance_amount.currency")).toUpperCase(), cents: decimalToCents(str(at(b, "balance_amount.amount"))) }))
        .filter((b): b is { type: string; currency: string; cents: number } => b.cents !== null && b.currency === currency);
    for (const type of ["CLBD", "ITBD", "XPCD", "CLAV", "ITAV"]) {
        const b = usable.find((x) => x.type === type);
        if (b) return b;
    }
    return usable[0] ?? null;
}

/** Up to `max` bookings whose amounts add up to `target` (the first found, fewest first); null if none. */
export function subsetSum(items: Booking[], target: number, max: number): Booking[] | null {
    for (let size = 1; size <= max; size++) {
        const pick = (from: number, left: number, sum: number, chosen: Booking[]): Booking[] | null => {
            if (left === 0) return sum === target ? chosen : null;
            for (let i = from; i < items.length; i++) {
                const found = pick(i + 1, left - 1, sum + items[i]!.cents, [...chosen, items[i]!]);
                if (found) return found;
            }
            return null;
        };
        const found = pick(0, size, 0, []);
        if (found) return found;
    }
    return null;
}

/** A booked credit of the same amount within 45 days after a debit (on the same day too): a refund? */
export function refundOf(b: Booking, all: Booking[]): Booking | undefined {
    return all
        .filter((x) => x !== b && x.status === "BOOK" && !x.debit && x.cents === -b.cents && x.day >= b.day && x.day - b.day <= 45)
        .sort((x, y) => Number(y.partyKey === b.partyKey) - Number(x.partyKey === b.partyKey) || x.day - y.day)[0];
}

// ---------- Fields MBM does not read ----------

/** What `mapping.ts` reads of a booking. */
const MAPPED = new Set([
    "entry_reference",
    "transaction_id",
    "transaction_amount.amount",
    "transaction_amount.currency",
    "credit_debit_indicator",
    "status",
    "booking_date",
    "value_date",
    "transaction_date",
    "creditor.name",
    "creditor.contact_details.email_address",
    "debtor.name",
    "debtor.contact_details.email_address",
    "creditor_account.iban",
    "debtor_account.iban",
    "creditor_account.other.identification",
    "debtor_account.other.identification",
    "creditor_agent.bic_fi",
    "debtor_agent.bic_fi",
    "bank_transaction_code.code",
    "bank_transaction_code.sub_code",
    "bank_transaction_code.description",
    "remittance_information[]",
    "note",
]);

function filledLeaves(v: unknown, path: string, out: Set<string>): void {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v)) for (const el of v) filledLeaves(el, `${path}[]`, out);
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) filledLeaves(x, path ? `${path}.${k}` : k, out);
    else out.add(path);
}

// ---------- Analysis ----------

export function analyse(input: AnalysisInput): string[] {
    const out: string[] = [];
    const head = (title: string) => out.push("", `  -- ${title} --`);
    const line = (label: string, text: string) => out.push(`  ${label.padEnd(36)} ${text}`);

    const all = input.transactions.map((t, i) => bookingOf(t, i, input.accountName)).filter((b): b is Booking => b !== null);
    const unreadable = input.transactions.length - all.length;
    const currencies = new Map<string, number>();
    for (const b of all) bump(currencies, b.currency || "none");
    const currency = sorted(currencies)[0]?.[0] ?? "EUR";
    const booked = chronological(all.filter((b) => b.status === "BOOK" && b.currency === currency && !Number.isNaN(b.day)));

    head("Bookings");
    line("readable / without amount", `${all.length} / ${unreadable}`);
    line("currencies", listing(currencies));
    const classes = new Map<string, number>();
    for (const b of all) bump(classes, b.cls);
    line("sub code/direction (status)", listing(classes));
    line("with time of day", `${all.filter((b) => b.hasTime).length}`);
    const perDay = new Map<number, Booking[]>();
    for (const b of booked) perDay.set(b.day, [...(perDay.get(b.day) ?? []), b]);
    const mixedDays = [...perDay.values()].filter((d) => d.some((b) => b.debit) && d.some((b) => !b.debit)).length;
    line("days with several bookings", `${[...perDay.values()].filter((d) => d.length > 1).length} (with credit and debit: ${mixedDays})`);
    const days = all.filter((b) => !Number.isNaN(b.day)).map((b) => b.day);
    const desc = days.every((d, i) => i === 0 || d <= days[i - 1]!);
    const asc = days.every((d, i) => i === 0 || d >= days[i - 1]!);
    line("order of the answer", desc && asc ? "one day only" : desc ? "newest first" : asc ? "oldest first" : "mixed");

    head("Counterparty (creditor of a debit, debtor of a credit)");
    const parties = new Map<string, Map<string, number>>();
    const own = new Map<string, Map<string, number>>();
    for (const b of all) {
        if (!parties.has(b.cls)) parties.set(b.cls, new Map());
        if (!own.has(b.cls)) own.set(b.cls, new Map());
        bump(parties.get(b.cls)!, b.party);
        bump(own.get(b.cls)!, b.ownSide);
    }
    for (const [cls, m] of [...parties].sort((a, b) => a[0].localeCompare(b[0]))) line(cls, listing(m));
    head("Own side (debtor of a debit, creditor of a credit): a funding source would be here");
    for (const [cls, m] of [...own].sort((a, b) => a[0].localeCompare(b[0]))) line(cls, listing(m));

    head("Filled fields MBM does not read");
    const extra = new Map<string, number>();
    for (const t of input.transactions) {
        const leaves = new Set<string>();
        filledLeaves(t, "", leaves);
        for (const p of leaves) if (!MAPPED.has(p)) bump(extra, p);
    }
    if (!extra.size) out.push("  none");
    for (const [p, n] of sorted(extra)) line(p, `${n}/${input.transactions.length}`);

    head("Balance after the booking (balance_after_transaction)");
    const withAfter = booked.filter((b) => b.balanceAfter !== null);
    line("booked bookings with it", `${withAfter.length}/${booked.length}`);
    if (withAfter.length > 1) {
        // Between two neighbours with a balance, it should move by the booking; where it moves less, PayPal fetched money.
        // A booking without balance in between makes the pair not comparable.
        const moves = new Map<string, Map<string, number>>();
        let gaps = 0;
        for (let i = 1; i < booked.length; i++) {
            const prev = booked[i - 1]!;
            const b = booked[i]!;
            if (b.balanceAfter === null || prev.balanceAfter === null) {
                if (b.balanceAfter !== null || prev.balanceAfter !== null) gaps++;
                continue;
            }
            const delta = b.balanceAfter - prev.balanceAfter;
            const kind = delta === b.cents ? "moved by the booking" : b.debit && delta === 0 ? "unchanged (all from outside)" : b.debit && delta > b.cents && delta < 0 ? "moved less (partly from outside)" : "other";
            if (!moves.has(b.cls)) moves.set(b.cls, new Map());
            bump(moves.get(b.cls)!, kind);
        }
        for (const [cls, m] of [...moves].sort((a, b) => a[0].localeCompare(b[0]))) line(cls, listing(m));
        if (gaps) line("not comparable (neighbour without)", String(gaps));
        const last = withAfter[withAfter.length - 1]!.balanceAfter!;
        const now = currentBalance(input.balances, currency);
        if (now) line("last one equals the balance now", last === now.cents ? "yes" : "no");
        // Same day: is the bank's order the order of the balances? Then it is the time order.
        let fits = 0;
        let sameDay = 0;
        for (const d of perDay.values()) {
            const withB = d.filter((b) => b.balanceAfter !== null);
            if (withB.length < 2) continue;
            sameDay++;
            const byAnswer = [...withB].sort((a, b) => b.index - a.index); // assume newest first
            const chain = byAnswer.every((b, i) => i === 0 || b.balanceAfter! - byAnswer[i - 1]!.balanceAfter! === b.cents);
            const chainRev = [...byAnswer].reverse().every((b, i, arr) => i === 0 || b.balanceAfter! - arr[i - 1]!.balanceAfter! === b.cents);
            if (chain || chainRev) fits++;
        }
        if (sameDay) line("same-day order follows the balance", `${fits}/${sameDay} days`);
    }

    head(`Balance against the bookings (${currency}, booked only)`);
    const balance = currentBalance(input.balances, currency);
    const debits = booked.filter((b) => b.debit).reduce((s, b) => s - b.cents, 0);
    const credits = booked.filter((b) => !b.debit).reduce((s, b) => s + b.cents, 0);
    line("debits / credits (count)", `${booked.filter((b) => b.debit).length} / ${booked.filter((b) => !b.debit).length}`);
    line("credits as share of debits", share(credits, debits));
    if (!balance) out.push(`  no balance in ${currency}`);
    else {
        line("balance used", `${balance.type}, ${balance.cents === 0 ? "zero" : balance.cents > 0 ? "positive" : "negative"}, ${share(Math.abs(balance.cents), debits)} of the debits`);
        const implied = balance.cents - (credits - debits);
        line("start balance from the sum", `${implied === 0 ? "zero" : implied > 0 ? "positive" : "negative"}, ${share(Math.abs(implied), debits)} of the debits`);
        // Variants: plain "balance first"; purchases with Pay in 30 days paid by the credit; on top
        // of that, rejected or cancelled payments with a refund afterwards taken as having happened.
        const payLater = payLaterPairs(all);
        const onCredit = new Set(payLater.keys());
        const reversed = all.filter((b) => (b.status === "RJCT" || b.status === "CNCL") && b.debit && refundOf(b, all) !== undefined);
        const withReversed = chronological([...booked, ...reversed.filter((b) => !Number.isNaN(b.day))]);
        const variants: [string, Booking[], ReadonlySet<Booking>][] = [
            ["balance first", booked, new Set()],
            ["+ Pay in 30 days on credit", booked, onCredit],
            ["+ refunded RJCT/CNCL as paid", withReversed, onCredit],
        ];
        line("Pay in 30 days purchases found", String(onCredit.size));
        line("RJCT/CNCL debits with a refund after", String(reversed.length));
        for (const [name, list, credit] of variants) {
            const vDebits = list.filter((b) => b.debit && !credit.has(b)).reduce((sum, b) => sum - b.cents, 0);
            const start = startBalance(list, balance.cents, credit);
            if (start === null) {
                const at0 = simulate(list, 0, credit);
                line(name, `does not add up: from 0 it ends above the balance by ${share(at0.end - balance.cents, vDebits)} of the debits`);
                continue;
            }
            const r = simulate(list, start, credit);
            line(name, `start ${start === 0 ? "zero" : `positive (${share(start, vDebits)} of the debits)`}; from balance ${r.fromBalance}, partly ${r.partly}, all from outside ${r.external}; fetched ${share(r.funded, vDebits)} of the debits`);
            line("  fetched for", listing(r.fetchedFor));
            const transferOut = r.fetchedFor.get("MONEY_TRANSFER/DBIT") ?? 0;
            if (transferOut) line("  implausible", `${transferOut} payout(s) to the bank would need money from outside`);
        }
    }

    head("Same amount within 45 days (earlier → later)");
    const pairs = new Map<string, number>();
    const partnered = new Set<Booking>();
    const dated = chronological(all.filter((b) => !Number.isNaN(b.day)));
    for (let i = 0; i < dated.length; i++) {
        for (let j = i + 1; j < dated.length && dated[j]!.day - dated[i]!.day <= 45; j++) {
            const a = dated[i]!;
            const b = dated[j]!;
            if (Math.abs(a.cents) !== Math.abs(b.cents)) continue;
            bump(pairs, `${a.cls} → ${b.cls}, ${a.cents === b.cents ? "same sign" : "opposite"}, ${lagBucket(b.day - a.day)}`);
            partnered.add(a);
            partnered.add(b);
        }
    }
    if (!pairs.size) out.push("  none");
    for (const [k, n] of sorted(pairs)) line(k, String(n));
    const alone = new Map<string, number>();
    for (const b of dated) if (!partnered.has(b)) bump(alone, b.cls);
    line("without such a partner", listing(alone));

    head("LOAN (Pay in 30 days, instalments?)");
    const loans = dated.filter((b) => b.subCode === "LOAN");
    if (!loans.length) out.push("  none");
    loans.forEach((l, n) => {
        // The nearest booking of another kind with the same amount, within 60 days: before, on the same day, after
        const near = (side: -1 | 0 | 1) => {
            const c = dated.filter((b) => b !== l && b.subCode !== "LOAN" && Math.abs(b.cents) === Math.abs(l.cents) && Math.sign(b.day - l.day) === side && Math.abs(b.day - l.day) <= 60);
            const best = c.sort((a, b) => Math.abs(a.day - l.day) - Math.abs(b.day - l.day))[0];
            const where = side === 0 ? "same day" : side < 0 ? "before" : "after";
            return best ? `${best.cls} ${side === 0 ? "same day" : `${Math.abs(best.day - l.day)} d ${where}`}` : `none ${where}`;
        };
        const otherLoan = dated.filter((b) => b !== l && b.subCode === "LOAN" && Math.abs(b.cents) === Math.abs(l.cents)).map((b) => `${b.cls} ${b.day - l.day >= 0 ? "+" : ""}${b.day - l.day} d`);
        line(`LOAN ${n + 1}: ${l.cls}`, `party ${l.party}; own side ${l.ownSide}; same amount: ${near(-1)}, ${near(0)}, ${near(1)}${otherLoan.length ? `; other LOAN: ${otherLoan.slice(0, 4).join(", ")}${otherLoan.length > 4 ? " …" : ""}` : ""}`);
    });
    // Instalments: equal LOAN debits about a month apart
    const series = new Map<number, Booking[]>();
    for (const l of loans.filter((b) => b.debit && b.status === "BOOK")) series.set(-l.cents, [...(series.get(-l.cents) ?? []), l]);
    const monthly = [...series.values()].filter((s) => s.length > 1 && s.every((b, i) => i === 0 || (b.day - s[i - 1]!.day >= 25 && b.day - s[i - 1]!.day <= 35)));
    if (loans.length) line("monthly series of equal LOAN debits", monthly.length ? monthly.map((s) => `${s.length}×`).join(", ") : "none");
    if (loans.length) {
        const firstDay = Math.min(...dated.map((b) => b.day));
        const debitsSorted = dated.filter((b) => b.debit && b.status === "BOOK" && b.subCode === "PAYMENT").map((b) => -b.cents).sort((a, b) => a - b);
        const medianDebit = debitsSorted[Math.floor(debitsSorted.length / 2)] ?? 0;
        const pairs30 = payLaterPairs(all);
        const paired = new Set(pairs30.values());
        const lags = new Map<string, number>();
        for (const [p, r] of pairs30) bump(lags, `${r.day - p.day} d`);
        line("repayments with exactly one purchase", `${paired.size}, after ${listing(lags)}`);
        const samePartyRefunds = [...pairs30.keys()].filter((p) => all.some((c) => !c.debit && c.status === "BOOK" && c.partyKey === p.partyKey && c.day >= p.day && c.day - p.day <= 90)).length;
        line("of their purchases later refunded", `${samePartyRefunds} (credit from the same counterparty within 90 days)`);
        // Repayments without a purchase of the same amount: what else could they be?
        for (const r of loans.filter((b) => b.debit && b.status === "BOOK" && !paired.has(b))) {
            const purchases = all.filter((p) => p.status === "BOOK" && p.subCode === "PAYMENT" && p.debit && r.day - p.day >= 0 && r.day - p.day <= 60);
            const window = purchases.filter((p) => r.day - p.day >= PAY_LATER_DAYS.min && r.day - p.day <= PAY_LATER_DAYS.max);
            const hints: string[] = [];
            const sameAmount = purchases.filter((p) => p.cents === r.cents).map((p) => r.day - p.day);
            if (sameAmount.length) hints.push(`same amount ${sameAmount.map((d) => `${d} d`).join("/")} before (outside the window or not unique)`);
            const minusRefund = window.find((p) => all.some((c) => !c.debit && c.status === "BOOK" && c.partyKey === p.partyKey && c.day >= p.day && c.day <= r.day && p.cents + c.cents === r.cents));
            if (minusRefund) hints.push(`purchase ${r.day - minusRefund.day} d before minus a refund of the same counterparty`);
            // Wider: up to three payments (booked, rejected or cancelled) in the 45 days before add up to it
            const recent = all.filter((p) => p.debit && p.subCode === "PAYMENT" && r.day - p.day >= 0 && r.day - p.day <= 45);
            const subset = subsetSum(recent, r.cents, 3);
            // One alone is the same amount, which the other hints name already
            if (subset && subset.length > 1) hints.push(`${subset.length} payment(s) ${subset.map((p) => `${p.cls} ${r.day - p.day} d`).join(" + ")} before add up to it`);
            const lone = all.filter((p) => p.debit && p.status !== "BOOK" && p.cents === r.cents && Math.abs(r.day - p.day) <= 60);
            if (lone.length) hints.push(`same amount as ${lone.map((p) => `${p.cls} ${r.day - p.day} d before`).join(", ")}`);
            if (!hints.length) {
                const largest = Math.max(0, ...window.map((p) => -p.cents));
                hints.push(`no fit; purchases in the window: ${window.length}${largest ? `, it is ${share(-r.cents, largest)} of the largest` : ""}`);
            }
            hints.push(`${r.day - firstDay} d after the first booking`, `${share(-r.cents, medianDebit)} of the median payment`);
            line(`  unpaired ${r.cls}`, hints.join("; "));
        }
        for (const c of loans.filter((b) => !b.debit)) {
            const before = all.filter((b) => b.subCode === "LOAN" && b.debit && b.status === "BOOK" && b.day <= c.day).sort((a, b) => b.day - a.day)[0];
            const where = `${c.day - firstDay} d after the first booking, ${share(c.cents, medianDebit)} of the median payment`;
            if (!before) {
                const sameDayCredit = all.some((x) => x !== c && !x.debit && x.day === c.day);
                line(`  ${c.cls}`, `no LOAN debit before it; ${where}${sameDayCredit ? "; another credit on that day" : ""}`);
                continue;
            }
            const purchase = [...pairs30].find(([, r]) => r === before)?.[0];
            const refund = purchase && all.find((x) => !x.debit && x.status === "BOOK" && x.subCode !== "LOAN" && x.partyKey === purchase.partyKey && x.day >= purchase.day && x.day - purchase.day <= 120);
            line(
                `  ${c.cls}`,
                `${c.day - before.day} d after a repayment, ${c.cents === -before.cents ? "same amount" : c.cents < -before.cents ? "smaller" : "larger"}; ` +
                    (purchase ? (refund ? `its purchase was refunded ${refund.day - before.day >= 0 ? "after" : "before"} the repayment, ${refund.cents === c.cents ? "by this amount" : "by another amount"}` : "its purchase has no refund") : "that repayment has no unique purchase"),
            );
        }
    }

    head("MONEY_TRANSFER");
    const transfers = all.filter((b) => b.subCode === "MONEY_TRANSFER");
    if (!transfers.length) out.push("  none");
    const transferKinds = new Map<string, number>();
    for (const b of transfers) bump(transferKinds, `${b.cls}, party ${b.party}, own side ${b.ownSide}`);
    for (const [k, n] of sorted(transferKinds)) line(k, String(n));

    head("Not booked");
    const notBooked = all.filter((b) => b.status !== "BOOK");
    if (!notBooked.length) out.push("  none");
    for (const b of notBooked) {
        const twin = all.find((x) => x !== b && x.status === "BOOK" && x.cents === b.cents && !Number.isNaN(x.day) && Math.abs(x.day - b.day) <= 10);
        const refund = refundOf(b, all);
        const sameParty = all.some((x) => x !== b && x.status === "BOOK" && x.partyKey === b.partyKey && Math.abs(x.day - b.day) <= 45);
        line(
            b.cls,
            [
                twin ? `booked twin ${twin.cls} ${twin.day - b.day >= 0 ? "+" : ""}${twin.day - b.day} d` : "no booked twin within 10 days",
                refund ? `refund ${refund.cls} +${refund.day - b.day} d${refund.partyKey === b.partyKey ? " same counterparty" : ""}` : "no refund within 45 days",
                sameParty ? "other booked bookings with that counterparty" : "",
            ]
                .filter(Boolean)
                .join("; "),
        );
    }
    return out;
}
