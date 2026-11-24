import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "./crypto/secrets.js";
import { confirmCode, createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";

let t: TestApp;

beforeEach(async () => {
    t = await createTestApp();
});
afterEach(async () => {
    await t.close();
});

const PASSWORD = "sehr-geheimes-passwort";
const BEN_PASSWORD = "noch-ein-passwort";

type Api = Awaited<ReturnType<typeof setUpSignedIn>>["api"];

/** Six digits that are none of the codes the server accepts right now. */
function wrongCode(secret: string): string {
    const valid = new Set([-1, 0, 1].map((o) => totpCode(secret, totpStep() + o)));
    for (let n = 0; ; n++) {
        const code = String(n).padStart(6, "0");
        if (!valid.has(code)) return code;
    }
}

const db = () => t.vault.database;
const activeDevices = () => (db().prepare("SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL").get() as { n: number }).n;
const userNames = async (api: Api) => (await api<{ name: string }[]>("GET", "/api/users")).body.map((u) => u.name);
const totpActive = (userId: number) => (db().prepare("SELECT totp_secret FROM users WHERE id = ?").get(userId) as { totp_secret: string | null }).totp_secret !== null;
const actions = () => (db().prepare("SELECT action, target, details FROM activity_log ORDER BY id").all() as { action: string; target: string | null; details: string | null }[]);

async function addBen(api: Api, secret: string): Promise<number> {
    const res = await api<{ id: number }>("POST", "/api/users", { name: "Ben", password: BEN_PASSWORD, code: confirmCode(t, secret) });
    expect(res.status).toBe(200);
    return res.body.id;
}

describe("confirmation with the own TOTP code", () => {
    it("creates a device token only with the right code", async () => {
        const { api, secret } = await setUpSignedIn(t);
        expect((await api("POST", "/api/devices", { name: "Mac" })).status).toBe(400);
        expect(await api("POST", "/api/devices", { name: "Mac", code: wrongCode(secret) })).toMatchObject({ status: 401, body: { error: "wrong_code" } });
        expect(activeDevices()).toBe(1);
        expect((await api("POST", "/api/devices", { name: "Mac", code: confirmCode(t, secret) })).status).toBe(200);
        expect(activeDevices()).toBe(2);
        expect(actions().some((a) => a.action === "reauth_failed" && a.target === "Code")).toBe(true);
    });

    it("adds a user only with the right code", async () => {
        const { api, secret } = await setUpSignedIn(t);
        expect((await api("POST", "/api/users", { name: "Ben", password: BEN_PASSWORD })).status).toBe(400);
        expect(await api("POST", "/api/users", { name: "Ben", password: BEN_PASSWORD, code: wrongCode(secret) })).toMatchObject({ status: 401, body: { error: "wrong_code" } });
        expect(await userNames(api)).toEqual(["Anna"]);
        await addBen(api, secret);
        expect(await userNames(api)).toEqual(["Anna", "Ben"]);
    });

    it("sets another user's password only with the right code", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const ben = await addBen(api, secret);
        expect((await api("POST", `/api/users/${ben}/password`, { password: "bens-neues-passwort" })).status).toBe(400);
        expect((await api("POST", `/api/users/${ben}/password`, { password: "bens-neues-passwort", code: wrongCode(secret) })).status).toBe(401);
        expect(await t.vault.checkPassword(ben, BEN_PASSWORD)).toBe(true);
        expect((await api("POST", `/api/users/${ben}/password`, { password: "bens-neues-passwort", code: confirmCode(t, secret) })).status).toBe(200);
        expect(await t.vault.checkPassword(ben, "bens-neues-passwort")).toBe(true);
    });

    it("removes a user only with the right code", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const ben = await addBen(api, secret);
        expect((await api("DELETE", `/api/users/${ben}`)).status).toBe(400);
        expect((await api("DELETE", `/api/users/${ben}`, { code: wrongCode(secret) })).status).toBe(401);
        expect(await userNames(api)).toEqual(["Anna", "Ben"]);
        expect((await api("DELETE", `/api/users/${ben}`, { code: confirmCode(t, secret) })).status).toBe(200);
        expect(await userNames(api)).toEqual(["Anna"]);
    });

    it("refuses a code used before without counting it as a failure", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const code = confirmCode(t, secret);
        expect((await api("POST", "/api/devices", { name: "Mac", code })).status).toBe(200);
        for (let i = 0; i < 6; i++) {
            expect(await api("POST", "/api/devices", { name: "Mac 2", code })).toMatchObject({ status: 401, body: { error: "code_used" } });
        }
        expect((await api("GET", "/api/auth/me")).status).toBe(200);
        expect(activeDevices()).toBe(2);
    });
});

describe("confirmation with the own password", () => {
    it("resets another user's TOTP only with the own password and keeps the own session", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const ben = await addBen(api, secret);
        db().prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(t.vault.fields.seal("JBSWY3DPEHPK3PXP"), ben);
        expect((await api("POST", `/api/users/${ben}/reset-totp`)).status).toBe(400);
        expect(await api("POST", `/api/users/${ben}/reset-totp`, { password: "falsch-falsch-falsch" })).toMatchObject({ status: 401, body: { error: "wrong_password" } });
        expect(totpActive(ben)).toBe(true);
        expect((await api("POST", `/api/users/${ben}/reset-totp`, { password: PASSWORD })).status).toBe(200);
        expect(totpActive(ben)).toBe(false);
        expect((await api("GET", "/api/auth/me")).status).toBe(200);
    });
});

describe("wrong codes and passwords of a session", () => {
    it("sign the session out at the fifth, mixed over all confirmations", async () => {
        const { api, secret } = await setUpSignedIn(t);
        const bad = wrongCode(secret);
        expect((await api("POST", "/api/devices", { name: "Mac", code: bad })).status).toBe(401);
        expect((await api("POST", "/api/users", { name: "Ben", password: BEN_PASSWORD, code: bad })).status).toBe(401);
        expect((await api("POST", "/api/session/password", { password: "falsch" })).status).toBe(401);
        expect(await api("POST", "/api/auth/password", { current: "falsch", next: "ein-neues-langes-passwort", code: bad })).toMatchObject({ status: 401, body: { error: "wrong_password" } });
        expect(await api("POST", "/api/system/recovery-key", { password: "falsch", code: bad })).toMatchObject({ status: 401, body: { error: "signed_out" } });
        expect((await api("GET", "/api/auth/me")).status).toBe(401);
        expect(actions().filter((a) => a.action === "reauth_failed")).toHaveLength(5);
        expect(actions().at(-1)).toMatchObject({ action: "logout", details: "nach fünf Fehlversuchen" });
    });

    it("start again after a right entry", async () => {
        const { api, secret } = await setUpSignedIn(t);
        for (let i = 0; i < 4; i++) expect((await api("POST", "/api/devices", { name: "Mac", code: wrongCode(secret) })).status).toBe(401);
        expect((await api("POST", "/api/session/password", { password: PASSWORD })).status).toBe(200);
        for (let i = 0; i < 4; i++) expect((await api("POST", "/api/session/password", { password: "falsch" })).status).toBe(401);
        expect((await api("GET", "/api/auth/me")).status).toBe(200);
    });

    it("count together with wrong passwords when unlocking the session", async () => {
        const { api, secret, session } = await setUpSignedIn(t);
        for (let i = 0; i < 3; i++) expect((await api("POST", "/api/devices", { name: "Mac", code: wrongCode(secret) })).status).toBe(401);
        const login = () => t.app.inject({ method: "POST", url: "/api/auth/login", payload: { name: "Anna", password: "falsch-falsch-falsch" }, headers: { cookie: session } });
        expect((await login()).json()).toMatchObject({ error: "wrong_login" });
        expect((await login()).json()).toMatchObject({ error: "signed_out" });
        expect((await api("GET", "/api/auth/me")).status).toBe(401);
    });
});
