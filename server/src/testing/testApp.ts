import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { buildApp, type AppOptions } from "../app.js";
import { testConfig, type Config } from "../config.js";
import { FAST_KDF } from "../crypto/keystore.js";
import { totpCode, totpStep } from "../crypto/secrets.js";
import { Vault } from "../vault.js";

/** A server on a fresh temporary data directory, never the files of a running installation. */
export async function createTestApp(overrides: Partial<Config> = {}, appOptions: AppOptions = {}) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "mbm-test-"));
    const config = testConfig({ dataDir, ...overrides });
    const logger = pino({ level: "silent" });
    const vault = new Vault(config, logger, FAST_KDF);
    const { app, ctx } = await buildApp(config, vault, logger, appOptions);
    await app.ready();
    return {
        app,
        ctx,
        vault,
        dataDir,
        async close() {
            await app.close();
            vault.close();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** A request helper bound to one session cookie. */
export function apiFor(t: TestApp, session: string) {
    return async <T = unknown>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> => {
        const res = await t.app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: session } });
        return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T) };
    };
}

/** Code for the step after `lastStep`, so a code is never refused as used twice. */
export function nextCode(secret: string, offset = 0): string {
    return totpCode(secret, totpStep() + offset);
}

/**
 * A code for a confirmation by a signed-in user (default: the first one). The user's last used
 * step is set back first, so the codes of a test do not run out within one 30-second step.
 */
export function confirmCode(t: TestApp, secret: string, userId = 1): string {
    t.vault.database.prepare("UPDATE users SET totp_last_step = NULL WHERE id = ?").run(userId);
    return nextCode(secret);
}

/** Sets the installation up with one signed-in user and returns a request helper with the cookie. */
export async function setUpSignedIn(
    t: TestApp,
    name = "Anna",
    password = "sehr-geheimes-passwort",
    seed: { defaultCategories?: boolean; defaultAccountGroups?: boolean } = {},
) {
    const setup = await t.app.inject({ method: "POST", url: "/api/setup", payload: { name, password, ...seed } });
    const { recoveryKey, totp } = setup.json() as { recoveryKey: string; totp: { setupToken: string; secret: string } };
    const { setupToken, secret } = totp;
    const confirm = await t.app.inject({ method: "POST", url: "/api/auth/totp", payload: { setupToken, code: nextCode(secret) } });
    const cookie = confirm.headers["set-cookie"] as string;
    const session = cookie.split(";")[0]!;
    return { api: apiFor(t, session), secret, session, recoveryKey };
}

/**
 * Signs in a further user the first signed-in user created (`POST /api/users`): sets up the
 * second factor and returns a request helper with the new session.
 */
export async function signInCreatedUser(t: TestApp, name: string, password: string) {
    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { name, password } });
    const { setupToken, secret } = login.json() as { status: "totp_setup"; setupToken: string; secret: string };
    const confirm = await t.app.inject({ method: "POST", url: "/api/auth/totp", payload: { setupToken, code: nextCode(secret) } });
    const session = (confirm.headers["set-cookie"] as string).split(";")[0]!;
    return { api: apiFor(t, session), secret, session };
}
