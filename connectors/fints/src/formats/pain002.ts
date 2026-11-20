// pain.002 (Customer Payment Status Report) as banks send it with the result of the verification
// of payee (Messages – VoP, HIVPP "Payment Status Report"). Only what a single transfer needs:
// its status and, on a close match, the name the payee's bank holds.

import { XMLParser } from "fast-xml-parser";
import { arr, at, str } from "./xml.js";

const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ["OrgnlPmtInfAndSts", "TxInfAndSts", "StsRsnInf", "AddtlInf"].includes(name),
    processEntities: true,
    htmlEntities: false,
});

/** VoP codes of the DK (Data Dictionary „VOP-Prüfergebnis“). */
export type VopCode = "RCVC" | "RVMC" | "RVNM" | "RVNA" | "PDNG";
const CODES: VopCode[] = ["RCVC", "RVMC", "RVNM", "RVNA", "PDNG"];

export interface Pain002Result {
    code: VopCode | null;
    /** On a close match: the name the payee's bank holds; null if not given. */
    payeeName: string | null;
    /** Additional information of the bank (e.g. why the check was not applicable). */
    info: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The status of the one transfer in a pain.002. With stepwise delivery a matching transaction
 * may be missing from the details; then the status of the payment or group applies.
 * `submittedName` tells the name the bank holds from the one we sent.
 */
export function parsePain002(xml: string | Uint8Array, submittedName: string): Pain002Result {
    const text = typeof xml === "string" ? xml : Buffer.from(xml).toString("utf8");
    const doc = parser.parse(text) as Record<string, unknown>;
    const report = at(doc, "Document", "CstmrPmtStsRpt");
    const payments = arr(at(report, "OrgnlPmtInfAndSts"));
    const tx = payments.flatMap((p) => arr(at(p, "TxInfAndSts")))[0];
    const asCode = (v: string): VopCode | null => (CODES.includes(v as VopCode) ? (v as VopCode) : null);
    const code = asCode(str(at(tx, "TxSts"))) ?? asCode(str(at(payments[0], "PmtInfSts"))) ?? asCode(str(at(report, "OrgnlGrpInfAndSts", "GrpSts")));
    const reasons = arr(at(tx, "StsRsnInf"));
    const info = reasons
        .flatMap((r) => arr(at(r, "AddtlInf")).map(str))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    // The creditor in the original transaction reference: the name the payee's bank holds where
    // it differs from ours; some banks put it only into the additional information.
    const ref = at(tx, "OrgnlTxRef");
    const names = [str(at(ref, "Cdtr", "Pty", "Nm")), str(at(ref, "Cdtr", "Nm"))].filter(Boolean);
    let payeeName: string | null = null;
    if (code === "RVMC") payeeName = names.find((n) => norm(n) !== norm(submittedName)) ?? (info || null);
    return { code, payeeName, info: info || null };
}
