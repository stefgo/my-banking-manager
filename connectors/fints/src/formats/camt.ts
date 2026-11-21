// camt.052 (Bank to Customer Account Report) as delivered in HICAZ, versions .001.02 to .001.08.
// Only the elements needed for a transaction list are read; names are matched without
// namespace, so the schema versions differ only where noted.

import { XMLParser } from "fast-xml-parser";
import { arr, at, obj, str } from "./xml.js";
import { cleanRef, emptyTransaction, partiesOf, splitSepaPurpose, type Transaction } from "./transaction.js";

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    // Entries and lines repeat; always read them as lists.
    isArray: (name) => ["Rpt", "Stmt", "Ntry", "NtryDtls", "TxDtls", "Ustrd"].includes(name),
    processEntities: true,
    htmlEntities: false,
});

/** Parses one camt.052 document; `status` applies when an entry does not say. */
export function parseCamt(xml: string | Uint8Array, status: "booked" | "pending"): Transaction[] {
    const text = typeof xml === "string" ? xml : Buffer.from(xml).toString("utf8");
    const doc = parser.parse(text) as Record<string, unknown>;
    const root = obj(at(doc, "Document", "BkToCstmrAcctRpt")) ?? obj(at(doc, "Document", "BkToCstmrStmt"));
    if (!root) return [];
    const reports = [...arr(root.Rpt), ...arr(root.Stmt)];
    return reports.flatMap((r) => arr(obj(r)?.Ntry).map((n) => entry(n, status)).filter((t): t is Transaction => t !== null));
}

function entry(n: unknown, fallback: "booked" | "pending"): Transaction | null {
    const amt = at(n, "Amt");
    const value = str(amt);
    if (!/^\d+(\.\d+)?$/.test(value)) return null;
    const [whole, frac = ""] = value.split(".");
    if (frac.replace(/0+$/, "").length > 2) return null;
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
    const credit = str(at(n, "CdtDbtInd")) === "CRDT";
    // .02: <Sts>BOOK</Sts>; from .08: <Sts><Cd>BOOK</Cd></Sts>
    const sts = str(at(n, "Sts", "Cd")) || str(at(n, "Sts"));
    const status = sts === "PDNG" ? "pending" : sts === "BOOK" ? "booked" : fallback;

    const t: Transaction = {
        ...emptyTransaction(),
        bookingDate: isoDate(at(n, "BookgDt")) ?? isoDate(at(n, "ValDt")) ?? "",
        valueDate: isoDate(at(n, "ValDt")),
        amount: credit ? cents : -cents,
        currency: str(obj(amt)?.["@Ccy"]) || "EUR",
        status,
        bookingText: str(at(n, "AddtlNtryInf")),
        bankReference: cleanRef(str(at(n, "AcctSvcrRef"))),
    };
    if (!t.bookingDate) return null;

    const tx = arr(obj(arr(obj(n)?.NtryDtls)[0])?.TxDtls)[0];
    if (tx) {
        t.endToEndId = cleanRef(str(at(tx, "Refs", "EndToEndId")));
        t.mandateId = cleanRef(str(at(tx, "Refs", "MndtId")));
        // The counterparty is the creditor of a debit and the debtor of a credit.
        const party = credit ? "Dbtr" : "Cdtr";
        const ultimate = credit ? "UltmtDbtr" : "UltmtCdtr";
        const parties = at(tx, "RltdPties");
        // .02: Dbtr/Nm; from .08: Dbtr/Pty/Nm
        const name = str(at(parties, party, "Nm")) || str(at(parties, party, "Pty", "Nm"));
        const ultimateName = str(at(parties, ultimate, "Nm")) || str(at(parties, ultimate, "Pty", "Nm"));
        t.counterpartyIban = str(at(parties, `${party}Acct`, "Id", "IBAN")) || null;
        const agent = credit ? "DbtrAgt" : "CdtrAgt";
        t.counterpartyBic = str(at(tx, "RltdAgts", agent, "FinInstnId", "BICFI")) || str(at(tx, "RltdAgts", agent, "FinInstnId", "BIC")) || null;
        t.creditorId = cleanRef(str(at(parties, "Cdtr", "Id", "PrvtId", "Othr", "Id")) || str(at(parties, "Cdtr", "Pty", "Id", "PrvtId", "Othr", "Id")));
        const lines = arr(at(tx, "RmtInf", "Ustrd")).map(str);
        const joined = lines.join("");
        const sepa = splitSepaPurpose(joined);
        t.remittance = sepa.endToEndId || sepa.mandateId || sepa.creditorId ? sepa.remittance : lines.join(" ").replace(/\s+/g, " ").trim();
        t.endToEndId ??= sepa.endToEndId;
        t.mandateId ??= sepa.mandateId;
        t.creditorId ??= sepa.creditorId;
        Object.assign(t, partiesOf(name, ultimateName || sepa.ultimate));
        const info = str(at(tx, "AddtlTxInf"));
        if (info && !t.bookingText) t.bookingText = info;
    }
    return t;
}

function isoDate(v: unknown): string | null {
    const d = str(at(v, "Dt")) || str(at(v, "DtTm")).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
