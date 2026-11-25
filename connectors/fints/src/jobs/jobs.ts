// The fetch jobs on top of an open dialog: accounts, balances, transactions, card transactions.
// `send` sends segments and returns the bank's answer once any approval is done.

import type { ConnectorAccount, ConnectorAccountRef, ConnectorBalance, ConnectorScheduledTransfer, ConnectorStandingOrder } from "@mbm/shared";
import type { BankMessage } from "../message/read.js";
import { negotiate, type BankParameters } from "../segments/bpd.js";
import { accountClass, type UpdAccount } from "../segments/upd.js";
import {
    CAZ_VERSIONS, KAZ_VERSIONS, SAL_VERSIONS, SPA_VERSIONS,
    camtFormats, dkkku, hkcaz, hkkaz, hkkku, hksal, hkspa, parseHicaz, parseHikaz, parseHisal, parseHispa,
    type JobAccount, type SepaAccount,
} from "./../segments/jobs.js";
import { vopParameters } from "../segments/payments.js";
import { CDB_VERSIONS, CSB_VERSIONS, hkcdb, hkcsb, orderRules, painFormats, parseHicdb, parseHicsb } from "../segments/orders.js";
import { FintsSyntaxError, type Element, type SegmentInput } from "../syntax/types.js";
import { parseCamt } from "../formats/camt.js";
import { parseMt940 } from "../formats/mt940.js";
import { parseCardStatement } from "../formats/kku.js";
import { parsePain001, type Payment } from "../formats/pain001.js";
import type { Transaction } from "../formats/transaction.js";
import type { FintsState } from "../state.js";

export type Send = (segments: SegmentInput[]) => Promise<BankMessage>;

export class FintsNotSupportedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FintsNotSupportedError";
    }
}

/** Upper bound for pages of one job, against a bank that never stops sending touchdowns. */
const MAX_PAGES = 50;

/** Sends a job again with each touchdown point (3040) until the bank has sent everything. */
async function paged(send: Send, build: (touchdown?: string) => SegmentInput): Promise<BankMessage[]> {
    const out: BankMessage[] = [];
    let touchdown: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const m = await send([build(touchdown)]);
        out.push(m);
        touchdown = m.segmentCodes().find((c) => c.code === "3040")?.params[0];
        if (!touchdown) return out;
    }
    return out;
}

/** Whether the login may run `jobId` on this account (UPD, Formals E.2 „UPD-Verwendung“). */
function allowed(state: FintsState, acc: UpdAccount, jobId: string): boolean {
    if (!state.bpd?.jobs[jobId]) return false;
    if (acc.allowedJobs.some((j) => j.id === jobId)) return true;
    return state.upd ? !state.upd.unlistedBlocked : false;
}

const kindOf = (acc: UpdAccount): ConnectorAccount["kind"] => {
    const c = accountClass(acc.kontoart);
    if (c === "fixed_deposit" || c === "building_savings") return "savings";
    if (c === "fund") return "depot";
    if (c === "insurance") return "other";
    return c;
};

export const externalIdOf = (a: { iban: string | null; accountNumber: string; subAccount: string }): string =>
    a.iban || (a.subAccount ? `${a.accountNumber}/${a.subAccount}` : a.accountNumber);

/** Accounts from the UPD, with BIC and IBAN from HKSPA where the bank offers it. */
export async function fetchAccounts(send: Send, state: FintsState): Promise<ConnectorAccount[]> {
    const upd = state.upd;
    if (!upd || !state.bpd) return [];
    let sepa: SepaAccount[] = [];
    const spa = negotiate(state.bpd, "HKSPA", SPA_VERSIONS);
    if (spa) {
        const pages = await paged(send, (td) => hkspa(spa.version, td));
        sepa = pages.flatMap((m) => m.findAll("HISPA").flatMap(parseHispa));
    }
    const vop = vopParameters(state.bpd);
    const rules = orderRules(state.bpd);
    return upd.accounts
        .filter((a) => a.account || a.iban)
        .map((a) => {
            const number = a.account?.number ?? "";
            const sub = a.account?.subAccount ?? "";
            const s = sepa.find((x) => (a.iban && x.iban === a.iban) || (x.accountNumber === number && x.subAccount === sub));
            const iban = a.iban || s?.iban || null;
            const ref = { accountNumber: number || iban || "", subAccount: sub, iban, bic: s?.bic || null };
            const card = allowed(state, a, "HKKKU") || allowed(state, a, "DKKKU");
            return {
                ...ref,
                externalId: externalIdOf(ref),
                name: a.productName || (a.kontoart && accountClass(a.kontoart) === "credit_card" ? "Kreditkarte" : "Konto"),
                owner: [a.owner, a.owner2].filter(Boolean).join(" "),
                currency: a.currency || "EUR",
                kind: kindOf(a),
                capabilities: {
                    balance: allowed(state, a, "HKSAL"),
                    transactions: allowed(state, a, "HKCAZ") || allowed(state, a, "HKKAZ"),
                    cardTransactions: card,
                    transfer: allowed(state, a, "HKCCS"),
                    instantTransfer: allowed(state, a, "HKIPZ"),
                    standingOrders: allowed(state, a, "HKCDB"),
                    scheduledTransfers: allowed(state, a, "HKCSB"),
                    standingOrdersTan: state.bpd?.pinTan?.tanRequired.HKCDB === true,
                    scheduledTransfersTan: state.bpd?.pinTan?.tanRequired.HKCSB === true,
                    payeeVerification: vop?.jobs.includes("HKCCS") === true,
                    createScheduledTransfer: allowed(state, a, "HKCSE"),
                    changeScheduledTransfer: allowed(state, a, "HKCSA"),
                    deleteScheduledTransfer: allowed(state, a, "HKCSL"),
                    createStandingOrder: allowed(state, a, "HKCDE"),
                    changeStandingOrder: allowed(state, a, "HKCDN"),
                    deleteStandingOrder: allowed(state, a, "HKCDL"),
                    orderRules: ["HKCSE", "HKCSA", "HKCDE", "HKCDN"].some((j) => allowed(state, a, j)) ? rules : null,
                },
            };
        });
}

export const jobAccount = (a: ConnectorAccountRef, blz: string): JobAccount => ({ ...a, subAccount: a.subAccount ?? "", blz });

export function requireJob(bpd: BankParameters | null, id: string, versions: number[]) {
    const job = bpd ? negotiate(bpd, id, versions) : null;
    if (!job) throw new FintsNotSupportedError(`Die Bank bietet ${id} nicht an.`);
    return job;
}

export async function fetchBalance(send: Send, state: FintsState, blz: string, account: ConnectorAccountRef): Promise<ConnectorBalance> {
    const job = requireJob(state.bpd, "HKSAL", SAL_VERSIONS);
    const m = await send([hksal(job.version, jobAccount(account, blz))]);
    const hisal = m.findAll("HISAL").map(parseHisal).find((b) => b !== null);
    if (!hisal) throw new FintsNotSupportedError("Die Bank hat keinen Saldo geliefert.");
    return { externalId: externalIdOf({ ...account, subAccount: account.subAccount ?? "" }), ...hisal };
}

/** Booked and pending transactions; camt where offered, MT940 otherwise. */
export async function fetchTransactions(send: Send, state: FintsState, blz: string, account: ConnectorAccountRef, from?: string, to?: string): Promise<Transaction[]> {
    const a = jobAccount(account, blz);
    const caz = state.bpd ? negotiate(state.bpd, "HKCAZ", CAZ_VERSIONS) : null;
    const formats = caz ? camtFormats(caz.params) : [];
    if (caz && formats.length > 0) {
        const pages = await paged(send, (td) => hkcaz(a, formats, from, to, td));
        return pages.flatMap((m) =>
            m.findAll("HICAZ").flatMap((s) => {
                const { booked, pending } = parseHicaz(s);
                return [...booked.flatMap((d) => parseCamt(d, "booked")), ...(pending ? parseCamt(pending, "pending") : [])];
            }),
        );
    }
    const kaz = requireJob(state.bpd, "HKKAZ", KAZ_VERSIONS);
    const pages = await paged(send, (td) => hkkaz(kaz.version, a, from, to, td));
    return pages.flatMap((m) =>
        m.findAll("HIKAZ").flatMap((s) => {
            const { booked, pending } = parseHikaz(s);
            return [...(booked ? parseMt940(booked, "booked") : []), ...(pending ? parseMt940(pending, "pending") : [])];
        }),
    );
}

/** Credit card transactions over HKKKU (standard) or DKKKU (older). */
export async function fetchCardTransactions(send: Send, state: FintsState, blz: string, account: ConnectorAccountRef, from?: string, to?: string): Promise<{ transactions: Transaction[]; balance: ConnectorBalance | null }> {
    const a = jobAccount(account, blz);
    const standard = state.bpd ? negotiate(state.bpd, "HKKKU", [1]) : null;
    const old = state.bpd ? negotiate(state.bpd, "DKKKU", [2]) : null;
    if (!standard && !old) throw new FintsNotSupportedError("Die Bank bietet keine Kreditkartenumsätze an.");
    const pages = await paged(send, (td) => (standard ? hkkku(a, from, to, td) : dkkku(a, from, td)));
    const statements = pages.flatMap((m) => [...m.findAll("HIKKU"), ...m.findAll("DIKKU")]).map(parseCardStatement);
    const first = statements[0]?.balance;
    return {
        transactions: statements.flatMap((s) => s.transactions),
        balance: first
            ? { externalId: externalIdOf({ ...account, subAccount: account.subAccount ?? "" }), booked: first.cents, currency: first.currency, date: first.date, pending: null, available: null, creditLine: null }
            : null,
    };
}

/** The one payment of an order's pain message. */
function paymentOf(pain: Uint8Array | null, what: string): Payment {
    const payment = pain ? parsePain001(pain)[0] : undefined;
    if (!payment) throw new FintsSyntaxError(`${what} without a readable pain message`);
    return payment;
}

const orderBase = (p: Payment, s: { orderId: string | null; canChange: boolean | null; canDelete: boolean | null }) => ({
    bankOrderId: s.orderId,
    payeeName: p.payeeName,
    payeeIban: p.payeeIban,
    payeeBic: p.payeeBic,
    amount: p.amount,
    currency: p.currency,
    remittance: p.remittance,
    endToEndId: p.endToEndId,
    canChange: s.canChange,
    canDelete: s.canDelete,
});

/** The pain formats to name in a list request; the bank answers in one of them. */
function listFormats(state: FintsState, job: ReturnType<typeof requireJob>): string[] {
    const formats = state.bpd ? painFormats(state.bpd, job) : [];
    if (formats.length === 0) throw new FintsNotSupportedError("Die Bank nennt kein Format für SEPA-Überweisungen.");
    return formats;
}

/** An order as listed, with the pain message the bank sent: a change or deletion needs both. */
export interface Listed<T> {
    order: T;
    descriptor: string;
    pain: Uint8Array;
    /** Standing orders: the Dauerauftragdetails as the bank sent them. */
    details: Element | null;
}

/** Standing orders of an account, as they would run at their next date (HKCDB). */
export async function listStandingOrders(send: Send, state: FintsState, blz: string, account: ConnectorAccountRef): Promise<Listed<ConnectorStandingOrder>[]> {
    const job = requireJob(state.bpd, "HKCDB", CDB_VERSIONS);
    const formats = listFormats(state, job);
    const a = jobAccount(account, blz);
    const pages = await paged(send, (td) => hkcdb(a, formats, td));
    return pages.flatMap((m) =>
        m.findAll("HICDB").map((seg) => {
            const s = parseHicdb(seg);
            const p = paymentOf(s.pain, "HICDB");
            if (!s.firstDate || !s.unit || !s.every || !s.executionDay) throw new FintsSyntaxError("HICDB without Dauerauftragdetails");
            // The 31st is to be coded as the last day of the month (99); some banks send 31 all the same.
            const executionDay = s.unit === "month" && s.executionDay === 31 ? 99 : s.executionDay;
            return { order: { ...orderBase(p, s), firstDate: s.firstDate, unit: s.unit, every: s.every, executionDay, lastDate: s.lastDate }, descriptor: s.descriptor, pain: s.pain!, details: s.details };
        }),
    );
}

export const fetchStandingOrders = async (send: Send, state: FintsState, blz: string, account: ConnectorAccountRef): Promise<ConnectorStandingOrder[]> =>
    (await listStandingOrders(send, state, blz, account)).map((l) => l.order);

/** Scheduled transfers of an account that are still to be executed (HKCSB). */
export async function listScheduledTransfers(send: Send, state: FintsState, blz: string, account: ConnectorAccountRef): Promise<Listed<ConnectorScheduledTransfer>[]> {
    const job = requireJob(state.bpd, "HKCSB", CSB_VERSIONS);
    const formats = listFormats(state, job);
    const a = jobAccount(account, blz);
    const pages = await paged(send, (td) => hkcsb(job.version, a, formats, td));
    return pages.flatMap((m) =>
        m.findAll("HICSB").map((seg) => {
            const s = parseHicsb(seg);
            const p = paymentOf(s.pain, "HICSB");
            if (!p.executionDate) throw new FintsSyntaxError("HICSB without an execution date");
            return { order: { ...orderBase(p, s), executionDate: p.executionDate }, descriptor: s.descriptor, pain: s.pain!, details: null };
        }),
    );
}

export const fetchScheduledTransfers = async (send: Send, state: FintsState, blz: string, account: ConnectorAccountRef): Promise<ConnectorScheduledTransfer[]> =>
    (await listScheduledTransfers(send, state, blz, account)).map((l) => l.order);
