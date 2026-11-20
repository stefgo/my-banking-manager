import { afterEach, describe, expect, it } from "vitest";
import { originAllowed } from "./http/origin.js";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";

let t: TestApp | undefined;

afterEach(async () => {
    await t?.close();
    t = undefined;
});

describe("originAllowed", () => {
    it("lets requests without Origin and from the own host pass", () => {
        expect(originAllowed(undefined, "mbm.home.example", [])).toBe(true);
        expect(originAllowed("https://mbm.home.example", "mbm.home.example", [])).toBe(true);
        expect(originAllowed("https://mbm.home.example", "mbm.home.example:443", [])).toBe(true);
        expect(originAllowed("http://192.168.1.10:3040", "192.168.1.10:3040", [])).toBe(true);
        expect(originAllowed("https://MBM.home.example", "mbm.home.example", [])).toBe(true);
    });

    it("refuses other subdomains, other ports of the same host and unreadable origins", () => {
        expect(originAllowed("https://wiki.home.example", "mbm.home.example", [])).toBe(false);
        expect(originAllowed("http://192.168.1.10:8123", "192.168.1.10:3040", [])).toBe(false);
        expect(originAllowed("http://localhost:5173", "localhost:3040", [])).toBe(false);
        expect(originAllowed("null", "mbm.home.example", [])).toBe(false);
        expect(originAllowed("file:///tmp/x.html", "mbm.home.example", [])).toBe(false);
        expect(originAllowed("https://mbm.home.example", "", [])).toBe(false);
    });

    it("lets configured origins pass", () => {
        expect(originAllowed("https://mbm.example.org", "localhost:3040", ["https://mbm.example.org"])).toBe(true);
        expect(originAllowed("https://mbm.example.org:8443", "localhost:3040", ["https://mbm.example.org"])).toBe(false);
    });
});

describe("origin check of the server", () => {
    // app.inject sends "Host: localhost:80"
    const lock = (origin?: string, headers: Record<string, string> = {}) => ({
        method: "POST" as const,
        url: "/api/lock",
        headers: { ...headers, ...(origin ? { origin } : {}) },
    });

    it("refuses a change from another page, but not a read", async () => {
        t = await createTestApp();
        const { session } = await setUpSignedIn(t);
        const foreign = await t.app.inject(lock("http://localhost:8080", { cookie: session }));
        expect(foreign.statusCode).toBe(403);
        expect(foreign.json()).toMatchObject({ error: "foreign_origin" });
        expect(t.vault.state()).toBe("ready");
        const read = await t.app.inject({ url: "/api/accounts", headers: { cookie: session, origin: "http://localhost:8080" } });
        expect(read.statusCode).toBe(200);
        expect((await t.app.inject(lock("http://localhost", { cookie: session }))).statusCode).toBe(200);
        expect(t.vault.state()).toBe("locked");
    });

    it("lets requests without Origin pass (device token, scripts)", async () => {
        t = await createTestApp();
        const { session } = await setUpSignedIn(t);
        expect((await t.app.inject(lock(undefined, { cookie: session }))).statusCode).toBe(200);
    });

    it("refuses the event WebSocket for another page", async () => {
        t = await createTestApp();
        const { session } = await setUpSignedIn(t);
        // injectWS sends no Host header of its own; a browser always does
        await expect(t.app.injectWS("/api/events", { headers: { host: "localhost", cookie: session, origin: "http://localhost:8080" } })).rejects.toThrow(/403/);
        const ws = await t.app.injectWS("/api/events", { headers: { host: "localhost", cookie: session, origin: "http://localhost" } });
        expect(t.ctx.events.size).toBe(1);
        ws.terminate();
    });

    it("takes the own address from X-Forwarded-Host only behind a trusted proxy", async () => {
        t = await createTestApp({ trustProxy: true });
        const { session } = await setUpSignedIn(t);
        const viaProxy = await t.app.inject(lock("https://mbm.home.example", { cookie: session, "x-forwarded-host": "mbm.home.example", "x-forwarded-proto": "https" }));
        expect(viaProxy.statusCode).toBe(200);
        await t.close();

        t = await createTestApp();
        const s2 = (await setUpSignedIn(t)).session;
        const spoofed = await t.app.inject(lock("https://mbm.home.example", { cookie: s2, "x-forwarded-host": "mbm.home.example" }));
        expect(spoofed.statusCode).toBe(403);
    });

    it("lets configured origins pass", async () => {
        t = await createTestApp({ allowedOrigins: ["https://mbm.example.org"] });
        const { session } = await setUpSignedIn(t);
        expect((await t.app.inject(lock("https://mbm.example.org", { cookie: session }))).statusCode).toBe(200);
    });
});
