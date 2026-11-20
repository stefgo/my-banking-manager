import { describe, expect, it } from "vitest";
import { parseSegments } from "../syntax/parse.js";
import { negotiate, orderIdOf, parseBpd } from "./bpd.js";
import { accountClass, parseUpd, updVersionToAnnounce } from "./upd.js";
import { hktabVersion, parseHitab } from "./tan.js";

// Made-up parameters after the examples in Formals H.2.4.1 and PIN/TAN B.8.1.
const BPD =
    "HIBPA:4:3:4+12+280:10020030+Musterbank in Musterstadt+0+1:2+300+0'" +
    "HIKOM:5:4:4+280:10020030+1+3:banking.example.invalid/fints30::MIM:1'" +
    "HISHV:6:3:4+N+PIN:1+RDH:3:5'" +
    "HIPINS:7:1:4+1+1+0+5:6:6:Kunden-Nr aus dem TAN-Brief::HKCCS:J:HKKAN:N:HKSAL:J'" +
    "HISALS:8:5:4+1+1+0'" +
    "HISALS:9:7:4+1+1+0'" +
    "HISALS:10:6:4+1+1+0'" +
    "HIKAZS:11:7:4+1+1+0+365:J:N'" +
    "DIKKUS:12:2:4+1+1+0+90:J'" +
    "HIRMS:13:2:4+3050::BPD nicht mehr aktuell, aktuelle Version enthalten.'";

describe("parseBpd", () => {
    const bpd = parseBpd(parseSegments(BPD))!;

    it("reads the general bank parameters", () => {
        expect(bpd.version).toBe(12);
        expect(bpd.blz).toBe("10020030");
        expect(bpd.bankName).toBe("Musterbank in Musterstadt");
        expect(bpd.languages).toEqual([1, 2]);
        expect(bpd.hbciVersions).toEqual(["300"]);
        expect(bpd.maxMessageSizeKb).toBeNull();
        expect(bpd.communication).toEqual([{ service: 3, address: "banking.example.invalid/fints30", addressExtra: "", filter: "MIM" }]);
        expect(bpd.securityMethods).toEqual([{ method: "PIN", versions: [1] }, { method: "RDH", versions: [3, 5] }]);
    });

    it("reads HIPINS", () => {
        expect(bpd.pinTan).toEqual({
            minPinLength: 5,
            maxPinLength: 6,
            maxTanLength: 6,
            userIdLabel: "Kunden-Nr aus dem TAN-Brief",
            customerIdLabel: "",
            tanRequired: { HKCCS: true, HKKAN: false, HKSAL: true },
        });
    });

    it("collects every version of a job, sorted, and maps DI…S to DK…", () => {
        expect(bpd.jobs.HKSAL?.map((j) => j.version)).toEqual([5, 6, 7]);
        expect(bpd.jobs.HKKAZ?.[0]?.params).toEqual([["365", "J", "N"]]);
        expect(bpd.jobs.DKKKU?.[0]?.version).toBe(2);
        expect(bpd.jobs.HKRMS).toBeUndefined();
        expect(orderIdOf("HIRMS")).toBeNull();
        expect(orderIdOf("HITANS")).toBe("HKTAN");
    });

    it("negotiates the highest common version", () => {
        expect(negotiate(bpd, "HKSAL", [5, 6])?.version).toBe(6);
        expect(negotiate(bpd, "HKSAL", [8])).toBeNull();
        expect(negotiate(bpd, "HKCAZ", [1])).toBeNull();
    });

    it("reads parameter segments without a security class and skips unreadable ones", () => {
        // As sent by a Sparkasse: DITLFS and HIWPDS have no security class.
        const odd = parseBpd(
            parseSegments(
                "HIBPA:4:3:4+12+280:10020030+Musterbank+0+1+300+0'" +
                    "DITLFS:5:2:4+1+1+N'" +
                    "HIWPDS:6:5:4+1+1+J:N:N'" +
                    "HIXYZS:7:1:4+X+1+0'" +
                    "HISALS:8:7:4+1+1+0'",
            ),
        )!;
        expect(odd.jobs.DKTLF?.[0]).toMatchObject({ maxJobs: 1, minSignatures: 1, securityClass: 0, params: [["N"]] });
        expect(odd.jobs.HKWPD?.[0]?.params).toEqual([["J", "N", "N"]]);
        expect(odd.jobs.HKXYZ).toBeUndefined();
        expect(odd.jobs.HKSAL?.[0]?.version).toBe(7);
    });

    it("returns null without HIBPA", () => {
        expect(parseBpd(parseSegments("HIRMG:2:2+0010::ok'"))).toBeNull();
    });
});

describe("parseUpd", () => {
    const UPD =
        "HIUPA:4:4:4+test1+3+0+Erika Mustermann'" +
        "HIUPD:5:6:4+1234567::280:10020030+DE02 1002 0030 0001 2345 67+test1+1+EUR+Erika Mustermann++Girokonto+T:2000,:EUR+HKSAL:1+HKKAZ:1+HKCCS:1:E:1000,:EUR+{\"umsltzt\"?:\"J\"}'" +
        "HIUPD:6:6:4+4111::280:10020030++test1+50+EUR+Erika Mustermann++Kreditkarte++DKKKU:1'" +
        "HIUPD:7:6:4++++++Online-Banking-Freischaltung'";

    const upd = parseUpd(parseSegments(UPD))!;

    it("reads user and accounts", () => {
        expect(upd.userId).toBe("test1");
        expect(upd.version).toBe(3);
        expect(upd.unlistedBlocked).toBe(true);
        expect(upd.accounts).toHaveLength(3);
        const [giro, card, other] = upd.accounts;
        expect(giro?.account).toEqual({ number: "1234567", subAccount: "", blz: "10020030" });
        expect(giro?.iban).toBe("DE02100200300001234567");
        expect(giro?.kontoart).toBe(1);
        expect(giro?.limit).toEqual({ kind: "T", cents: 200000, currency: "EUR", days: null });
        expect(giro?.allowedJobs.map((j) => j.id)).toEqual(["HKSAL", "HKKAZ", "HKCCS"]);
        expect(giro?.allowedJobs[2]?.limit).toEqual({ kind: "E", cents: 100000, currency: "EUR", days: null });
        expect(giro?.extension).toBe('{"umsltzt":"J"}');
        expect(card?.iban).toBe("");
        expect(accountClass(card?.kontoart ?? null)).toBe("credit_card");
        expect(card?.allowedJobs.map((j) => j.id)).toEqual(["DKKKU"]);
        expect(other?.account).toBeNull();
    });

    it("maps Kontoart ranges", () => {
        expect([1, 10, 25, 30, 45, 55, 60, 70, 85, 99, null].map(accountClass)).toEqual([
            "giro", "savings", "fixed_deposit", "depot", "loan", "credit_card", "fund", "building_savings", "insurance", "other", "other",
        ]);
    });
});

describe("TAN media", () => {
    const bpdWith = (versions: number[]) => parseBpd(parseSegments("HIBPA:4:3:4+12+280:10020030+Musterbank+0+1+300+0'" + versions.map((v, i) => `HITABS:${5 + i}:${v}:4+1+1+0'`).join("")));

    it("picks the highest HKTAB version we know", () => {
        expect(hktabVersion(bpdWith([2, 3, 4]))).toBe(4);
        expect(hktabVersion(bpdWith([4, 5]))).toBe(5);
        expect(hktabVersion(bpdWith([2, 3]))).toBeNull();
        expect(hktabVersion(null)).toBeNull();
    });

    it("reads the medium name from HITAB v4 and v5", () => {
        // v4: Klasse, Status, Kartennummer, Folgenummer, Kartenart, Konto (4), gültig ab/bis, Listennummer, Bezeichnung
        const [v4] = parseSegments("HITAB:4:4:3+0+M:1:::::::::::Mein Telefon'");
        // v5 adds the Sicherheitsfunktion after the status
        const [v5] = parseSegments("HITAB:4:5:3+0+M:1::::::::::::Mein Telefon+G:2::::::::::::Generator'");
        expect(parseHitab(v4!)).toEqual([{ kind: "M", status: "1", name: "Mein Telefon" }]);
        expect(parseHitab(v5!).map((m) => m.name)).toEqual(["Mein Telefon", "Generator"]);
    });
});

describe("updVersionToAnnounce", () => {
    it("announces the version only if the UPD has accounts", () => {
        const full = parseUpd(parseSegments("HIUPA:4:4:3+user+7+0+Erika'HIUPD:5:6:3+1234567::280:10020030+DE02100200301234567+user+1+EUR+Erika++Girokonto'"));
        // As a Sparkasse sends it in the dialog without strong authentication
        const reduced = parseUpd(parseSegments("HIUPA:4:4:3+user+7+0+Erika'HIUPD:5:6:3++++++++Online-Banking'"));
        expect(updVersionToAnnounce(full)).toBe(7);
        expect(updVersionToAnnounce(reduced)).toBe(0);
        expect(updVersionToAnnounce(null)).toBe(0);
    });
});
