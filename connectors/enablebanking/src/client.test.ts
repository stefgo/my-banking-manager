import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient, EnableBankingError } from "./client.js";

const credentials = { applicationId: "app-id", privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey };

function fakeFetch(status: number, body: string, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
    return (async (url: URL | string | Request, init?: RequestInit) => {
        seen.push({ url: String(url), ...(init ? { init } : {}) });
        return new Response(body, { status });
    }) as typeof fetch;
}

describe("createClient", () => {
    it("sends a fresh token, refuses redirects and builds the query", async () => {
        const seen: { url?: string; init?: RequestInit }[] = [];
        const client = createClient(credentials, { fetch: fakeFetch(200, '{"aspsps":[]}', seen) });
        expect(await client.get("/aspsps", { country: "DE", psu_type: undefined })).toEqual({ aspsps: [] });
        expect(seen[0]!.url).toBe("https://api.enablebanking.com/aspsps?country=DE");
        expect(seen[0]!.init!.redirect).toBe("error");
        expect((seen[0]!.init!.headers as Record<string, string>).authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    });

    it("sends JSON bodies", async () => {
        const seen: { url?: string; init?: RequestInit }[] = [];
        const client = createClient(credentials, { fetch: fakeFetch(200, '{"session_id":"s"}', seen) });
        await client.post("/sessions", { code: "c" });
        expect(seen[0]!.init!.method).toBe("POST");
        expect(seen[0]!.init!.body).toBe('{"code":"c"}');
        expect((seen[0]!.init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    });

    it("turns error answers into their code", async () => {
        const client = createClient(credentials, { fetch: fakeFetch(401, '{"message":"Session is expired","code":401,"error":"EXPIRED_SESSION"}') });
        await expect(client.get("/accounts/x/balances")).rejects.toMatchObject({ status: 401, code: "EXPIRED_SESSION" });
    });

    it("names the HTTP status when the error has no code", async () => {
        const client = createClient(credentials, { fetch: fakeFetch(502, "<html>") });
        await expect(client.get("/aspsps")).rejects.toMatchObject({ status: 502, code: "HTTP_502" });
    });

    it("reports a call without answer in time as timeout", async () => {
        const client = createClient(credentials, {
            fetch: (async () => {
                throw new DOMException("The operation timed out.", "TimeoutError");
            }) as typeof fetch,
        });
        await expect(client.get("/aspsps")).rejects.toMatchObject({ status: 0, code: "TIMEOUT" });
    });

    it("reports a network failure as unreachable", async () => {
        const client = createClient(credentials, {
            fetch: (async () => {
                throw new TypeError("fetch failed");
            }) as typeof fetch,
        });
        await expect(client.get("/aspsps")).rejects.toBeInstanceOf(EnableBankingError);
        await expect(client.get("/aspsps")).rejects.toMatchObject({ status: 0, code: "UNREACHABLE" });
    });
});
