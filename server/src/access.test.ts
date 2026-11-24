import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "./crypto/secrets.js";
import { confirmCode, createTestApp, nextCode, setUpSignedIn, signInCreatedUser, type TestApp } from "./testing/testApp.js";

const PASSWORD = "sehr-geheimes-passwort";
const NEXT = "ein-neues-langes-passwort";
const BEN_PASSWORD = "noch-ein-passwort";

let t: TestApp;

beforeEach(async () => {
    t = await createTestApp();
});
afterEach(async () => {
    await t.close();
});

const db = () => t.vault.database;
const post = (url: string, payload: object, cookie?: string) => t.app.inject({ method: "POST", url, payload, headers: cookie ? { cookie } : {} });
const sealedKey = (id = 1) => (db().prepare("SELECT sealed_user_key AS k FROM users WHERE id = ?").get(id) as { k: string | null }).k;
const totpSecret = (id = 1) => (db().prepare("SELECT totp_secret AS s FROM users WHERE id = ?").get(id) as { s: string | null }).s;
const activeDevices = (id = 1) => (db().prepare("SELECT count(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL").get(id) as { n: number }).n;
const actions = () => (db().prepare("SELECT action, details FROM activity_log ORDER BY id").all() as { action: string; details: string | null }[]);

/** A code of the secret that the server has not seen as used, also right after another one. */
const freshCode = (secret: string) => {
    db().prepare("UPDATE users SET totp_last_step = NULL").run();
    return totpCode(secret, totpStep());
};

async function addBen(api: Awaited<ReturnType<typeof setUpSignedIn>>["api"], secret: string) {
    const res = await api<{ id: number }>("POST", "/api/users", { name: "Ben", password: BEN_PASSWORD, code: confirmCode(t, secret) });
    expect(res.status).toBe(200);
    const ben = await signInCreatedUser(t, "Ben", BEN_PASSWORD);
    return { id: res.body.id, ...ben };
}

describe("own password", () => {
    it("is not reset through the user list, so the bank logins cannot get lost that way", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const before = sealedKey();
        expect(await api("POST", "/api/users/1/password", { password: NEXT, code: confirmCode(t, secret) })).toMatchObject({ status: 409, body: { error: "self" } });
        expect(sealedKey()).toBe(before);
        expect(await t.vault.checkPassword(1, PASSWORD)).toBe(true);
    });

    it("needs the current password and the code, and a wrong password does not use up the code", async () => {
        const { api, secret } = await setUpSignedIn(t);
        expect((await api("POST", "/api/auth/password", { current: PASSWORD, next: NEXT })).status).toBe(400);
        const code = confirmCode(t, secret);
        expect(await api("POST", "/api/auth/password", { current: "falsch-falsch", next: NEXT, code })).toMatchObject({ status: 401, body: { error: "wrong_password" } });
        expect((await api("POST", "/api/auth/password", { current: PASSWORD, next: NEXT, code })).status).toBe(200);
        expect(await t.vault.checkPassword(1, NEXT)).toBe(true);
    });

    it("keeps the user key when the server locks right after the new password was written", async () => {
        const { api, secret, session } = await setUpSignedIn(t);
        const original = t.vault.setUserPassword.bind(t.vault);
        t.vault.setUserPassword = (async (...args: Parameters<typeof original>) => {
            const user = await original(...args);
            t.vault.lock();
            return user;
        }) as typeof t.vault.setUserPassword;
        expect((await api("POST", "/api/auth/password", { current: PASSWORD, next: NEXT, code: confirmCode(t, secret) })).status).toBe(200);
        t.vault.setUserPassword = original;
        expect((await post("/api/auth/login", { name: "Anna", password: NEXT }, session)).json()).toMatchObject({ status: "ok" });
        const after = sealedKey();
        // A further sign-in opens the same wrapping: the key was not replaced
        expect((await post("/api/auth/login", { name: "Anna", password: NEXT }, session)).json()).toMatchObject({ status: "ok" });
        expect(sealedKey()).toBe(after);
        expect(actions().some((a) => a.action === "password_changed")).toBe(true);
    });
});

describe("own second factor", () => {
    it("is not reset through the user list", async () => {
        const { api } = await setUpSignedIn(t);
        expect(await api("POST", "/api/users/1/reset-totp", { password: PASSWORD })).toMatchObject({ status: 409, body: { error: "self" } });
        expect(totpSecret()).not.toBeNull();
        expect((await api("GET", "/api/auth/me")).status).toBe(200);
    });

    it("cannot be changed with the password alone", async () => {
        const { api } = await setUpSignedIn(t);
        expect((await api("POST", "/api/auth/totp/change", { password: PASSWORD })).status).toBe(400);
    });

    it("changes with password and code, keeps this session and ends the others", async () => {
        const { api, secret } = await setUpSignedIn(t);
        expect((await post("/api/auth/login", { name: "Anna", password: PASSWORD, code: confirmCode(t, secret) })).json()).toMatchObject({ status: "ok" });
        expect(activeDevices()).toBe(2);
        const key = sealedKey();
        const started = await api<{ setupToken: string; secret: string }>("POST", "/api/auth/totp/change", { password: PASSWORD, code: freshCode(secret) });
        expect(started.status).toBe(200);
        expect((await api("POST", "/api/auth/totp/change/confirm", { setupToken: started.body.setupToken, code: nextCode(started.body.secret) })).status).toBe(200);
        expect((await api("GET", "/api/auth/me")).status).toBe(200);
        expect(activeDevices()).toBe(1);
        expect(sealedKey()).toBe(key);
        expect(actions().at(-1)).toMatchObject({ action: "totp_changed" });
        // The new secret counts from now on
        expect((await api("POST", "/api/devices", { name: "Mac", code: freshCode(started.body.secret) })).status).toBe(200);
    });

    it("changes with password and recovery key when the phone is gone, and counts a wrong key", async () => {
        const { api, recoveryKey } = await setUpSignedIn(t);
        expect(await api("POST", "/api/auth/totp/change", { password: PASSWORD, recoveryKey: "AAAA-BBBB" })).toMatchObject({ status: 401, body: { error: "wrong_recovery_key" } });
        expect(actions().at(-1)).toMatchObject({ action: "reauth_failed" });
        const started = await api<{ setupToken: string; secret: string }>("POST", "/api/auth/totp/change", { password: PASSWORD, recoveryKey });
        expect(started.status).toBe(200);
        expect((await api("POST", "/api/auth/totp/change/confirm", { setupToken: started.body.setupToken, code: nextCode(started.body.secret) })).status).toBe(200);
    });

    it("stays the old one until the new one is confirmed", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const before = totpSecret();
        const started = await api<{ setupToken: string; secret: string }>("POST", "/api/auth/totp/change", { password: PASSWORD, code: confirmCode(t, secret) });
        expect(started.status).toBe(200);
        expect((await api("POST", "/api/auth/totp/change/confirm", { setupToken: started.body.setupToken, code: "000000" })).status).toBe(401);
        expect(totpSecret()).toBe(before);
        expect((await api("POST", "/api/devices", { name: "Mac", code: freshCode(secret) })).status).toBe(200);
    });

    it("is confirmed only in the session that started it, and is no way to sign in", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const started = await api<{ setupToken: string; secret: string }>("POST", "/api/auth/totp/change", { password: PASSWORD, code: confirmCode(t, secret) });
        const code = nextCode(started.body.secret);
        expect((await post("/api/auth/totp", { setupToken: started.body.setupToken, code })).json()).toMatchObject({ error: "setup_expired" });
        const other = await post("/api/auth/login", { name: "Anna", password: PASSWORD, code: freshCode(secret) });
        const cookie = String(other.headers["set-cookie"]).split(";")[0]!;
        expect((await post("/api/auth/totp/change/confirm", { setupToken: started.body.setupToken, code }, cookie)).json()).toMatchObject({ error: "setup_expired" });
    });
});

describe("other users", () => {
    it("get their password reset, which drops their user key and ends their sessions", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const ben = await addBen(api, secret);
        expect(sealedKey(ben.id)).not.toBeNull();
        expect((await api("POST", `/api/users/${ben.id}/password`, { password: "bens-neues-passwort", code: confirmCode(t, secret) })).status).toBe(200);
        expect(sealedKey(ben.id)).toBeNull();
        expect(activeDevices(ben.id)).toBe(0);
        expect(activeDevices(1)).toBe(1);
    });

    it("get their second factor reset with the own password, and their user key stays", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const ben = await addBen(api, secret);
        const key = sealedKey(ben.id);
        expect((await api("POST", `/api/users/${ben.id}/reset-totp`, { password: PASSWORD })).status).toBe(200);
        expect(totpSecret(ben.id)).toBeNull();
        expect(sealedKey(ben.id)).toBe(key);
        expect((await api("GET", "/api/auth/me")).status).toBe(200);
    });
});

describe("new recovery key", () => {
    it("needs the password and the code", async () => {
        const { api, secret } = await setUpSignedIn(t);
        expect((await api("POST", "/api/system/recovery-key", { password: PASSWORD })).status).toBe(400);
        const code = confirmCode(t, secret);
        expect((await api("POST", "/api/system/recovery-key", { password: "falsch-falsch", code })).status).toBe(401);
        expect((await api("POST", "/api/system/recovery-key", { password: PASSWORD, code })).status).toBe(200);
    });
});

describe("way back in at the sign-in screen", () => {
    it("phone lost: password and recovery key set up a new factor, and the bank logins stay", async () => {
        const { api, secret, recoveryKey } = await setUpSignedIn(t);
        const key = sealedKey();
        const before = totpSecret();
        t.vault.lock();
        const res = await post("/api/recover/totp", { recoveryKey, name: "Anna", password: PASSWORD });
        expect(res.statusCode).toBe(200);
        const setup = res.json() as { setupToken: string; secret: string };
        // Giving up here changes nothing: the old app still works
        expect(totpSecret()).toBe(before);
        expect((await post("/api/auth/login", { name: "Anna", password: PASSWORD, code: freshCode(secret) })).json()).toMatchObject({ status: "ok" });
        const confirmed = await post("/api/auth/totp", { setupToken: setup.setupToken, code: nextCode(setup.secret) });
        expect(confirmed.json()).toMatchObject({ status: "ok" });
        expect(sealedKey()).toBe(key);
        expect(totpSecret()).not.toBe(before);
        // Old sessions are gone, the new one remains
        expect((await api("GET", "/api/auth/me")).status).toBe(401);
        expect(activeDevices()).toBe(1);
        expect(actions().some((a) => a.action === "totp_changed" && a.details === "mit Wiederherstellungsschlüssel")).toBe(true);
    });

    it("phone lost: a wrong password or key gets one answer and leaves a locked server locked", async () => {
        const { recoveryKey } = await setUpSignedIn(t);
        t.vault.lock();
        const wrongPassword = await post("/api/recover/totp", { recoveryKey, name: "Anna", password: "falsch-falsch" });
        const wrongKey = await post("/api/recover/totp", { recoveryKey: "AAAA-BBBB", name: "Anna", password: PASSWORD });
        expect(wrongPassword.statusCode).toBe(401);
        expect(wrongKey.json()).toEqual(wrongPassword.json());
        expect(t.vault.state()).toBe("locked");
    });

    it("throttles wrong recovery keys", async () => {
        await setUpSignedIn(t);
        for (let i = 0; i < 5; i++) expect((await post("/api/recover/totp", { recoveryKey: "AAAA-BBBB", name: "Anna", password: PASSWORD })).statusCode).toBe(401);
        expect((await post("/api/recover/totp", { recoveryKey: "AAAA-BBBB", name: "Anna", password: PASSWORD })).statusCode).toBe(429);
    });

    it("password and phone lost: the only user gets back in with the recovery key alone", async () => {
        const { recoveryKey } = await setUpSignedIn(t);
        t.vault.lock();
        const res = await post("/api/recover", { recoveryKey, name: "Anna", password: NEXT, resetTotp: true });
        expect(res.statusCode).toBe(200);
        const { totp } = res.json() as { totp: { setupToken: string; secret: string } };
        expect((await post("/api/auth/totp", { setupToken: totp.setupToken, code: nextCode(totp.secret) })).json()).toMatchObject({ status: "ok" });
        expect(activeDevices()).toBe(1);
    });

    it("password lost: without `resetTotp` the old second factor stays required", async () => {
        const { recoveryKey } = await setUpSignedIn(t);
        const res = await post("/api/recover", { recoveryKey, name: "Anna", password: NEXT });
        expect(res.json()).toEqual({ ok: true });
        expect((await post("/api/auth/login", { name: "Anna", password: NEXT })).json()).toMatchObject({ status: "code_required" });
    });
});
