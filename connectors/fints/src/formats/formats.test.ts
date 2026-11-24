import { describe, expect, it } from "vitest";
import { parseMt940 } from "./mt940.js";
import { parseCamt } from "./camt.js";
import { parseCardStatement } from "./kku.js";
import { splitSepaPurpose } from "./transaction.js";
import { parseSegments } from "../syntax/parse.js";
import { buildPain001, parsePain001, pickPainFormat, type PaymentOrder } from "./pain001.js";
import { parsePain002 } from "./pain002.js";
import { CAMT_PAGE_1, CAMT_PAGE_2, CAMT_PENDING, MT940, PAIN_SAVINGS, PAIN_SCHEDULED } from "../testing/personal-bank.js";

describe("MT940", () => {
    it("reads bookings with SEPA details", () => {
        const [salary, debit] = parseMt940(MT940, "booked");
        expect(salary).toMatchObject({
            bookingDate: "2026-11-02",
            valueDate: "2026-11-02",
            amount: 125000,
            currency: "EUR",
            status: "booked",
            counterpartyName: "Muster GmbH",
            counterpartyIban: "DE89370400440532013000",
            counterpartyBic: "COBADEFFXXX",
            remittance: "Gehalt November",
            endToEndId: "LOHN-2026-11",
            bookingText: "GUTSCHRIFT",
            bankReference: "REF-A",
        });
        expect(debit).toMatchObject({ amount: -4299, counterpartyName: "Stadtwerke Musterstadt", remittance: "Abschlag Strom November", endToEndId: null, mandateId: "M-77", creditorId: "DE98ZZZ09999999999" });
    });

    it("handles reversals, year boundaries and continuation lines", () => {
        const text = [":60F:C261231EUR0,", ":61:2612310102RC10,5NTRFNONREF", ":86:117?00STORNO?20Rueck", "buchung", ":61:2601021231RD3,NTRFNONREF", "-"].join("\n");
        const [a, b] = parseMt940(text, "pending");
        expect(a).toMatchObject({ amount: -1050, valueDate: "2026-12-31", bookingDate: "2027-01-02", status: "pending", remittance: "Rueckbuchung" });
        expect(b).toMatchObject({ amount: 300, valueDate: "2026-01-02", bookingDate: "2025-12-31" });
    });

    it("recognizes returns by mark, business code and text, and keeps the reason as sent", () => {
        const text = [
            ":60F:C261030EUR100,",
            ":61:2610301102RD50,NRTINONREF", ":86:166?00GUTSCHRIFT?20Strom?32Stadtwerke?34901",
            ":61:2610301102C20,NRTINONREF", ":86:109?00GUTSCHRIFT?20Gas?32Stadtwerke?34902",
            ":61:2610301102C10,NRTINONREF", ":86:166?00RUECKLASTSCHRIFT?20Wasser?32Stadtwerke",
            ":61:2610301102C5,NTRFNONREF", ":86:166?00GUTSCHRIFT?20Rest?32Anna?34997",
            "-",
        ].join("\n");
        const [byMark, byCode, byText, plain] = parseMt940(text, "booked");
        expect(byMark).toMatchObject({ amount: 5000, isReturn: true, returnReason: "901" });
        expect(byCode).toMatchObject({ isReturn: true, returnReason: "902" });
        expect(byText).toMatchObject({ isReturn: true, returnReason: "" });
        expect(plain).toMatchObject({ isReturn: false, returnReason: "" });
    });

    it("leaves the statement's own :86: after the closing balance to the statement", () => {
        const text = [
            ":20:STARTUMS", ":25:70054306/1234567", ":28C:1", ":60F:C261110EUR100,",
            ":61:2611101110D12,34NDDTNONREF", ":86:105?00LASTSCHRIFT?20SVWZ+Strom?32Stadtwerke",
            ":62F:C261110EUR87,66", ":86:Kontoinformation?20Neue Entgelte ab 1.1.",
            "-",
            ":20:STARTUMS", ":25:70054306/1234567", ":28C:2", ":60F:C261111EUR87,66",
            ":61:2611111111C5,NTRFNONREF", ":86:166?00GUTSCHRIFT?20Rest?32Anna",
            ":61:2611111111C1,NTRFNONREF",
            ":62F:C261111EUR93,66", ":86:999?20Abschluss", "-",
        ].join("\n");
        const [debit, credit, bare] = parseMt940(text, "booked");
        expect(debit).toMatchObject({ amount: -1234, counterpartyName: "Stadtwerke", remittance: "Strom", bookingText: "LASTSCHRIFT" });
        expect(credit).toMatchObject({ amount: 500, counterpartyName: "Anna", remittance: "Rest" });
        expect(bare).toMatchObject({ amount: 100, counterpartyName: "", remittance: "", bookingText: "" });
    });

    it("keeps the ultimate party (ABWE, ABWA) apart from the counterparty", () => {
        const text = [
            ":60F:C261110EUR100,",
            ":61:2611101110D25,NDDTNONREF",
            ":86:106?00KARTENZAHLUNG?20EREF+1234?21SVWZ+2026-11-09T18.30 Debitk.?22ABWE+Shop Muster/Hauptstr. 1/?23MUSTERSTADT/DE?32Landesbank Muster",
            ":61:2611101110D5,NDDTNONREF",
            ":86:106?00KARTENZAHLUNG?20SVWZ+Kaffee?21ABWA+Cafe Eck?32Landesbank Muster",
            ":61:2611101110D1,NDDTNONREF",
            ":86:106?00KARTENZAHLUNG?20SVWZ+Brot?21ABWA+Baeckerei",
            "-",
        ].join("\n");
        const [card, cafe, bakery] = parseMt940(text, "booked");
        expect(card).toMatchObject({ counterpartyName: "Landesbank Muster", ultimateParty: "Shop Muster/Hauptstr. 1/MUSTERSTADT/DE", remittance: "2026-11-09T18.30 Debitk.", bookingText: "KARTENZAHLUNG" });
        expect(cafe).toMatchObject({ counterpartyName: "Landesbank Muster", ultimateParty: "Cafe Eck" });
        // Without a name the ultimate party is the name
        expect(bakery).toMatchObject({ counterpartyName: "Baeckerei", ultimateParty: "" });
    });

    it("keeps an account number and bank code without an IBAN, but no zero fillers", () => {
        const text = [
            ":60F:C261110EUR100,",
            ":61:2611101110C5,NTRFNONREF", ":86:166?00GUTSCHRIFT?2010?3012030000?311234567?32Anna",
            ":61:2611101110D1,NCHGNONREF", ":86:808?00ENTGELT?20Konto?3000000000?310000000000",
            ":61:2611101110C2,NTRFNONREF", ":86:166?00GUTSCHRIFT?2020?3012030000?31DE89370400440532013000?32Ben",
            "-",
        ].join("\n");
        const [national, fee, sepa] = parseMt940(text, "booked");
        expect(national).toMatchObject({ counterpartyIban: null, counterpartyAccount: "1234567", counterpartyBankCode: "12030000" });
        expect(fee).toMatchObject({ counterpartyIban: null, counterpartyAccount: "", counterpartyBankCode: "" });
        expect(sepa).toMatchObject({ counterpartyIban: "DE89370400440532013000", counterpartyAccount: "", counterpartyBankCode: "" });
    });

    it("reads the customer reference from KREF, else from :61: unless it repeats another reference", () => {
        const text = [
            ":60F:C261101EUR0,",
            ":61:2611101110D10,NTRFAUFTRAG-1//B1",
            ":86:116?00UEBERWEISUNG?20EREF+E-1?21KREF+SAMMLER-2026-11?22SVWZ+Miete",
            ":61:2611101110D11,NTRFAUFTRAG-2//B2",
            ":86:116?00UEBERWEISUNG?20EREF+E-2?21SVWZ+Miete",
            ":61:2611101110D12,NDDTVERTRAG-2026-000",
            ":86:105?00LASTSCHRIFT?20EREF+VERTRAG-2026-000123?21SVWZ+Strom",
            ":61:2611101110D13,NDDTNONREF",
            ":86:105?00LASTSCHRIFT?20EREF+E-4?21SVWZ+Gas",
            ":61:2611101110C14,NTRFKD-77",
            ":86:Unstrukturierter Text",
            "-",
        ].join("\n");
        const [kref, own, repeated, none, unstructured] = parseMt940(text, "booked");
        expect(kref).toMatchObject({ customerReference: "SAMMLER-2026-11", endToEndId: "E-1", bankReference: "B1", remittance: "Miete" });
        expect(own).toMatchObject({ customerReference: "AUFTRAG-2", endToEndId: "E-2", bankReference: "B2" });
        expect(repeated).toMatchObject({ customerReference: null, endToEndId: "VERTRAG-2026-000123" });
        expect(none).toMatchObject({ customerReference: null });
        expect(unstructured).toMatchObject({ customerReference: "KD-77", remittance: "Unstrukturierter Text" });
    });
});

describe("camt.052", () => {
    it("reads booked entries of version .08", () => {
        const [salary] = parseCamt(CAMT_PAGE_1, "booked");
        expect(salary).toMatchObject({ bookingDate: "2026-11-02", amount: 125000, counterpartyName: "Muster GmbH", counterpartyIban: "DE89370400440532013000", remittance: "Gehalt November", endToEndId: "LOHN-2026-11", bookingText: "Gehalt", bankReference: "REF-A" });
        const [debit] = parseCamt(CAMT_PAGE_2, "booked");
        expect(debit).toMatchObject({ amount: -4299, counterpartyName: "Stadtwerke Musterstadt", counterpartyIban: "DE44500105175407324931", endToEndId: null, mandateId: "M-77", creditorId: "DE98ZZZ09999999999", remittance: "Abschlag Strom November" });
        expect(salary!.customerReference).toBeNull();
    });

    it("reads the customer reference from KREF in the remittance", () => {
        const doc = `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"><BkToCstmrAcctRpt><Rpt><Ntry><Amt Ccy="EUR">5</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-11-01</Dt></BookgDt><AcctSvcrRef>B7</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>E7</EndToEndId></Refs><RmtInf><Ustrd>EREF+E7 KREF+K7 SVWZ+Danke</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Rpt></BkToCstmrAcctRpt></Document>`;
        expect(parseCamt(doc, "booked")).toEqual([expect.objectContaining({ endToEndId: "E7", customerReference: "K7", bankReference: "B7", remittance: "Danke" })]);
    });

    it("reads the status of the entry and version .02 names", () => {
        expect(parseCamt(CAMT_PENDING, "booked")[0]).toMatchObject({ status: "pending", amount: -990, counterpartyName: "Kiosk", valueDate: null });
        const v2 = `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.02"><BkToCstmrAcctRpt><Rpt><Ntry><Amt Ccy="EUR">5</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-11-01</Dt></BookgDt><NtryDtls><TxDtls><RltdPties><Dbtr><Nm>A &amp; B</Nm></Dbtr></RltdPties><RmtInf><Ustrd>EREF+E1 SVWZ+Danke</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Rpt></BkToCstmrAcctRpt></Document>`;
        expect(parseCamt(v2, "pending")[0]).toMatchObject({ status: "booked", amount: 500, counterpartyName: "A & B", ultimateParty: "", endToEndId: "E1", remittance: "Danke" });
    });

    it("keeps the ultimate creditor apart from the creditor", () => {
        const entry = (parties: string) =>
            `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"><BkToCstmrAcctRpt><Rpt><Ntry><Amt Ccy="EUR">25</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-11-10</Dt></BookgDt><AddtlNtryInf>Kartenzahlung</AddtlNtryInf><NtryDtls><TxDtls><RltdPties>${parties}</RltdPties></TxDtls></NtryDtls></Ntry></Rpt></BkToCstmrAcctRpt></Document>`;
        const [card] = parseCamt(entry("<Cdtr><Pty><Nm>Landesbank Muster</Nm></Pty></Cdtr><UltmtCdtr><Pty><Nm>Shop Muster</Nm></Pty></UltmtCdtr>"), "booked");
        expect(card).toMatchObject({ counterpartyName: "Landesbank Muster", ultimateParty: "Shop Muster", bookingText: "Kartenzahlung" });
        const [only] = parseCamt(entry("<UltmtCdtr><Pty><Nm>Shop Muster</Nm></Pty></UltmtCdtr>"), "booked");
        expect(only).toMatchObject({ counterpartyName: "Shop Muster", ultimateParty: "" });
        const [same] = parseCamt(entry("<Cdtr><Pty><Nm>Shop Muster</Nm></Pty></Cdtr><UltmtCdtr><Pty><Nm>SHOP MUSTER</Nm></Pty></UltmtCdtr>"), "booked");
        expect(same).toMatchObject({ counterpartyName: "Shop Muster", ultimateParty: "" });
    });

    it("skips entries it cannot read", () => {
        expect(parseCamt("<Document><BkToCstmrAcctRpt><Rpt><Ntry><Amt>1.234</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-11-01</Dt></BookgDt></Ntry></Rpt></BkToCstmrAcctRpt></Document>", "booked")).toEqual([]);
        expect(parseCamt("<Other/>", "booked")).toEqual([]);
    });

    const wrap = (details: string, info = "") =>
        `<Document><BkToCstmrAcctRpt><Rpt><Ntry><Amt Ccy="EUR">30.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-11-10</Dt></BookgDt>${info}${details}</Ntry></Rpt></BkToCstmrAcctRpt></Document>`;
    const item = (name: string, iban: string, purpose: string) =>
        `<TxDtls><Refs><EndToEndId>E-${name}</EndToEndId></Refs><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr><CdtrAcct><Id><IBAN>${iban}</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>${purpose}</Ustrd></RmtInf></TxDtls>`;

    it("keeps another account id and the bank code without an IBAN, but no fillers", () => {
        const details = (account: string, code: string) =>
            wrap(`<NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Laden</Nm></Cdtr><CdtrAcct><Id><Othr><Id>${account}</Id></Othr></Id></CdtrAcct></RltdPties><RltdAgts><CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${code}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt></RltdAgts></TxDtls></NtryDtls>`);
        expect(parseCamt(details("1234567", "12030000"), "booked")[0]).toMatchObject({ counterpartyIban: null, counterpartyAccount: "1234567", counterpartyBankCode: "12030000" });
        expect(parseCamt(details("0000000", "NOTPROVIDED"), "booked")[0]).toMatchObject({ counterpartyAccount: "", counterpartyBankCode: "" });
    });

    it("gives a batch no counterparty and remembers what its first item said", () => {
        const items = item("Anna", "DE89370400440532013000", "Rechnung 1") + item("Ben", "DE44500105175407324931", "Rechnung 2");
        const [batch] = parseCamt(wrap(`<NtryDtls>${items}</NtryDtls>`, "<AddtlNtryInf>SAMMLER</AddtlNtryInf>"), "booked");
        expect(batch).toMatchObject({
            amount: -3000,
            counterpartyName: "",
            counterpartyIban: null,
            endToEndId: null,
            remittance: "Sammelbuchung mit 2 Posten",
            bookingText: "SAMMLER",
            replaces: { counterpartyIban: "DE89370400440532013000", remittance: "Rechnung 1", endToEndId: "E-Anna" },
        });
    });

    it("counts a batch over all details and by its stated number", () => {
        const two = `<NtryDtls>${item("Anna", "DE89370400440532013000", "A")}</NtryDtls><NtryDtls>${item("Ben", "DE44500105175407324931", "B")}</NtryDtls>`;
        expect(parseCamt(wrap(two), "booked")[0]).toMatchObject({ remittance: "Sammelbuchung mit 2 Posten", counterpartyIban: null });
        const stated = `<NtryDtls><Btch><NbOfTxs>5</NbOfTxs></Btch>${item("Anna", "DE89370400440532013000", "A")}</NtryDtls>`;
        expect(parseCamt(wrap(stated), "booked")[0]).toMatchObject({ remittance: "Sammelbuchung mit 5 Posten", counterpartyName: "" });
    });

    it("leaves a single payment as it is", () => {
        const single = `<NtryDtls><Btch><NbOfTxs>1</NbOfTxs></Btch>${item("Anna", "DE89370400440532013000", "A")}</NtryDtls>`;
        expect(parseCamt(wrap(single), "booked")[0]).toMatchObject({ counterpartyName: "Anna", counterpartyIban: "DE89370400440532013000", remittance: "A", replaces: null });
    });

    it("takes the payment information id as customer reference, for a batch only the one of the whole order", () => {
        const withId = (name: string, id: string, purpose = "A") => item(name, "DE89370400440532013000", purpose).replace("</EndToEndId>", `</EndToEndId><PmtInfId>${id}</PmtInfId>`);
        expect(parseCamt(wrap(`<NtryDtls>${withId("Anna", "SCT1531357")}</NtryDtls>`), "booked")[0]).toMatchObject({ customerReference: "SCT1531357", remittance: "A" });
        // KREF in the remittance comes first; a fill value is none
        expect(parseCamt(wrap(`<NtryDtls>${withId("Anna", "P-1", "KREF+K-1 SVWZ+A")}</NtryDtls>`), "booked")[0]).toMatchObject({ customerReference: "K-1" });
        expect(parseCamt(wrap(`<NtryDtls>${withId("Anna", "NOTPROVIDED")}</NtryDtls>`), "booked")[0]).toMatchObject({ customerReference: null });
        // A batch: its own id, else the one all items share, else none
        const batch = (details: string) => parseCamt(wrap(details), "booked")[0]!.customerReference;
        expect(batch(`<NtryDtls><Btch><PmtInfId>B-1</PmtInfId></Btch>${withId("Anna", "X")}${withId("Ben", "Y")}</NtryDtls>`)).toBe("B-1");
        expect(batch(`<NtryDtls>${withId("Anna", "S-1")}${withId("Ben", "S-1")}</NtryDtls>`)).toBe("S-1");
        expect(batch(`<NtryDtls>${withId("Anna", "S-1")}${withId("Ben", "S-2")}</NtryDtls>`)).toBeNull();
    });
});

describe("camt.052 returns", () => {
    const OWN = "DE02120300000000202051";
    const WERKE = "DE89370400440532013000";
    const side = (role: string, name: string, iban: string) => `<${role}><Nm>${name}</Nm></${role}><${role}Acct><Id><IBAN>${iban}</IBAN></Id></${role}Acct>`;
    const original = side("Dbtr", "Konto Inhaber", OWN) + side("Cdtr", "Stadtwerke", WERKE);
    const swapped = side("Dbtr", "Stadtwerke", WERKE) + side("Cdtr", "Konto Inhaber", OWN);
    const report = (parties: string, marks = "<RvslInd>true</RvslInd>", details = "<RtrInf><Rsn><Cd>AM04</Cd></Rsn></RtrInf>", account = `<Acct><Id><IBAN>${OWN}</IBAN></Id></Acct>`) =>
        `<Document><BkToCstmrAcctRpt><Rpt>${account}<Ntry><Amt Ccy="EUR">50.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>${marks}<Sts>BOOK</Sts><BookgDt><Dt>2026-11-02</Dt></BookgDt><NtryDtls><TxDtls><RltdPties>${parties}</RltdPties>${details}</TxDtls></NtryDtls></Ntry></Rpt></BkToCstmrAcctRpt></Document>`;

    it("takes the side that is not this account, whichever roles the bank keeps", () => {
        for (const parties of [original, swapped]) {
            expect(parseCamt(report(parties), "booked")[0]).toMatchObject({ amount: 5000, counterpartyName: "Stadtwerke", counterpartyIban: WERKE, isReturn: true, returnReason: "AM04" });
        }
    });

    it("assumes the original roles of a return when the report names no account", () => {
        expect(parseCamt(report(original, undefined, undefined, ""), "booked")[0]).toMatchObject({ counterpartyName: "Stadtwerke", counterpartyIban: WERKE });
    });

    it("recognizes a return by its details or transaction code alone", () => {
        expect(parseCamt(report(original, ""), "booked")[0]).toMatchObject({ isReturn: true });
        const code = "<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>IDDT</Cd><SubFmlyCd>UPDD</SubFmlyCd></Fmly></Domn></BkTxCd>";
        expect(parseCamt(report(original, code, ""), "booked")[0]).toMatchObject({ isReturn: true, returnReason: "" });
    });

    it("leaves an ordinary credit from someone else as it is", () => {
        const credit = side("Dbtr", "Muster GmbH", WERKE) + side("Cdtr", "Konto Inhaber", OWN);
        expect(parseCamt(report(credit, "", ""), "booked")[0]).toMatchObject({ counterpartyName: "Muster GmbH", isReturn: false, returnReason: "" });
    });
});

describe("credit card statement", () => {
    it("reads balance and bookings of HIKKU", () => {
        const [s] = parseSegments("HIKKU:5:1:3+4111000000001234++D:312,5:EUR:20261115+20261020+20261120+4111000000001234:20261103:20261103::20261103:::::54,:EUR:D:BUCHHANDLUNG::::::::DE:Buchhandlung::J:KK1'");
        const st = parseCardStatement(s!);
        expect(st.balance).toEqual({ cents: -31250, currency: "EUR", date: "2026-11-15" });
        expect(st.transactions).toEqual([expect.objectContaining({ bookingDate: "2026-11-03", amount: -5400, counterpartyName: "Buchhandlung", remittance: "BUCHHANDLUNG", bankReference: "KK1" })]);
    });

    it("reads DIKKU with its own booking layout and a signed balance", () => {
        const [s] = parseSegments(
            "DIKKU:5:2:3+4111000000001234++D:-312,5:EUR:20261115+++" +
                "4111000000001234:20261103:20261104:R1:::::54,:EUR:D:BUCHHANDLUNG:MUENCHEN::::::::J+" +
                "4111000000001234:20261110:20261110::12,5:USD:D:0,9:11,25:EUR:D:SHOP INC::::::::::N+" +
                "4111000000001234:20261112:20261112::::::20,:EUR:C:GUTSCHRIFT'",
        );
        const st = parseCardStatement(s!);
        expect(st.balance).toEqual({ cents: -31250, currency: "EUR", date: "2026-11-15" });
        expect(st.transactions).toEqual([
            expect.objectContaining({ bookingDate: "2026-11-03", valueDate: "2026-11-04", amount: -5400, currency: "EUR", counterpartyName: "BUCHHANDLUNG", remittance: "BUCHHANDLUNG MUENCHEN", bankReference: "R1" }),
            expect.objectContaining({ bookingDate: "2026-11-10", amount: -1125, currency: "EUR", counterpartyName: "SHOP INC", bankReference: null }),
            expect.objectContaining({ bookingDate: "2026-11-12", amount: 2000, remittance: "GUTSCHRIFT" }),
        ]);
    });
});

describe("splitSepaPurpose", () => {
    it("splits identifiers and keeps unstructured text", () => {
        expect(splitSepaPurpose("EREF+123 KREF+K9 MREF+M1 CRED+DE00ZZZ SVWZ+Miete Mai")).toEqual({
            remittance: "Miete Mai",
            endToEndId: "123",
            customerReference: "K9",
            mandateId: "M1",
            creditorId: "DE00ZZZ",
            ultimate: null,
        });
        expect(splitSepaPurpose("Danke fuer alles")).toMatchObject({ remittance: "Danke fuer alles", endToEndId: null });
    });
});

describe("pain.001", () => {
    it("reads the payment in versions .09 and .03", () => {
        expect(parsePain001(PAIN_SCHEDULED)).toEqual([
            { payeeName: "Handwerker Beispiel", payeeIban: "DE75512108001245126199", payeeBic: "SIMUDEM2XXX", amount: 43120, currency: "EUR", remittance: "Rechnung 4711", endToEndId: null, executionDate: "2026-12-03" },
        ]);
        expect(parsePain001(Buffer.from(PAIN_SAVINGS))[0]).toMatchObject({ payeeName: "Erika Mustermann", payeeBic: "SIMUDEM2XXX", amount: 10050, executionDate: "1999-01-01" });
    });

    it("leaves out what it cannot read", () => {
        expect(parsePain001("<Document><CstmrCdtTrfInitn><PmtInf><CdtTrfTxInf><Amt><InstdAmt>1.234</InstdAmt></Amt></CdtTrfTxInf></PmtInf></CstmrCdtTrfInitn></Document>")).toEqual([]);
        expect(parsePain001("<Other/>")).toEqual([]);
    });
});

describe("pain.001 writing", () => {
    const order: PaymentOrder = {
        messageId: "MBM20261117A",
        createdAt: new Date(2026, 10, 17, 9, 5, 0),
        debtorName: "Erika Mustermann",
        debtorIban: "DE02123456780001234567",
        debtorBic: "SIMUDEM1XXX",
        payeeName: "Müller & Söhne <GmbH>",
        payeeIban: "DE89370400440532013000",
        payeeBic: null,
        amount: 100005,
        remittance: "Rechnung 4711 'Dezember'",
        endToEndId: "MBM-0123456789abcdefghijklmnopqrstu",
        instant: false,
    };

    it("picks the best version the bank offers", () => {
        expect(pickPainFormat(["urn:iso:std:iso:20022:tech:xsd:pain.001.003.03", "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"])).toBe("urn:iso:std:iso:20022:tech:xsd:pain.001.001.09");
        expect(pickPainFormat(["sepade.pain.001.001.03.xsd"])).toBe("sepade.pain.001.001.03.xsd");
        expect(pickPainFormat(["urn:iso:std:iso:20022:tech:xsd:pain.001.001.12"])).toBeNull();
    });

    it.each(["urn:iso:std:iso:20022:tech:xsd:pain.001.001.09", "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03", "urn:iso:std:iso:20022:tech:xsd:pain.001.003.03"])("reads back what it wrote (%s)", (descriptor) => {
        const xml = buildPain001(descriptor, order);
        expect(xml).toContain(`xmlns="${descriptor}"`);
        expect(xml).toContain("&amp;");
        expect(xml).not.toContain("<GmbH>");
        expect(xml).toContain("<CtrlSum>1000.05</CtrlSum>");
        expect(xml).not.toContain("<LclInstrm>");
        expect(xml).not.toContain("<CdtrAgt>");
        expect(parsePain001(xml)).toEqual([
            { payeeName: "Müller & Söhne <GmbH>", payeeIban: "DE89370400440532013000", payeeBic: null, amount: 100005, currency: "EUR", remittance: "Rechnung 4711 'Dezember'", endToEndId: order.endToEndId, executionDate: "1999-01-01" },
        ]);
    });

    it("marks instant transfers and names both banks where known", () => {
        const xml = buildPain001("urn:iso:std:iso:20022:tech:xsd:pain.001.001.09", { ...order, instant: true, payeeBic: "COBADEFFXXX", remittance: "" });
        expect(xml).toContain("<LclInstrm><Cd>INST</Cd></LclInstrm>");
        expect(xml).toContain("<DbtrAgt><FinInstnId><BICFI>SIMUDEM1XXX</BICFI>");
        expect(xml).toContain("<CdtrAgt><FinInstnId><BICFI>COBADEFFXXX</BICFI>");
        expect(xml).not.toContain("<RmtInf>");
        expect(buildPain001("urn:iso:std:iso:20022:tech:xsd:pain.001.001.03", { ...order, debtorBic: null })).toContain("<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>");
    });
});

describe("pain.002 (verification of payee)", () => {
    const report = (tx: string, grp = "PART") =>
        `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.10"><CstmrPmtStsRpt><GrpHdr><MsgId>R1</MsgId></GrpHdr><OrgnlGrpInfAndSts><OrgnlMsgId>M1</OrgnlMsgId><OrgnlMsgNmId>pain.001.001.09</OrgnlMsgNmId><GrpSts>${grp}</GrpSts></OrgnlGrpInfAndSts><OrgnlPmtInfAndSts><OrgnlPmtInfId>P1</OrgnlPmtInfId>${tx}</OrgnlPmtInfAndSts></CstmrPmtStsRpt></Document>`;

    it("reads a close match with the name the payee's bank holds", () => {
        const xml = report(`<TxInfAndSts><OrgnlEndToEndId>E1</OrgnlEndToEndId><TxSts>RVMC</TxSts><OrgnlTxRef><Cdtr><Pty><Nm>Erika Musterfrau</Nm></Pty></Cdtr><CdtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></CdtrAcct></OrgnlTxRef></TxInfAndSts>`);
        expect(parsePain002(xml, "Erika Mustermann")).toEqual({ code: "RVMC", payeeName: "Erika Musterfrau", info: null });
    });

    it("reads no match, not applicable with its reason, and a match only on group level", () => {
        expect(parsePain002(report(`<TxInfAndSts><TxSts>RVNM</TxSts></TxInfAndSts>`), "X").code).toBe("RVNM");
        expect(parsePain002(report(`<TxInfAndSts><TxSts>RVNA</TxSts><StsRsnInf><AddtlInf>Keine Antwort der</AddtlInf><AddtlInf>Empfängerbank</AddtlInf></StsRsnInf></TxInfAndSts>`), "X")).toEqual({ code: "RVNA", payeeName: null, info: "Keine Antwort der Empfängerbank" });
        expect(parsePain002(report("", "RCVC"), "X")).toEqual({ code: "RCVC", payeeName: null, info: null });
        expect(parsePain002(report("", "ACCP"), "X").code).toBeNull();
    });
});
