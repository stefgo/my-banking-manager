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
import type { ConnectorAccountRef, ConnectorTransfer, ConnectorVop, TransferData, VopResult } from "@mbm/shared";
import type { BankMessage } from "../message/read.js";
import { FintsBankError, FintsOutcomeUnknownError, lostAnswer } from "../dialog/errors.js";
import type { JobIo } from "../operations/runner.js";
import { buildPain001, pickPainFormat } from "../formats/pain001.js";
import { parsePain002 } from "../formats/pain002.js";
import { painFormats } from "../segments/orders.js";
import { CCS_VERSIONS, IPZ_VERSIONS, VOP_ID_NOT_PROVIDED, hkccs, hkipz, hkvpa, hkvpp, parseHiipz, parseHivpp, vopParameters, type Hivpp } from "../segments/payments.js";
import type { SegmentInput } from "../syntax/types.js";
import type { FintsState } from "../state.js";
import { FintsNotSupportedError, jobAccount, requireJob } from "./jobs.js";

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
    const about = codes.filter((c) => ["0010", "0020", "3020", "3045", "3046", "3270"].includes(c.code));
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

export async function submitTransfer(io: JobIo, state: FintsState, blz: string, account: ConnectorAccountRef, t: ConnectorTransfer, o: PaymentOptions = {}): Promise<TransferData> {
    const jobId = t.instant ? "HKIPZ" : "HKCCS";
    const job = requireJob(state.bpd, jobId, t.instant ? IPZ_VERSIONS : CCS_VERSIONS);
    const descriptor = pickPainFormat(painFormats(state.bpd!, job));
    if (!descriptor) throw new FintsNotSupportedError("Die Bank nennt kein SEPA-Format, das MBM schreiben kann.");
    const a = jobAccount(account, blz);
    if (!a.iban) throw new FintsNotSupportedError("Von diesem Konto kann MBM nicht überweisen: Die Bank nennt keine IBAN.");
    const upd = state.upd?.accounts.find((u) => u.iban === a.iban || (u.account?.number === a.accountNumber && (u.account?.subAccount ?? "") === a.subAccount));
    const debtorName = (upd?.owner || state.upd?.userName || "").trim().slice(0, 70);
    if (!debtorName) throw new FintsNotSupportedError("Die Bank nennt keinen Kontoinhaber für dieses Konto.");

    const now = o.now?.() ?? new Date();
    const pain = buildPain001(descriptor, {
        messageId: `M${randomUUID().replace(/-/g, "")}`,
        createdAt: now,
        debtorName,
        debtorIban: a.iban,
        debtorBic: a.bic,
        payeeName: t.payeeName,
        payeeIban: t.payeeIban,
        payeeBic: t.payeeBic,
        amount: t.amount,
        remittance: t.remittance,
        endToEndId: t.endToEndId,
        instant: t.instant,
    });
    const payment = t.instant ? hkipz(job.version, a, descriptor, Buffer.from(pain, "utf8")) : hkccs(a, descriptor, Buffer.from(pain, "utf8"));

    // From the first message with the payment on, a lost answer leaves the outcome open.
    const exchange = async (segments: SegmentInput[]) => {
        try {
            return await io.exchange(segments, { scaFor: jobId });
        } catch (e) {
            throw lostAnswer(e);
        }
    };
    const unclear = () => new FintsOutcomeUnknownError();

    const vopParams = vopParameters(state.bpd);
    if (!vopParams || !vopParams.jobs.includes(jobId)) {
        const r = await exchange([payment]);
        if (r.kind === "challenge") return resultOf(await io.approve(r, { vop: NO_VOP }), NO_VOP, t.instant);
        if (accepted(r.message, r.numbers[0])) return resultOf(r.message, NO_VOP, t.instant);
        throw unclear();
    }

    let r = await exchange([hkvpp(vopParams.formats), payment]);
    const paymentRef = r.numbers[1];
    const hivppOf = (m: BankMessage) => {
        const s = m.find("HIVPP");
        return s ? parseHivpp(s) : null;
    };
    let hivpp = hivppOf(r.message);
    let vop = vopOf(hivpp, vopParams.structured, t.payeeName) ?? NO_VOP;

    // The result comes later: ask again with the polling ID until the bank sends the VOP-ID
    const sleep = o.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
    const until = Date.now() + VOP_POLL_BUDGET_MS;
    let polled = false;
    while (r.kind === "done" && hivpp && !hivpp.vopId && hivpp.pollingId) {
        if (Date.now() >= until) {
            throw new FintsBankError([{ code: "9999", ref: "", text: "Die Bank hat das Ergebnis der Empfängerüberprüfung nicht rechtzeitig geliefert. Die Überweisung wurde nicht ausgeführt.", params: [] }]);
        }
        await sleep(Math.min(Math.max(hivpp.waitSeconds ?? 2, 1), 10) * 1000);
        const touchdown = r.message.segmentCodes().find((c) => c.code === "3040")?.params[0] ?? null;
        r = await exchange([hkvpp(vopParams.formats, hivpp.pollingId, touchdown)]);
        polled = true;
        const next = hivppOf(r.message);
        if (!next) break;
        hivpp = next;
        vop = vopOf(hivpp, vopParams.structured, t.payeeName) ?? vop;
    }
    const vopId = hivpp?.vopId ?? VOP_ID_NOT_PROVIDED;

    if (r.kind === "challenge") {
        // The name matches: the approval is already on its way; HKVPA goes along unless 3091 says otherwise
        const followUp = r.message.hasCode("3091") ? [] : [hkvpa(vopId)];
        return resultOf(await io.approve(r, { vop, followUp }), vop, t.instant);
    }
    if (polled) {
        // The poll did not carry the payment: whether a sign of acceptance there means the bank
        // executed the payment it holds is open. Sending it again could pay twice.
        if (acceptedAfterPoll(r.message, r.numbers)) throw unclear();
    } else if (accepted(r.message, paymentRef)) {
        return resultOf(r.message, vop, t.instant);
    }

    // Differing name (or the bank wants HKVPA anyway): the user decides; a match after polling goes on
    if (vop.result !== "match") await io.confirm(vop);
    const again = await exchange([hkvpa(vopId), payment]);
    if (again.kind === "challenge") return resultOf(await io.approve(again, { vop }), vop, t.instant);
    if (accepted(again.message, again.numbers[1])) return resultOf(again.message, vop, t.instant);
    throw unclear();
}
