import { describe, expect, it } from "vitest";
import { CompleteConsentRequest, Psd2BankSearchRequest, SetPsd2LoginRequest, StartConsentRequest } from "./schemas/bankaccess.js";
import { Psd2ConsentRequest, Psd2Credentials, Psd2TransactionsData } from "./schemas/connector.js";

const APP_ID = "0b3c7a52-6f1e-4c2a-9d8e-1f2a3b4c5d6e";
const KEY = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(120)}\n-----END PRIVATE KEY-----`;

describe("PSD2 schemas", () => {
    it("takes an application ID as UUID and a key in PEM form", () => {
        expect(Psd2Credentials.safeParse({ applicationId: APP_ID, privateKey: KEY }).success).toBe(true);
        expect(Psd2Credentials.safeParse({ applicationId: "not-an-id", privateKey: KEY }).success).toBe(false);
        expect(Psd2Credentials.safeParse({ applicationId: APP_ID, privateKey: "short" }).success).toBe(false);
    });

    it("wants either credentials or an own login, never both or none", () => {
        const credentials = { applicationId: APP_ID, privateKey: KEY };
        expect(Psd2BankSearchRequest.safeParse({ country: "DE", credentials }).success).toBe(true);
        expect(Psd2BankSearchRequest.safeParse({ country: "DE", fromConnection: 3 }).success).toBe(true);
        expect(Psd2BankSearchRequest.safeParse({ country: "DE" }).success).toBe(false);
        expect(Psd2BankSearchRequest.safeParse({ country: "DE", credentials, fromConnection: 3 }).success).toBe(false);
        expect(Psd2BankSearchRequest.safeParse({ country: "de", fromConnection: 3 }).success).toBe(false);
        expect(SetPsd2LoginRequest.safeParse({ fromConnection: 2 }).success).toBe(true);
        expect(SetPsd2LoginRequest.safeParse({}).success).toBe(false);
    });

    it("accepts only web addresses as redirect", () => {
        expect(StartConsentRequest.safeParse({ redirectUrl: "https://mbm.example.org/bank-callback" }).success).toBe(true);
        expect(StartConsentRequest.safeParse({ redirectUrl: "http://localhost:5173/bank-callback" }).success).toBe(true);
        expect(StartConsentRequest.safeParse({ redirectUrl: "javascript:alert(1)" }).success).toBe(false);
        expect(StartConsentRequest.safeParse({ redirectUrl: "ftp://example.org/x" }).success).toBe(false);
    });

    it("checks the state that comes back with the redirect", () => {
        expect(CompleteConsentRequest.safeParse({ state: "a".repeat(32), code: "c" }).success).toBe(true);
        expect(CompleteConsentRequest.safeParse({ state: "short", code: "c" }).success).toBe(false);
        expect(CompleteConsentRequest.safeParse({ state: "a".repeat(31) + "/", code: "c" }).success).toBe(false);
    });

    it("asks for a personal approval unless told otherwise", () => {
        const r = Psd2ConsentRequest.parse({ bank: { aspsp: "PayPal", country: "DE" }, login: { applicationId: APP_ID, privateKey: KEY }, redirectUrl: "https://localhost/bank-callback", state: "s".repeat(32) });
        expect(r.psuType).toBe("personal");
    });

    it("counts no left-out bookings when the connector says nothing", () => {
        expect(Psd2TransactionsData.parse({ transactions: [] }).foreignCurrency).toBe(0);
    });
});
