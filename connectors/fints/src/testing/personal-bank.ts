// A scripted bank for personal dialogs (PIN check, synchronisation, strong authentication,
// TAN media, fetch jobs). Data is made up; nothing comes from a real bank.

import type { BankMessage } from "../message/read.js";
import { text } from "../syntax/formats.js";
import { ok, simBpd, startBankSim, SIM_BLZ, type BankSegment, type BankSim, type SimContext } from "./bank-sim.js";

export const SIM_USER = "testuser";
export const SIM_PIN = "12345";
export const SIM_TAN = "123456";
export const SIM_SYSTEM_ID = "SYS4711";
export const SIM_GIRO_IBAN = "DE02123456780001234567";
export const SIM_CARD = "4111000000001234";

/** One method in "Verfahrensparameter Zwei-Schritt-Verfahren" v7 (26 components). */
function method(f: string, name: string, dk: string, decoupled: boolean, mediumRequired: number): string[] {
    return [
        f, "2", `TECH${f}`, dk, "", name,
        decoupled ? "" : "6", decoupled ? "" : "1", "TAN", "2048",
        "N", "1", "N", "0", "0", "N", "N", "00", String(mediumRequired), "N", "1",
        decoupled ? "60" : "", decoupled ? "1" : "", decoupled ? "1" : "", decoupled ? "J" : "", decoupled ? "J" : "",
    ];
}

/** HITANS v7: 946 decoupled (app approval), 942 with TAN entry. */
export const simHitans = (ref?: number): BankSegment => ({
    id: "HITANS",
    version: 7,
    ref,
    elements: [1, 1, 0, ["N", "N", "0", ...method("946", "SecureGo plus", "Decoupled", true, 2), ...method("942", "mobile TAN", "mobileTAN", false, 0)]],
});

const CAMT_V8 = "urn:iso:std:iso:20022:tech:xsd:camt.052.001.08";

function camtDoc(entries: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${CAMT_V8}"><BkToCstmrAcctRpt><Rpt><Id>1</Id>${entries}</Rpt></BkToCstmrAcctRpt></Document>`;
}

export const CAMT_PAGE_1 = camtDoc(`
<Ntry><Amt Ccy="EUR">1250.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-11-02</Dt></BookgDt><ValDt><Dt>2026-11-02</Dt></ValDt><AcctSvcrRef>REF-A</AcctSvcrRef><AddtlNtryInf>Gehalt</AddtlNtryInf>
<NtryDtls><TxDtls><Refs><EndToEndId>LOHN-2026-11</EndToEndId></Refs><RltdPties><Dbtr><Pty><Nm>Muster GmbH</Nm></Pty></Dbtr><DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct></RltdPties><RmtInf><Ustrd>Gehalt November</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`);

export const CAMT_PAGE_2 = camtDoc(`
<Ntry><Amt Ccy="EUR">42.99</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-11-05</Dt></BookgDt><ValDt><Dt>2026-11-05</Dt></ValDt><AddtlNtryInf>Lastschrift</AddtlNtryInf>
<NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId><MndtId>M-77</MndtId></Refs><RltdPties><Cdtr><Pty><Nm>Stadtwerke Musterstadt</Nm><Id><PrvtId><Othr><Id>DE98ZZZ09999999999</Id></Othr></PrvtId></Id></Pty></Cdtr><CdtrAcct><Id><IBAN>DE44500105175407324931</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>Abschlag Strom</Ustrd><Ustrd> November</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`);

export const CAMT_PENDING = camtDoc(`
<Ntry><Amt Ccy="EUR">9.90</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>PDNG</Cd></Sts><BookgDt><Dt>2026-11-15</Dt></BookgDt><NtryDtls><TxDtls><RltdPties><Cdtr><Pty><Nm>Kiosk</Nm></Pty></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>`);

export const MT940 = [
    ":20:STARTUMSE",
    ":25:12345678/0001234567",
    ":28C:00000/001",
    ":60F:C261101EUR1000,00",
    ":61:2611021102CR1250,00NTRFNONREF//REF-A",
    ":86:166?00GUTSCHRIFT?100599?20EREF+LOHN-2026-11?21SVWZ+Gehalt November?30COBADEFFXXX?31DE89370400440532013000?32Muster GmbH",
    ":61:2611051105DR42,99NDDTNONREF",
    ":86:105?00LASTSCHRIFT?20EREF+NOTPROVIDED?21MREF+M-77?22CRED+DE98ZZZ09999999999?23SVWZ+Abschlag Strom Novemb?24er?32Stadtwerke Musterstadt",
    ":62F:C261105EUR2207,01",
    "-",
].join("\r\n");

/** A pain.001 document with one credit transfer, version .001.09 or .001.03. */
export function painDoc(o: { name: string; iban: string; amount: string; remittance: string; date: string; v3?: boolean }): string {
    const ns = `urn:iso:std:iso:20022:tech:xsd:pain.001.001.${o.v3 ? "03" : "09"}`;
    const date = o.v3 ? o.date : `<Dt>${o.date}</Dt>`;
    const agent = o.v3 ? "<BIC>SIMUDEM2XXX</BIC>" : "<BICFI>SIMUDEM2XXX</BICFI>";
    return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${ns}"><CstmrCdtTrfInitn><GrpHdr><MsgId>M1</MsgId><NbOfTxs>1</NbOfTxs></GrpHdr><PmtInf><PmtInfId>P1</PmtInfId><PmtMtd>TRF</PmtMtd><ReqdExctnDt>${date}</ReqdExctnDt><Dbtr><Nm>Erika Mustermann</Nm></Dbtr><DbtrAcct><Id><IBAN>${SIM_GIRO_IBAN}</IBAN></Id></DbtrAcct><CdtTrfTxInf><PmtId><EndToEndId>NOTPROVIDED</EndToEndId></PmtId><Amt><InstdAmt Ccy="EUR">${o.amount}</InstdAmt></Amt><CdtrAgt><FinInstnId>${agent}</FinInstnId></CdtrAgt><Cdtr><Nm>${o.name}</Nm></Cdtr><CdtrAcct><Id><IBAN>${o.iban}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>${o.remittance}</Ustrd></RmtInf></CdtTrfTxInf></PmtInf></CstmrCdtTrfInitn></Document>`;
}

const PAIN_V9 = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09";
/** Fill value banks put into the execution date of a standing order. */
const PAIN_NO_DATE = "1999-01-01";

export const PAIN_RENT = painDoc({ name: "Hausverwaltung Muster", iban: "DE89370400440532013000", amount: "850.00", remittance: "Miete Musterweg 1", date: PAIN_NO_DATE });
export const PAIN_SAVINGS = painDoc({ name: "Erika Mustermann", iban: "DE44500105175407324931", amount: "100.5", remittance: "Sparen", date: PAIN_NO_DATE, v3: true });
export const PAIN_CLUB = painDoc({ name: "Sportverein Musterstadt", iban: "DE12500105170648489890", amount: "12", remittance: "Beitrag", date: PAIN_NO_DATE });
export const PAIN_SCHEDULED = painDoc({ name: "Handwerker Beispiel", iban: "DE75512108001245126199", amount: "431.20", remittance: "Rechnung 4711", date: "2026-12-03" });

export interface PersonalBankOptions {
    /** How the bank asks for strong authentication at dialog start. */
    sca?: "decoupled" | "tan" | "none";
    /** How it asks for jobs that need a TAN according to HIPINS. */
    jobSca?: "decoupled" | "tan" | "none";
    /** Status queries answered with 3956 before the approval counts as given. */
    pendingPolls?: number;
    /** Return codes sent instead of the HKTAB answer, e.g. 9075. */
    jobError?: [string, string];
    /** The bank refuses HKSYN in the 999 dialog. */
    refuseSyncWith999?: boolean;
    /** The bank offers no HKCAZ (MT940 only). */
    noCamt?: boolean;
    /** The bank offers neither standing orders nor scheduled transfers. */
    noOrders?: boolean;
    /** Listing orders needs a TAN according to HIPINS. */
    ordersTan?: boolean;
    /** A decoupled approval is announced with 3955 alone, without 0030 (seen at Sparkassen). */
    without0030?: boolean;
    /** The bank offers transfers (HKCCS, HKIPZ) and answers them by this script. */
    payments?: PaymentScript;
}

/**
 * How the bank answers a payment. `vop`: the verification of payee – match (with 3091), match
 * that wants HKVPA with the approval, close/no match/not applicable (3090 + 3945), a close match as
 * pain.002, a result that needs polling (also one whose last answer says 3076 to the HKTAN of the
 * poll), a small amount without any approval, or no VoP at all.
 */
export interface PaymentScript {
    vop?: "match" | "match_vpa" | "close" | "no_match" | "not_applicable" | "pain002_close" | "polling" | "polling_3076" | "bagatelle" | "off";
    /** The bank refuses the payment with this code once it would execute it. */
    reject?: [string, string];
    /** The connection drops on the answer that executes the payment (the payment is executed). */
    dropOnExecute?: boolean;
    /** Instant: the bank cannot confirm the arrival yet (3045). */
    unconfirmed?: boolean;
}

export const SIM_VOP_ID = "VOP-4711";
export const SIM_PAYEE_IBAN = "DE89370400440532013000";
export const SIM_BANK_PAYEE_NAME = "Erika Musterfrau";
const PAIN002_V10 = "urn:iso:std:iso:20022:tech:xsd:pain.002.001.10";

export interface PersonalBank extends BankSim {
    /** HNSHA "Benutzerdefinierte Signatur" of every received message: [pin, tan?]. */
    signatures: string[][];
    /** Payments the bank executed (counted even when the answer is lost). */
    executed: number;
}

export async function startPersonalBank(o: PersonalBankOptions = {}): Promise<PersonalBank> {
    const signatures: string[][] = [];
    let polls = 0;
    let pending: { ref: string; message: BankMessage; ctx: SimContext } | null = null;
    let jobErrorSent = false;
    const stats = { executed: 0 };
    const pay = o.payments;
    const vopMode = pay?.vop ?? "match";

    const bpd = (ref?: number): BankSegment[] => [
        ...simBpd(9, ref).map((s) =>
            s.id === "HIPINS"
                ? { ...s, elements: [1, 1, 0, [5, 20, 6, "Anmeldename", "Kunden-ID", "HKSAL", "N", "HKKAZ", "J", "HKCAZ", "J", "HKKKU", "J", "HKSPA", "N", "HKTAN", "N", "HKTAB", "N", "HKCDB", o.ordersTan ? "J" : "N", "HKCSB", o.ordersTan ? "J" : "N", ...(pay ? ["HKCCS", "J", "HKIPZ", "J", "HKVPP", "N", "HKVPA", "N"] : [])]] }
                : s,
        ),
        ...(pay
            ? [
                  { id: "HICCSS", version: 1, ref, elements: [1, 1, 0] },
                  { id: "HIIPZS", version: 2, ref, elements: [1, 1, 0, ["N", "", PAIN_V9]] },
                  ...(vopMode === "off"
                      ? []
                      : [
                            { id: "HIVPPS", version: 1, ref, elements: [1, 1, 0, [1, "J", "V", "N", "N", PAIN002_V10, "HKCCS", "HKIPZ"]] },
                            { id: "HIVPAS", version: 1, ref, elements: [1, 1, 0] },
                        ]),
              ]
            : []),
        simHitans(ref),
        { id: "HITABS", version: 5, ref, elements: [1, 1, 0] },
        { id: "HISPAS", version: 3, ref, elements: [1, 1, 0, ["J", "N", "N", "N", 0, "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"]] },
        { id: "HIKKUS", version: 1, ref, elements: [1, 1, 0, [180, "N", "J", "J"]] },
        ...(o.noOrders
            ? []
            : [
                  { id: "HICDBS", version: 1, ref, elements: [1, 1, 0, ["N"]] },
                  { id: "HICSBS", version: 1, ref, elements: [1, 1, 0, ["N", "J"]] },
                  { id: "HICSBS", version: 2, ref, elements: [1, 1, 0, ["N", "J", PAIN_V9]] },
              ]),
        ...(o.noCamt ? [] : [{ id: "HICAZS", version: 1, ref, elements: [1, 1, 0, [365, "N", "N", CAMT_V8, "urn:iso:std:iso:20022:tech:xsd:camt.052.001.02"]] }]),
    ];

    const upd = (): BankSegment[] => [
        { id: "HIUPA", version: 4, elements: [SIM_USER, 5, 0, "Erika Mustermann"] },
        { id: "HIUPD", version: 6, elements: [["1234567", "", "280", SIM_BLZ], SIM_GIRO_IBAN, SIM_USER, 1, "EUR", "Erika Mustermann", "", "Girokonto", "", ["HKSAL", 1], ["HKKAZ", 1], ["HKCAZ", 1], ["HKSPA", 1], ["HKCCS", 1], ["HKIPZ", 1], ["HKCDB", 1], ["HKCSB", 1]] },
        { id: "HIUPD", version: 6, elements: [[SIM_CARD, "", "280", SIM_BLZ], "", SIM_USER, 50, "EUR", "Erika Mustermann", "", "Visa Card", "", ["HKKKU", 1], ["HKSAL", 1]] },
        { id: "HIUPD", version: 6, elements: ["", "", SIM_USER, "", "", "", "", "Online-Banking"] },
    ];

    /** Answers to the jobs in `m` (a customer message), possibly after an approval. */
    const jobs = (m: BankMessage, ctx: SimContext): BankSegment[] => {
        const out: BankSegment[] = [];
        if (m.find("HKIDN")) out.push(...upd());
        const n = (id: string) => ctx.numberOf(id);
        if (n("HKTAB") !== undefined) {
            if (o.jobError && !jobErrorSent) {
                jobErrorSent = true;
                return [ok(n("HKTAB"), o.jobError[0], o.jobError[1])];
            }
            out.push(ok(n("HKTAB")), { id: "HITAB", version: 5, ref: n("HKTAB"), elements: ["0", ["M", "1", "", "", "", "", "", "", "", "", "", "", "", "Mein Telefon"], ["M", "2", "", "", "", "", "", "", "", "", "", "", "", "Altes Telefon"]] });
        }
        if (n("HKSPA") !== undefined) {
            out.push(ok(n("HKSPA")), { id: "HISPA", version: 3, ref: n("HKSPA"), elements: [["J", SIM_GIRO_IBAN, "SIMUDEM1XXX", "1234567", "", "280", SIM_BLZ]] });
        }
        const sal = m.find("HKSAL");
        if (sal) {
            const card = text(sal.elements[0], 2) === SIM_CARD;
            out.push(ok(sal.number), {
                id: "HISAL", version: 7, ref: sal.number,
                elements: [sal.elements[0]!.map((c) => (typeof c === "string" ? c : "")), card ? "Visa Card" : "Girokonto", "EUR", [card ? "D" : "C", card ? "312,5" : "2207,01", "EUR", "20261115"], ["D", "9,9", "EUR", "20261115"], ["3000,", "EUR"], ["5197,11", "EUR"]],
            });
        }
        const caz = m.find("HKCAZ");
        if (caz) {
            const touchdown = text(caz.elements[6]);
            if (!touchdown) {
                out.push({ id: "HIRMS", version: 2, ref: caz.number, elements: [["3040", "", "Es liegen weitere Informationen vor.", "PAGE2"]] });
                out.push({ id: "HICAZ", version: 1, ref: caz.number, elements: [[SIM_GIRO_IBAN, "", "1234567", "", "280", SIM_BLZ], CAMT_V8, [Buffer.from(CAMT_PAGE_1)]] });
            } else {
                out.push(ok(caz.number), { id: "HICAZ", version: 1, ref: caz.number, elements: [[SIM_GIRO_IBAN, "", "1234567", "", "280", SIM_BLZ], CAMT_V8, [Buffer.from(CAMT_PAGE_2)], Buffer.from(CAMT_PENDING)] });
            }
        }
        const giro = [SIM_GIRO_IBAN, "SIMUDEM1XXX", "1234567", "", "280", SIM_BLZ];
        const cdb = m.find("HKCDB");
        if (cdb) {
            const order = (pain: string, id: string, details: (string | number)[], flags: string[] = []) => ({ id: "HICDB", version: 1, ref: cdb.number, elements: [giro, PAIN_V9, Buffer.from(pain), id, details, "", ...flags] });
            if (!text(cdb.elements[4])) {
                out.push({ id: "HIRMS", version: 2, ref: cdb.number, elements: [["3040", "", "Es liegen weitere Informationen vor.", "ORDERS2"]] });
                // Monthly on the 1st, changeable and deletable; quarterly at the end of the month until a last date
                out.push(order(PAIN_RENT, "DA-1", ["20240101", "M", 1, 1], ["J", "N", "J"]), order(PAIN_SAVINGS, "DA-2", ["20250230", "M", 3, 31, "20271231"], ["N", "N", "N"]));
            } else {
                // Every two weeks on Fridays; the bank says nothing about changing it
                out.push(ok(cdb.number), order(PAIN_CLUB, "DA-3", ["20261106", "W", 2, 5]));
            }
        }
        const csb = m.find("HKCSB");
        if (csb) out.push(ok(csb.number), { id: "HICSB", version: 2, ref: csb.number, elements: [giro, PAIN_V9, Buffer.from(PAIN_SCHEDULED), "TU-1", "", "N", "1"] });
        const payment = m.find("HKCCS") ?? m.find("HKIPZ");
        if (payment && pay) {
            if (pay.reject) out.push({ id: "HIRMS", version: 2, ref: payment.number, elements: [[pay.reject[0], "", pay.reject[1]]] });
            else {
                stats.executed++;
                if (payment.id === "HKIPZ") {
                    out.push({ id: "HIRMS", version: 2, ref: payment.number, elements: [["0020", "", "Auftrag ausgeführt."], ...(pay.unconfirmed ? [["3045", "", "SEPA-Instant Payment Statusabfrage HKIPS veranlassen."]] : [])] });
                    out.push({ id: "HIIPZ", version: 2, ref: payment.number, elements: ["IPZ-77", "", pay.unconfirmed ? "1" : "7"] });
                } else {
                    out.push({ id: "HIRMS", version: 2, ref: payment.number, elements: [["0010", "", "Auftrag zur Ausführung vorgemerkt."], ["3070", "", "Auftrag wird unter Referenz REF-0815 verarbeitet.", "REF-0815"]] });
                }
            }
        }
        const kaz = m.find("HKKAZ");
        if (kaz) out.push(ok(kaz.number), { id: "HIKAZ", version: 7, ref: kaz.number, elements: [Buffer.from(MT940, "latin1")] });
        const kku = m.find("HKKKU");
        if (kku) {
            const booking = (d: string, amount: string, mark: string, merchant: string, billed: string) => [SIM_CARD, d, d, "", d, "", "", "", "", amount, "EUR", mark, merchant.toUpperCase(), "", "", "", "", "", "", "", "DE", merchant, "", billed, `KK${d}`];
            out.push(ok(kku.number), {
                id: "HIKKU", version: 1, ref: kku.number,
                elements: [SIM_CARD, "", ["D", "312,5", "EUR", "20261115"], "20261020", "20261120", booking("20261103", "54,", "D", "Buchhandlung", "J"), booking("20261110", "258,5", "D", "Bahn", "N")],
            });
        }
        return out;
    };

    const challenge = (t: number, kind: "decoupled" | "tan", m: BankMessage, ctx: SimContext): BankSegment[] => {
        const ref = `REF${Math.floor(Math.random() * 1e6)}`;
        pending = { ref, message: m, ctx };
        polls = 0;
        const codes: string[][] = kind === "decoupled" && o.without0030 ? [] : [["0030", "", "Auftrag empfangen - Sicherheitsfreigabe erforderlich."]];
        if (kind === "decoupled") codes.push(["3955", "", "Sicherheitsfreigabe erfolgt über anderen Kanal."]);
        return [
            { id: "HIRMS", version: 2, ref: t, elements: codes },
            { id: "HITAN", version: 7, ref: t, elements: ["4", "", ref, kind === "decoupled" ? "Bitte bestätigen Sie den Vorgang in Ihrer App." : "Bitte TAN eingeben.", "", ["20261116", "103000"], "Mein Telefon"] },
        ];
    };

    const handle = (m: BankMessage, ctx: SimContext): BankSegment[] | "close" => {
        const sha = m.find("HNSHA");
        const sig = sha ? (sha.elements[2] ?? []).map((_, i) => text(sha.elements[2], i)) : [];
        signatures.push(sig);
        // Anonymous dialog (Formals C.5): no signature, bank parameters only
        if (!sha) {
            if (m.find("HKEND")) return [ok(), ok(ctx.numberOf("HKEND"), "0100", "Dialog beendet.")];
            if (text(m.find("HKIDN")?.elements[1]) === "9999999999") return [ok(), ...bpd(ctx.numberOf("HKVVB"))];
        }
        if (sig[0] !== SIM_PIN) return [{ id: "HIRMG", version: 2, elements: [["9942", "", "PIN ungültig."]] }];
        if (m.find("HKEND")) return [ok(), ok(ctx.numberOf("HKEND"), "0100", "Dialog beendet.")];

        const secFunc = text(m.find("HNSHK")?.elements[1]);
        const idn = m.find("HKIDN");
        const tan = m.find("HKTAN");
        const out: BankSegment[] = [ok()];

        if (idn) {
            const vvb = ctx.numberOf("HKVVB");
            out.push(...bpd(vvb));
            if (secFunc === "999") {
                out.push({ id: "HIRMS", version: 2, ref: vvb, elements: [["3920", "", "Zugelassene Zwei-Schritt-Verfahren für den Benutzer.", "946", "942"]] });
                if (m.find("HKSYN")) {
                    if (o.refuseSyncWith999) out.push(ok(ctx.numberOf("HKSYN"), "9210", "Synchronisierung nicht zulässig."));
                    else out.push({ id: "HISYN", version: 4, ref: ctx.numberOf("HKSYN"), elements: [SIM_SYSTEM_ID] });
                }
                return out;
            }
            if (m.find("HKSYN")) out.push({ id: "HISYN", version: 4, ref: ctx.numberOf("HKSYN"), elements: [SIM_SYSTEM_ID] });
        }

        const process = text(tan?.elements[0]);
        const t = ctx.numberOf("HKTAN");

        // Payments with verification of payee (Messages – VoP, E.8.1.1)
        const vpp = m.find("HKVPP");
        const vpa = m.find("HKVPA");
        const payment = m.find("HKCCS") ?? m.find("HKIPZ");
        if (pay && vpp) {
            const single = (code: string, name = "") => [SIM_PAYEE_IBAN, "", name, "", code, code === "RVNA" ? "Keine Antwort der Empfängerbank" : ""];
            const hivpp = (o2: { id?: boolean; polling?: boolean; single?: (string | number)[]; report?: string }) => ({
                id: "HIVPP",
                version: 1,
                ref: vpp.number,
                elements: [o2.id ? Buffer.from(SIM_VOP_ID) : "", "", o2.polling ? Buffer.from("POLL-1") : "", o2.report ? PAIN002_V10 : "", o2.report ? Buffer.from(o2.report) : "", o2.single ?? "", o2.single?.[4] === "RCVC" || o2.polling ? "" : "<p>Der Name weicht ab.</p><b>Bitte prüfen.</b>", o2.polling ? 0 : ""],
            });
            if (!payment) {
                // Polling: the final result, a match
                out.push({ id: "HIRMS", version: 2, ref: vpp.number, elements: [["3094", "", "Namensabgleich ist komplett."]] }, hivpp({ id: true, single: single("RCVC") }));
                if (vopMode === "polling_3076" && t !== undefined) out.push(ok(t, "3076", "Keine starke Authentifizierung erforderlich."));
                return out;
            }
            if (vopMode === "polling" || vopMode === "polling_3076") {
                out.push({ id: "HIRMS", version: 2, ref: vpp.number, elements: [["3093", "", "Namensabgleich ist noch in Bearbeitung."], ["3040", "", "Es liegen weitere Informationen vor.", "VOPTD"]] }, hivpp({ polling: true }));
                return out;
            }
            if (vopMode === "bagatelle") {
                out.push({ id: "HIRMS", version: 2, ref: vpp.number, elements: [["3091", "", "VOP-Ausführungsauftrag nicht benötigt."]] }, hivpp({ id: true, single: single("RCVC") }));
                if (t !== undefined) out.push(ok(t, "3076", "Keine starke Authentifizierung erforderlich."));
                return [...out, ...jobs(m, ctx)];
            }
            if (vopMode === "match" || vopMode === "match_vpa") {
                out.push(hivpp({ id: true, single: single("RCVC") }));
                if (vopMode === "match") out.push({ id: "HIRMS", version: 2, ref: vpp.number, elements: [["0025", "", "Keine Namensabweichung."], ["3091", "", "VOP-Ausführungsauftrag nicht benötigt."]] });
                // falls through to the challenge for the payment
            } else {
                const code = ({ close: "RVMC", pain002_close: "RVMC", no_match: "RVNM", not_applicable: "RVNA" } as Record<string, string>)[vopMode] ?? "RVNA";
                const report = vopMode === "pain002_close"
                    ? `<?xml version="1.0"?><Document xmlns="${PAIN002_V10}"><CstmrPmtStsRpt><OrgnlGrpInfAndSts><GrpSts>RVMC</GrpSts></OrgnlGrpInfAndSts><OrgnlPmtInfAndSts><TxInfAndSts><TxSts>RVMC</TxSts><OrgnlTxRef><Cdtr><Pty><Nm>${SIM_BANK_PAYEE_NAME}</Nm></Pty></Cdtr></OrgnlTxRef></TxInfAndSts></OrgnlPmtInfAndSts></CstmrPmtStsRpt></Document>`
                    : undefined;
                out.push({ id: "HIRMS", version: 2, ref: vpp.number, elements: [["3090", "", "Ergebnis Namensabgleich prüfen."]] });
                out.push(report ? hivpp({ id: true, report }) : hivpp({ id: true, single: single(code, code === "RVMC" ? SIM_BANK_PAYEE_NAME : "") }));
                if (t !== undefined) out.push({ id: "HIRMS", version: 2, ref: t, elements: [["3945", "", "Freigabe kann nicht erteilt werden."]] });
                return out;
            }
        }
        if (pay && vpa && text(vpa.elements[0]) !== SIM_VOP_ID) return [{ id: "HIRMG", version: 2, elements: [["9010", "", "VOP-ID unbekannt."]] }];
        if (tan && process === "4" && t !== undefined) {
            const kind = idn ? (o.sca ?? "decoupled") : (o.jobSca ?? "none");
            if (kind === "none") {
                out.push(ok(t, "3076", "Keine starke Authentifizierung erforderlich."), { id: "HITAN", version: 7, ref: t, elements: ["4", "", "noref", "nochallenge"] });
                return [...out, ...jobs(m, ctx)];
            }
            return [...out, ...challenge(t, kind, m, ctx)];
        }
        if (tan && (process === "S" || process === "2") && t !== undefined) {
            if (!pending || text(tan.elements[4]) !== pending.ref) return [{ id: "HIRMG", version: 2, elements: [["9210", "", "Auftragsreferenz ist unbekannt."]] }];
            if (process === "S" && polls++ < (o.pendingPolls ?? 0)) {
                out.push(ok(t, "3956", "Starke Kundenauthentifizierung noch ausstehend."), { id: "HITAN", version: 7, ref: t, elements: ["S", "", pending.ref, "nochallenge"] });
                return out;
            }
            if (process === "2" && sig[1] !== SIM_TAN) return [{ id: "HIRMG", version: 2, elements: [["9941", "", "TAN ungültig."]] }];
            const p = pending;
            const paid = p.message.find("HKCCS") ?? p.message.find("HKIPZ");
            if (pay && paid && vopMode === "match_vpa" && p.message.find("HKVPP") && text(m.find("HKVPA")?.elements[0]) !== SIM_VOP_ID) {
                return [{ id: "HIRMG", version: 2, elements: [["9010", "", "VOP-Ausführungsauftrag fehlt."]] }];
            }
            pending = null;
            if (pay && paid && pay.dropOnExecute && !pay.reject) {
                stats.executed++;
                return "close";
            }
            out.push(ok(t, "0020", "Sicherheitsfreigabe gültig."), { id: "HITAN", version: 7, ref: t, elements: [process, "", "noref"] });
            return [...out, ...jobs(p.message, p.ctx)];
        }
        return [...out, ...jobs(m, ctx)];
    };

    const sim = await startBankSim(handle);
    // A getter, so tests read the current count (Object.assign would copy the value once)
    return Object.defineProperty(Object.assign(sim, { signatures }), "executed", { get: () => stats.executed }) as PersonalBank;
}
