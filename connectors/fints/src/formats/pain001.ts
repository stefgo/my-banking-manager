// pain.001 (Customer Credit Transfer Initiation) as banks return it for orders they hold:
// standing orders (HICDB) and scheduled transfers (HICSB). Read only; names are matched without
// namespace, so the schema versions (.001.03, .003.03, .001.09) differ only where noted.

import { XMLParser } from "fast-xml-parser";
import { cleanRef } from "./transaction.js";
import { arr, at, decimalCents, str } from "./xml.js";

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ["PmtInf", "CdtTrfTxInf", "Ustrd"].includes(name),
    processEntities: true,
    htmlEntities: false,
});

export interface Payment {
    payeeName: string;
    payeeIban: string;
    payeeBic: string | null;
    /** Not negative. */
    amount: number;
    currency: string;
    remittance: string;
    endToEndId: string | null;
    /** Requested execution date; for standing orders banks put a fill value here. */
    executionDate: string | null;
}

/** The credit transfers of one pain.001 document; one that has no readable amount is left out. */
export function parsePain001(xml: string | Uint8Array): Payment[] {
    const text = typeof xml === "string" ? xml : Buffer.from(xml).toString("utf8");
    const doc = parser.parse(text) as Record<string, unknown>;
    return arr(at(doc, "Document", "CstmrCdtTrfInitn", "PmtInf")).flatMap((info) => {
        // .03: <ReqdExctnDt>2026-12-01</ReqdExctnDt>; from .09: <ReqdExctnDt><Dt>…</Dt></ReqdExctnDt>
        const date = str(at(info, "ReqdExctnDt", "Dt")) || str(at(info, "ReqdExctnDt", "DtTm")).slice(0, 10) || str(at(info, "ReqdExctnDt"));
        return arr(at(info, "CdtTrfTxInf")).flatMap((tx): Payment[] => {
            const amt = at(tx, "Amt", "InstdAmt");
            const cents = decimalCents(str(amt));
            if (cents === null) return [];
            const agent = at(tx, "CdtrAgt", "FinInstnId");
            const lines = arr(at(tx, "RmtInf", "Ustrd")).map(str);
            return [
                {
                    payeeName: str(at(tx, "Cdtr", "Nm")),
                    payeeIban: str(at(tx, "CdtrAcct", "Id", "IBAN")).replace(/\s/g, ""),
                    payeeBic: str(at(agent, "BICFI")) || str(at(agent, "BIC")) || null,
                    amount: cents,
                    currency: str(at(amt, "@Ccy")) || "EUR",
                    remittance: lines.join(" ").replace(/\s+/g, " ").trim() || str(at(tx, "RmtInf", "Strd", "CdtrRefInf", "Ref")),
                    endToEndId: cleanRef(str(at(tx, "PmtId", "EndToEndId"))),
                    executionDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
                },
            ];
        });
    });
}

// ---------- Writing ----------

/** The pain.001 versions MBM can write, best first (DK: .001.09 since November 2023). */
const WRITABLE = ["pain.001.001.09", "pain.001.001.03", "pain.001.003.03"];

/** The bank's descriptor of the best version both sides support; null if there is none. */
export function pickPainFormat(descriptors: string[]): string | null {
    for (const v of WRITABLE) {
        const hit = descriptors.find((d) => d.includes(v));
        if (hit) return hit;
    }
    return null;
}

export interface PaymentOrder {
    /** Message and payment information ID; up to 35 characters. */
    messageId: string;
    createdAt: Date;
    debtorName: string;
    debtorIban: string;
    debtorBic: string | null;
    payeeName: string;
    payeeIban: string;
    payeeBic: string | null;
    /** Cents, more than 0. */
    amount: number;
    remittance: string;
    endToEndId: string;
    /** Instant credit transfer: local instrument INST. */
    instant: boolean;
    /** "1999-01-01" for transfers that are not scheduled (Messages C.10.2.1). */
    executionDate?: string;
}

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const decimal = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** Local time without zone, as the DFÜ-Abkommen shows it: 2026-11-17T10:15:00. */
const isoLocal = (d: Date): string => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * One SEPA credit transfer as pain.001 in the version `descriptor` names. In FinTS a message
 * carries exactly one payment information block with one transaction (Messages C.10.2).
 */
export function buildPain001(descriptor: string, o: PaymentOrder): string {
    const version = WRITABLE.find((v) => descriptor.includes(v));
    if (!version) throw new Error(`Cannot write ${descriptor}`);
    const v09 = version === "pain.001.001.09";
    const ns = `urn:iso:std:iso:20022:tech:xsd:${version}`;
    const x = escapeXml;
    const bic = (b: string | null) => (b ? (v09 ? `<BICFI>${x(b)}</BICFI>` : `<BIC>${x(b)}</BIC>`) : "<Othr><Id>NOTPROVIDED</Id></Othr>");
    const date = o.executionDate ?? "1999-01-01";
    const amount = decimal(o.amount);
    const typeInfo = `<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl>${o.instant ? "<LclInstrm><Cd>INST</Cd></LclInstrm>" : ""}</PmtTpInf>`;
    return (
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Document xmlns="${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<CstmrCdtTrfInitn>` +
        `<GrpHdr><MsgId>${x(o.messageId)}</MsgId><CreDtTm>${isoLocal(o.createdAt)}</CreDtTm><NbOfTxs>1</NbOfTxs><CtrlSum>${amount}</CtrlSum><InitgPty><Nm>${x(o.debtorName)}</Nm></InitgPty></GrpHdr>` +
        `<PmtInf><PmtInfId>${x(o.messageId)}</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>1</NbOfTxs><CtrlSum>${amount}</CtrlSum>${typeInfo}` +
        `<ReqdExctnDt>${v09 ? `<Dt>${date}</Dt>` : date}</ReqdExctnDt>` +
        `<Dbtr><Nm>${x(o.debtorName)}</Nm></Dbtr><DbtrAcct><Id><IBAN>${x(o.debtorIban)}</IBAN></Id></DbtrAcct>` +
        `<DbtrAgt><FinInstnId>${bic(o.debtorBic)}</FinInstnId></DbtrAgt><ChrgBr>SLEV</ChrgBr>` +
        `<CdtTrfTxInf><PmtId><EndToEndId>${x(o.endToEndId)}</EndToEndId></PmtId><Amt><InstdAmt Ccy="EUR">${amount}</InstdAmt></Amt>` +
        (o.payeeBic ? `<CdtrAgt><FinInstnId>${bic(o.payeeBic)}</FinInstnId></CdtrAgt>` : "") +
        `<Cdtr><Nm>${x(o.payeeName)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${x(o.payeeIban)}</IBAN></Id></CdtrAcct>` +
        (o.remittance ? `<RmtInf><Ustrd>${x(o.remittance)}</Ustrd></RmtInf>` : "") +
        `</CdtTrfTxInf></PmtInf></CstmrCdtTrfInitn></Document>`
    );
}
