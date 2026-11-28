import { describe, expect, it } from "vitest";
import { consentDaysLeft, consentText, hasSeveralConsents, LOCALHOST_CALLBACK, loginConsentText, ownCallback, PSD2_COUNTRIES, readRedirect, redirectErrorText } from "./psd2";

const STATE = "a".repeat(32);
const NOW = Date.parse("2026-11-26T10:00:00Z");

describe("readRedirect", () => {
    it("reads code and state from a pasted address or the page's own query", () => {
        expect(readRedirect(`${LOCALHOST_CALLBACK}?state=${STATE}&code=c-1`)).toEqual({ kind: "code", state: STATE, code: "c-1" });
        expect(readRedirect(`  https://mbm.example.org/bank-callback?code=c-2&state=${STATE}  `)).toEqual({ kind: "code", state: STATE, code: "c-2" });
        expect(readRedirect(new URLSearchParams(`state=${STATE}&code=c-3`))).toEqual({ kind: "code", state: STATE, code: "c-3" });
    });

    it("reports the bank's refusal", () => {
        expect(readRedirect(`${LOCALHOST_CALLBACK}?state=${STATE}&error=access_denied&error_description=Cancelled%20by%20user`)).toEqual({ kind: "error", error: "access_denied", description: "Cancelled by user" });
    });

    it("refuses what is no redirect of an approval", () => {
        expect(readRedirect("PayPal")).toEqual({ kind: "invalid" });
        expect(readRedirect(`${LOCALHOST_CALLBACK}?code=c`)).toEqual({ kind: "invalid" });
        expect(readRedirect(`${LOCALHOST_CALLBACK}?state=kurz&code=c`)).toEqual({ kind: "invalid" });
        expect(readRedirect(`${LOCALHOST_CALLBACK}?state=${STATE}`)).toEqual({ kind: "invalid" });
    });
});

describe("redirectErrorText", () => {
    it("names a cancelled approval in words", () => {
        expect(redirectErrorText("access_denied", "Cancelled by user")).toBe("Die Freigabe wurde bei der Bank abgelehnt oder abgebrochen (Cancelled by user).");
        expect(redirectErrorText("server_error", "")).toBe("Die Bank hat die Freigabe nicht erteilt: server_error");
    });
});

describe("consentText", () => {
    it("shows the end, and points it out in the last two weeks", () => {
        expect(consentText(null, NOW)).toBeNull();
        expect(consentText("2027-05-25T10:00:00.000Z", NOW)).toEqual({ text: "Freigabe bis 25.05.2027", attn: false });
        expect(consentText("2026-12-01T12:00:00.000Z", NOW)).toEqual({ text: "Freigabe läuft in 5 Tagen ab (01.12.2026)", attn: true });
        expect(consentText("2026-11-27T12:00:00.000Z", NOW)).toEqual({ text: "Freigabe läuft in einem Tag ab (27.11.2026)", attn: true });
        expect(consentText("2026-11-26T18:00:00.000Z", NOW)).toEqual({ text: "Freigabe läuft heute ab", attn: true });
        expect(consentText("2026-11-26T09:00:00.000Z", NOW)).toEqual({ text: "Freigabe abgelaufen", attn: true });
        expect(consentDaysLeft("2026-12-10T10:00:00.000Z", NOW)).toBe(14);
    });
});

describe("loginConsentText", () => {
    const names = new Map([[6, "PayPal"], [7, "PayPal · Kim"]]);
    const LATE = "2027-05-25T10:00:00.000Z";
    const SOON = "2026-12-01T12:00:00.000Z";

    it("shows the one approval as before", () => {
        expect(loginConsentText({ consentUntil: LATE, accountConsents: [] }, names, NOW)).toEqual({ text: "Freigabe bis 25.05.2027", attn: false });
        expect(loginConsentText({ consentUntil: LATE, accountConsents: [{ accountId: 6, until: LATE }, { accountId: 7, until: LATE }] }, names, NOW)).toEqual({ text: "Freigabe bis 25.05.2027", attn: false });
        expect(hasSeveralConsents({ accountConsents: [{ accountId: 6, until: LATE }, { accountId: 7, until: LATE }] })).toBe(false);
    });

    it("with several approvals names the accounts of the one that ends first", () => {
        const login = { consentUntil: LATE, accountConsents: [{ accountId: 6, until: LATE }, { accountId: 7, until: SOON }] };
        expect(loginConsentText(login, names, NOW)).toEqual({ text: "„PayPal · Kim“: Freigabe läuft in 5 Tagen ab (01.12.2026)", attn: true });
        expect(hasSeveralConsents(login)).toBe(true);
    });
});

describe("ownCallback", () => {
    it("points back to this MBM", () => {
        expect(ownCallback("https://mbm.example.org")).toBe("https://mbm.example.org/bank-callback");
    });
});

describe("PSD2_COUNTRIES", () => {
    it("starts with Germany and has every country once", () => {
        expect(PSD2_COUNTRIES[0]).toEqual({ code: "DE", name: "Deutschland" });
        expect(new Set(PSD2_COUNTRIES.map((c) => c.code)).size).toBe(PSD2_COUNTRIES.length);
    });
});
