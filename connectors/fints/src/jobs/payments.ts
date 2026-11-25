// A SEPA credit transfer (HKCCS) or instant credit transfer (HKIPZ) with the verification of payee
// (Messages – VoP 1.02, C.10.7 and the PIN/TAN flows in E.8.1.1).
//
// The flow follows the bank's return codes, not the VoP result (E.8.1, point 5):
//   HKVPP + payment + HKTAN →
//     challenge (0030/3955)       name matches: approve; HKVPA goes along unless the bank sent 3091
//     3076, payment accepted      the bank needs no approval: done
//     HIVPP with polling ID       ask again with HKVPP alone until the result is complete, then
//                                 as above; looks the last answer like an accepted payment
//                                 (3076, 0020): outcome unknown, never sent again
//     otherwise (3090/3945)       the user confirms, then HKVPA + payment + HKTAN → approve
// Nothing is ever sent twice on its own. Once the payment is on its way, a lost answer means
// "outcome unknown".

import { randomUUID } from "node:crypto";
import {
    scheduledDateProblem, standingChangeProblem, standingOrderProblem, todayIso,
    type ConnectorAccountRef, type ConnectorScheduledTransfer, type ConnectorStandingOrder, type ConnectorTransfer, type ConnectorVop,
    type ExpectedScheduledTransfer, type ExpectedStandingOrder, type OrderWriteData, type ScheduledTransferWrite, type StandingOrderWrite, type TransferData, type VopResult,
} from "@mbm/shared";
import type { BankMessage } from "../message/read.js";
import { FintsBankError, FintsOrderChangedError, FintsOutcomeUnknownError, lostAnswer } from "../dialog/errors.js";
import type { JobIo } from "../operations/runner.js";
import { buildPain001, pickPainFormat, type PaymentOrder } from "../formats/pain001.js";
import { parsePain002 } from "../formats/pain002.js";
import {
    CDE_VERSIONS, CDL_VERSIONS, CDN_VERSIONS, CSA_VERSIONS, CSE_VERSIONS, CSL_VERSIONS,
    deleteNeedsData, hkcde, hkcdl, hkcdn, hkcsa, hkcse, hkcsl, orderRules, painFormats, parseOrderId,
} from "../segments/orders.js";
import { CCS_VERSIONS, IPZ_VERSIONS, VOP_ID_NOT_PROVIDED, hkccs, hkipz, hkvpa, hkvpp, parseHiipz, parseHivpp, vopParameters, type Hivpp } from "../segments/payments.js";
import type { JobAccount } from "../segments/jobs.js";
import { text } from "../syntax/formats.js";
import type { SegmentInput } from "../syntax/types.js";
import type { FintsState } from "../state.js";
import { FintsNotSupportedError, jobAccount, listScheduledTransfers, listStandingOrders, requireJob, type Listed, type Send } from "./jobs.js";

export interface PaymentOptions {
    now?: () => Date;
    /** Waits before asking again for a pending VoP result; replaced in tests. */
    sleep?: (ms: number) => Promise<void>;
}

/** How long MBM asks again for a VoP result the bank has not finished (polling ID). */
const VOP_POLL_BUDGET_MS = 60_000;

const NO_VOP: ConnectorVop = { result: "none", payeeName: null, reason: null, explanation: "", structured: false };

const RESULTS: Record<string, VopResult> = { RCVC: "match", RVMC: "close_match", RVNM: "no_match", RVNA: "not_applicable", PDNG: "pending" };

/** The VoP result of an HIVPP: the single-transaction DEG, else the pain.002. */
function vopOf(h: Hivpp | null, structured: boolean, submittedName: string): ConnectorVop | null {
    if (!h) return null;
    let code = h.single?.code ?? "";
    let other = h.single?.otherName ?? "";
    let reason = h.single?.reason ?? "";
    if (!code && h.report) {
        const p = parsePain002(h.report, submittedName);
        code = p.code ?? "";
        other = p.payeeName ?? "";
        reason = p.info ?? "";
    }
    const result = RESULTS[code] ?? "none";
    return {
        result,
        payeeName: result === "close_match" ? other || null : null,
        reason: result === "not_applicable" ? reason || null : null,
        explanation: h.explanation,
        structured,
    };
}

/** The bank took the payment without any approval: no SCA needed (3076) or a success code for it. */
const accepted = (m: BankMessage, ref: number | undefined): boolean =>
    !m.hasCode("3945") && (m.hasCode("3076") || (ref !== undefined && m.segmentCodes(ref).some((c) => c.code === "0010" || c.code === "0020")));

/**
 * The answer to a VoP poll (HKVPP, perhaps HKTAN) looks like an accepted payment: no SCA needed
 * (3076), or a success code for a segment other than HKVPP. `numbers[0]` is HKVPP.
 */
const acceptedAfterPoll = (m: BankMessage, numbers: number[]): boolean =>
    m.hasCode("3076") || numbers.slice(1).some((n) => m.segmentCodes(n).some((c) => c.code === "0010" || c.code === "0020"));

/**
 * What the bank said about the payment, for the user; codes about the approval are left out, and
 * so is the reference (3070), which is reported on its own.
 */
function resultOf(m: BankMessage, vop: ConnectorVop, instant: boolean): TransferData {
    const codes = m.segmentCodes();
    const about = codes.filter((c) => ["0010", "0020", "3020", "3030", "3045", "3046", "3270"].includes(c.code));
    const own = about.filter((c) => !/freigabe|authentifizierung|tan\b/i.test(c.text));
    const texts = [...new Set((own.length ? own : about).map((c) => c.text.trim()).filter(Boolean))];
    const hiipz = m.find("HIIPZ");
    return {
        bankMessage: texts.join(" ") || "Auftrag angenommen.",
        reference: codes.find((c) => c.code === "3070")?.params[0] || (hiipz ? parseHiipz(hiipz).orderId || null : null),
        vop,
        unconfirmed: instant && (m.hasCode("3045") || m.hasCode("3046")),
        converted: m.hasCode("3270"),
    };
}

/** The account to pay from and its holder's name, as the pain message needs them. */
function debtor(state: FintsState, blz: string, account: ConnectorAccountRef): { a: JobAccount & { iban: string }; name: string } {
    const a = jobAccount(account, blz);
    if (!a.iban) throw new FintsNotSupportedError("Von diesem Konto kann MBM nicht überweisen: Die Bank nennt keine IBAN.");
    const upd = state.upd?.accounts.find((u) => u.iban === a.iban || (u.account?.number === a.accountNumber && (u.account?.subAccount ?? "") === a.subAccount));
    const name = (upd?.owner || state.upd?.userName || "").trim().slice(0, 70);
    if (!name) throw new FintsNotSupportedError("Die Bank nennt keinen Kontoinhaber für dieses Konto.");
    return { a: { ...a, iban: a.iban }, name };
}

type PaymentFields = Pick<PaymentOrder, "payeeName" | "payeeIban" | "payeeBic" | "amount" | "remittance" | "endToEndId">;

/** One pain.001 message for a payment from the account. */
function painFor(descriptor: string, d: ReturnType<typeof debtor>, t: PaymentFields, extra: { instant?: boolean; executionDate?: string }, now: Date): Uint8Array {
    const xml = buildPain001(descriptor, {
        messageId: `M${randomUUID().replace(/-/g, "")}`,
        createdAt: now,
        debtorName: d.name,
        debtorIban: d.a.iban,
        debtorBic: d.a.bic,
        payeeName: t.payeeName,
        payeeIban: t.payeeIban,
        payeeBic: t.payeeBic,
        amount: t.amount,
        remittance: t.remittance,
        endToEndId: t.endToEndId,
        instant: extra.instant ?? false,
        ...(extra.executionDate ? { executionDate: extra.executionDate } : {}),
    });
    return Buffer.from(xml, "utf8");
}

/** The best pain format both sides know for a new order of `jobId`. */
function newOrderFormat(state: FintsState, job: ReturnType<typeof requireJob>): string {
    const descriptor = pickPainFormat(painFormats(state.bpd!, job));
    if (!descriptor) throw new FintsNotSupportedError("Die Bank nennt kein SEPA-Format, das MBM schreiben kann.");
    return descriptor;
}

/** From the first message with the payment on, a lost answer leaves the outcome open. */
async function exchangeOrder(io: JobIo, jobId: string, segments: SegmentInput[]) {
    try {
        return await io.exchange(segments, { scaFor: jobId });
    } catch (e) {
        throw lostAnswer(e);
    }
}

/**
 * Sends a payment job – a transfer or an order that pays – with the verification of payee where
 * the bank asks for it, until the bank's final answer is there (see the flow at the top).
 */
async function sendPayment(io: JobIo, state: FintsState, jobId: string, payment: SegmentInput, payeeName: string, o: PaymentOptions): Promise<{ message: BankMessage; vop: ConnectorVop }> {
    const exchange = (segments: SegmentInput[]) => exchangeOrder(io, jobId, segments);
    const unclear = () => new FintsOutcomeUnknownError();

    const vopParams = vopParameters(state.bpd);
    if (!vopParams || !vopParams.jobs.includes(jobId)) {
        const r = await exchange([payment]);
        if (r.kind === "challenge") return { message: await io.approve(r, { vop: NO_VOP }), vop: NO_VOP };
        if (accepted(r.message, r.numbers[0])) return { message: r.message, vop: NO_VOP };
        throw unclear();
    }

    let r = await exchange([hkvpp(vopParams.formats), payment]);
    const paymentRef = r.numbers[1];
    const hivppOf = (m: BankMessage) => {
        const s = m.find("HIVPP");
        return s ? parseHivpp(s) : null;
    };
    let hivpp = hivppOf(r.message);
    let vop = vopOf(hivpp, vopParams.structured, payeeName) ?? NO_VOP;

    // The result comes later: ask again with the polling ID until the bank sends the VOP-ID
    const sleep = o.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
    const until = Date.now() + VOP_POLL_BUDGET_MS;
    let polled = false;
    while (r.kind === "done" && hivpp && !hivpp.vopId && hivpp.pollingId) {
        if (Date.now() >= until) {
            throw new FintsBankError([{ code: "9999", ref: "", text: "Die Bank hat das Ergebnis der Empfängerüberprüfung nicht rechtzeitig geliefert. Der Auftrag wurde nicht ausgeführt.", params: [] }]);
        }
        await sleep(Math.min(Math.max(hivpp.waitSeconds ?? 2, 1), 10) * 1000);
        const touchdown = r.message.segmentCodes().find((c) => c.code === "3040")?.params[0] ?? null;
        r = await exchange([hkvpp(vopParams.formats, hivpp.pollingId, touchdown)]);
        polled = true;
        const next = hivppOf(r.message);
        if (!next) break;
        hivpp = next;
        vop = vopOf(hivpp, vopParams.structured, payeeName) ?? vop;
    }
    const vopId = hivpp?.vopId ?? VOP_ID_NOT_PROVIDED;

    if (r.kind === "challenge") {
        // The name matches: the approval is already on its way; HKVPA goes along unless 3091 says otherwise
        const followUp = r.message.hasCode("3091") ? [] : [hkvpa(vopId)];
        return { message: await io.approve(r, { vop, followUp }), vop };
    }
    if (polled) {
        // The poll did not carry the payment: whether a sign of acceptance there means the bank
        // executed the payment it holds is open. Sending it again could pay twice.
        if (acceptedAfterPoll(r.message, r.numbers)) throw unclear();
    } else if (accepted(r.message, paymentRef)) {
        return { message: r.message, vop };
    }

    // Differing name (or the bank wants HKVPA anyway): the user decides; a match after polling goes on
    if (vop.result !== "match") await io.confirm(vop);
    const again = await exchange([hkvpa(vopId), payment]);
    if (again.kind === "challenge") return { message: await io.approve(again, { vop }), vop };
    if (accepted(again.message, again.numbers[1])) return { message: again.message, vop };
    throw unclear();
}

export async function submitTransfer(io: JobIo, state: FintsState, blz: string, account: ConnectorAccountRef, t: ConnectorTransfer, o: PaymentOptions = {}): Promise<TransferData> {
    const jobId = t.instant ? "HKIPZ" : "HKCCS";
    const job = requireJob(state.bpd, jobId, t.instant ? IPZ_VERSIONS : CCS_VERSIONS);
    const descriptor = newOrderFormat(state, job);
    const d = debtor(state, blz, account);
    const pain = painFor(descriptor, d, t, { instant: t.instant }, o.now?.() ?? new Date());
    const payment = t.instant ? hkipz(job.version, d.a, descriptor, pain) : hkccs(d.a, descriptor, pain);
    const sent = await sendPayment(io, state, jobId, payment, t.payeeName, o);
    return resultOf(sent.message, sent.vop, t.instant);
}

// ---------- Orders ----------

/** What the bank said about an order, with the order identification it gave in `answerId`. */
function orderResultOf(m: BankMessage, vop: ConnectorVop, answerId: string | null): OrderWriteData {
    const r = resultOf(m, vop, false);
    const answer = answerId ? m.find(answerId) : undefined;
    return { bankMessage: r.bankMessage, reference: r.reference, bankOrderId: answer ? parseOrderId(answer) : null, vop };
}

const today = (o: PaymentOptions) => todayIso(o.now?.() ?? new Date());

/** The bank's rules for writing orders; the job exists, so its rules do too. */
function rulesFor<K extends "scheduled" | "scheduledChange" | "standing" | "standingChange">(state: FintsState, key: K) {
    const rules = orderRules(state.bpd)?.[key];
    if (!rules) throw new FintsNotSupportedError("Die Bank nennt keine Regeln für diesen Auftrag.");
    return rules as NonNullable<ReturnType<typeof orderRules>>[K] & object;
}

const refuse = (problem: string | null) => {
    if (problem) throw new FintsNotSupportedError(problem);
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const samePayment = (a: ConnectorScheduledTransfer | ConnectorStandingOrder, e: ExpectedScheduledTransfer | ExpectedStandingOrder) =>
    a.payeeIban === e.payeeIban && a.amount === e.amount && norm(a.payeeName) === norm(e.payeeName) && norm(a.remittance) === norm(e.remittance);

/**
 * The order as the bank holds it now, fetched in the same dialog right before a change or
 * deletion (Messages C.10.2.2.2, C.10.2.3.2). If it is gone or no longer what the user saw,
 * nothing is sent.
 */
function current<T extends { bankOrderId: string | null }>(listed: Listed<T>[], id: string, same: (o: T) => boolean): Listed<T> {
    const hit = listed.find((l) => l.order.bankOrderId === id);
    if (!hit || !same(hit.order)) throw new FintsOrderChangedError();
    return hit;
}

/** A change must use the pain format the bank listed the order in (C.10.2.2.2). */
function listedFormat(l: Listed<unknown>): string {
    if (!pickPainFormat([l.descriptor])) throw new FintsNotSupportedError("Die Bank führt diesen Auftrag in einem SEPA-Format, das MBM nicht schreiben kann.");
    return l.descriptor;
}

/** A deletion: no verification of payee, only the approval. */
async function sendDeletion(io: JobIo, jobId: string, segment: SegmentInput): Promise<OrderWriteData> {
    const r = await exchangeOrder(io, jobId, [segment]);
    const message = r.kind === "challenge" ? await io.approve(r, { vop: NO_VOP }) : accepted(r.message, r.numbers[0]) ? r.message : null;
    if (!message) throw new FintsOutcomeUnknownError();
    return orderResultOf(message, NO_VOP, null);
}

export interface OrderContext {
    send: Send;
    io: JobIo;
    state: FintsState;
    blz: string;
    account: ConnectorAccountRef;
    o: PaymentOptions;
}

/** HKCSE: a transfer to be executed on a date. */
export async function createScheduledTransfer(c: OrderContext, order: ScheduledTransferWrite): Promise<OrderWriteData> {
    const job = requireJob(c.state.bpd, "HKCSE", CSE_VERSIONS);
    refuse(scheduledDateProblem(rulesFor(c.state, "scheduled"), order.executionDate, today(c.o)));
    const descriptor = newOrderFormat(c.state, job);
    const d = debtor(c.state, c.blz, c.account);
    const pain = painFor(descriptor, d, order, { executionDate: order.executionDate }, c.o.now?.() ?? new Date());
    const sent = await sendPayment(c.io, c.state, "HKCSE", hkcse(d.a, descriptor, pain), order.payeeName, c.o);
    return orderResultOf(sent.message, sent.vop, "HICSE");
}

/** HKCSA: the complete new transfer under the bank's order identification. */
export async function changeScheduledTransfer(c: OrderContext, expected: ExpectedScheduledTransfer, order: ScheduledTransferWrite): Promise<OrderWriteData> {
    requireJob(c.state.bpd, "HKCSA", CSA_VERSIONS);
    refuse(scheduledDateProblem(rulesFor(c.state, "scheduledChange"), order.executionDate, today(c.o)));
    const d = debtor(c.state, c.blz, c.account);
    const now = current(await listScheduledTransfers(c.send, c.state, c.blz, c.account), expected.bankOrderId, (x) => samePayment(x, expected) && x.executionDate === expected.executionDate);
    const descriptor = listedFormat(now);
    const pain = painFor(descriptor, d, order, { executionDate: order.executionDate }, c.o.now?.() ?? new Date());
    const sent = await sendPayment(c.io, c.state, "HKCSA", hkcsa(d.a, descriptor, pain, expected.bankOrderId), order.payeeName, c.o);
    return orderResultOf(sent.message, sent.vop, "HICSA");
}

/** HKCSL, with the order's data as the bank listed it if it wants them. */
export async function deleteScheduledTransfer(c: OrderContext, expected: ExpectedScheduledTransfer): Promise<OrderWriteData> {
    requireJob(c.state.bpd, "HKCSL", CSL_VERSIONS);
    const a = jobAccount(c.account, c.blz);
    const now = current(await listScheduledTransfers(c.send, c.state, c.blz, c.account), expected.bankOrderId, (x) => samePayment(x, expected) && x.executionDate === expected.executionDate);
    const data = deleteNeedsData(c.state.bpd, "HKCSL") ? { descriptor: now.descriptor, pain: now.pain } : null;
    return sendDeletion(c.io, "HKCSL", hkcsl(a, data, expected.bankOrderId));
}

const sameRhythm = (a: ConnectorStandingOrder, e: ExpectedStandingOrder) =>
    a.firstDate === e.firstDate && a.unit === e.unit && a.every === e.every && a.executionDay === e.executionDay && a.lastDate === e.lastDate;

/** Fill value of the execution date in the pain message of a standing order, as for transfers. */
const STANDING_PAIN_DATE = "1999-01-01";

/** HKCDE: a new standing order. */
export async function createStandingOrder(c: OrderContext, order: StandingOrderWrite): Promise<OrderWriteData> {
    const job = requireJob(c.state.bpd, "HKCDE", CDE_VERSIONS);
    refuse(standingOrderProblem(rulesFor(c.state, "standing"), order.recurrence, today(c.o)));
    const descriptor = newOrderFormat(c.state, job);
    const d = debtor(c.state, c.blz, c.account);
    const pain = painFor(descriptor, d, order, { executionDate: STANDING_PAIN_DATE }, c.o.now?.() ?? new Date());
    const sent = await sendPayment(c.io, c.state, "HKCDE", hkcde(d.a, descriptor, pain, order.recurrence), order.payeeName, c.o);
    return orderResultOf(sent.message, sent.vop, "HICDE");
}

/** HKCDN: the complete changed standing order, effective from its next run. */
export async function changeStandingOrder(c: OrderContext, expected: ExpectedStandingOrder, order: StandingOrderWrite): Promise<OrderWriteData> {
    requireJob(c.state.bpd, "HKCDN", CDN_VERSIONS);
    const rules = rulesFor(c.state, "standingChange");
    const d = debtor(c.state, c.blz, c.account);
    const now = current(await listStandingOrders(c.send, c.state, c.blz, c.account), expected.bankOrderId, (x) => samePayment(x, expected) && sameRhythm(x, expected));
    refuse(standingChangeProblem(rules, now.order, { ...order, ...order.recurrence }, today(c.o)));
    const descriptor = listedFormat(now);
    const pain = painFor(descriptor, d, order, { executionDate: STANDING_PAIN_DATE }, c.o.now?.() ?? new Date());
    const firstAsListed = order.recurrence.firstDate === now.order.firstDate ? text(now.details ?? undefined, 0) || undefined : undefined;
    const segment = hkcdn(d.a, descriptor, pain, expected.bankOrderId, order.recurrence, firstAsListed);
    const sent = await sendPayment(c.io, c.state, "HKCDN", segment, order.payeeName, c.o);
    return orderResultOf(sent.message, sent.vop, "HICDN");
}

/** HKCDL: deleted at once, with the order's data and rhythm as the bank listed them. */
export async function deleteStandingOrder(c: OrderContext, expected: ExpectedStandingOrder): Promise<OrderWriteData> {
    requireJob(c.state.bpd, "HKCDL", CDL_VERSIONS);
    const a = jobAccount(c.account, c.blz);
    const now = current(await listStandingOrders(c.send, c.state, c.blz, c.account), expected.bankOrderId, (x) => samePayment(x, expected) && sameRhythm(x, expected));
    const data = deleteNeedsData(c.state.bpd, "HKCDL") ? { descriptor: now.descriptor, pain: now.pain } : null;
    return sendDeletion(c.io, "HKCDL", hkcdl(a, data, expected.bankOrderId, now.details ?? []));
}
