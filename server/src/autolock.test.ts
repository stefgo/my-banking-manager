import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";

const MINUTE = 60_000;
const PASSWORD = "sehr-geheimes-passwort";

let t: TestApp;
let now: number;

beforeEach(async () => {
    t = await createTestApp({ sessionIdleMinutes: 10, autoLockMinutes: 10 });
    now = Date.now();
    t.ctx.autoLock.clock = () => now;
});
afterEach(async () => {
    await t.close();
});

/** Lets pending socket events (messages, pongs, close) arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function connect(cookie: string) {
    const ws = await t.app.injectWS("/api/events", { headers: { cookie } });
    const messages: unknown[] = [];
    let closeCode: number | null = null;
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    ws.on("close", (code) => (closeCode = code));
    return { ws, messages, closed: () => closeCode };
}

const active = async (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "active" }));
    await settle();
};

describe("session lock after inactivity", () => {
    it("locks a browser session without input and opens it with the password", async () => {
        const { api } = await setUpSignedIn(t);
        expect((await api("GET", "/api/accounts")).status).toBe(200);
        now += 11 * MINUTE + 1;
        const refused = await api<{ error: string }>("GET", "/api/accounts");
        expect(refused).toMatchObject({ status: 423, body: { error: "session_locked" } });
        expect((await api("GET", "/api/auth/me")).body).toMatchObject({ name: "Anna", sessionLocked: true, sessionIdleMinutes: 10 });

        expect((await api("POST", "/api/auth/login", { name: "Anna", password: "falsch-falsch" })).status).toBe(401);
        expect((await api("POST", "/api/auth/login", { name: "Anna", password: PASSWORD })).body).toMatchObject({ status: "ok" });
        expect((await api("GET", "/api/accounts")).status).toBe(200);
        expect((await api("GET", "/api/auth/me")).body).toMatchObject({ sessionLocked: false });
    });

    it("signs the session out after five wrong passwords", async () => {
        const { api } = await setUpSignedIn(t);
        expect((await api("POST", "/api/auth/session/lock")).status).toBe(200);
        for (let i = 1; i <= 4; i++) {
            expect((await api<{ error: string }>("POST", "/api/auth/login", { name: "Anna", password: "falsch-falsch" })).body.error).toBe("wrong_login");
        }
        const last = await api<{ error: string }>("POST", "/api/auth/login", { name: "Anna", password: "falsch-falsch" });
        expect(last).toMatchObject({ status: 401, body: { error: "signed_out" } });
        expect((await api("GET", "/api/auth/me")).status).toBe(401);
    });

    it("keeps a session open while its window reports input, locks it when the input stops", async () => {
        const { session } = await setUpSignedIn(t);
        const client = await connect(session);
        for (let i = 0; i < 3; i++) {
            now += 8 * MINUTE;
            await active(client.ws);
            t.ctx.autoLock.tick();
            await settle();
        }
        expect(client.closed()).toBeNull();

        now += 12 * MINUTE;
        t.ctx.autoLock.tick();
        await settle();
        expect(client.messages).toContainEqual({ type: "session_locked" });
        expect(client.closed()).toBe(4403);
        // A locked session cannot connect again
        const again = await connect(session);
        await settle();
        expect(again.closed()).toBe(4403);
    });

    it("does not lock sessions when the time is 0", async () => {
        await t.close();
        t = await createTestApp({ sessionIdleMinutes: 0 });
        t.ctx.autoLock.clock = () => now;
        const { api } = await setUpSignedIn(t);
        expect((await api("GET", "/api/accounts")).status).toBe(200);
        now += 600 * MINUTE;
        expect((await api("GET", "/api/accounts")).status).toBe(200);
    });
});

describe("server lock without active session", () => {
    it("stays unlocked while a window is open and locks after the last one closed", async () => {
        const { session } = await setUpSignedIn(t);
        const client = await connect(session);
        await settle();
        t.ctx.autoLock.tick();
        for (let i = 0; i < 4; i++) {
            now += 5 * MINUTE;
            await active(client.ws);
            t.ctx.autoLock.tick();
            await settle();
        }
        expect(t.vault.state()).toBe("ready");

        client.ws.terminate(); // the test socket finishes no close handshake; a closed tab ends like this
        await settle();
        expect(t.ctx.events.size).toBe(0);
        now += 9 * MINUTE;
        t.ctx.autoLock.tick();
        expect(t.vault.state()).toBe("ready");
        now += 2 * MINUTE;
        t.ctx.autoLock.tick();
        expect(t.vault.state()).toBe("locked");
    });

    it("counts a session locked after inactivity as not active", async () => {
        const { session } = await setUpSignedIn(t);
        const client = await connect(session);
        await settle();
        now += 12 * MINUTE;
        t.ctx.autoLock.tick(); // locks the session, the server's time starts
        await settle();
        expect(client.closed()).toBe(4403);
        now += 10 * MINUTE;
        t.ctx.autoLock.tick();
        expect(t.vault.state()).toBe("locked");
    });

    it("drops a connection that answers neither pings nor sends anything", async () => {
        const { session } = await setUpSignedIn(t);
        const client = await connect(session);
        await settle();
        // The client stops answering, as after closing the laptop lid
        client.ws.pong = () => undefined;
        t.ctx.autoLock.tick();
        t.ctx.autoLock.tick();
        expect(t.ctx.events.size).toBe(1);
        t.ctx.autoLock.tick();
        expect(t.ctx.events.size).toBe(0);
    });

    it("locks the server again when the window that unlocked it does not connect", async () => {
        const { session } = await setUpSignedIn(t);
        t.ctx.autoLock.tick();
        now += 10 * MINUTE;
        t.ctx.autoLock.tick();
        expect(t.vault.state()).toBe("locked");
        const back = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { name: "Anna", password: PASSWORD }, headers: { cookie: session } });
        expect(back.statusCode).toBe(200);
        t.ctx.autoLock.tick();
        now += 9 * MINUTE;
        t.ctx.autoLock.tick();
        expect(t.vault.state()).toBe("ready");
        now += 2 * MINUTE;
        t.ctx.autoLock.tick();
        expect(t.vault.state()).toBe("locked");
    });
});
