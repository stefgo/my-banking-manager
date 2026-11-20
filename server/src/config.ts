import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ProfileDefaults } from "@mbm/shared";
import { z } from "zod";

/** A connector on its Unix socket, or embedded in the server's process. Never both. */
const ConnectorConfig = z.union([z.strictObject({ socket: z.string().min(1) }), z.strictObject({ embedded: z.literal(true) })]);
export type ConnectorConfig = z.infer<typeof ConnectorConfig>;

const ConfigSchema = z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().default(3040),
    /** Directory for the encrypted database and the key store. */
    dataDir: z.string().default("./data"),
    /** Built web client; empty = no web client served. */
    webRoot: z.string().default(""),
    /**
     * Trust X-Forwarded-* from a reverse proxy (client address, protocol for secure cookies):
     * true, or the proxy's addresses and networks, comma-separated. Off by default, since
     * otherwise every client can set these headers.
     */
    trustProxy: z.union([z.boolean(), z.string().min(1)]).default(false),
    /**
     * Further addresses whose pages may send requests that change something, e.g.
     * "https://mbm.example.org". MBM's own address (Host, behind a trusted proxy X-Forwarded-Host)
     * is always allowed; only needed when a proxy passes neither.
     */
    allowedOrigins: z
        .array(z.string().url().refine((u) => /^https?:$/.test(new URL(u).protocol), "nur http:// oder https://"))
        .default([]),
    /** Session cookie only over HTTPS. "auto" decides per request. */
    secureCookies: z.union([z.boolean(), z.literal("auto")]).default("auto"),
    /** A browser session ends after this many days without use. */
    sessionDays: z.number().int().min(1).max(365).default(30),
    /** A browser session locks after this many minutes without input; 0 = never. */
    sessionIdleMinutes: z.number().int().min(0).max(1440).default(10),
    /** The server locks this many minutes after the last active session ended; 0 = never. */
    autoLockMinutes: z.number().int().min(0).max(1440).default(10),
    /** A transfer asks for the password again if this session last entered it longer ago; 0 = never. */
    transferConfirmMinutes: z.number().int().min(0).max(1440).default(15),
    /** Start values of the profile per device class, until a user changes them. */
    profileDefaults: z
        .object({ web: ProfileDefaults.prefault({}), macos: ProfileDefaults.prefault({}) })
        .prefault({}),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /**
     * Connectors by name: each reachable on its Unix socket, or (only "fints", image
     * mbm-server-full) embedded in the server's process.
     */
    connectors: z.record(z.string(), ConnectorConfig).default({}),
    /** Milliseconds between status queries of a decoupled approval (the connector also honours the bank's hint). */
    bankPollMs: z.number().int().min(50).max(60_000).default(2000),
    /** Load the bank directory of the Bundesbank from bundesbank.de once a day (public data). */
    bankDirectoryUpdate: z.boolean().default(true),
    /** Download page of the bank directory; only changed for tests. */
    bankDirectoryUrl: z
        .string()
        .url()
        .default("https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/bankleitzahlen/download-bankleitzahlen-602592"),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Reads `config.yaml` (path in MBM_CONFIG), then environment variables MBM_PORT, MBM_DATA_DIR, … */
export function loadConfig(env = process.env, cwd = process.cwd()): Config {
    const file = env.MBM_CONFIG ?? path.join(cwd, "config.yaml");
    const fromFile = existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {};
    const fromEnv: Record<string, unknown> = {};
    if (env.MBM_HOST) fromEnv.host = env.MBM_HOST;
    if (env.MBM_PORT) fromEnv.port = Number(env.MBM_PORT);
    if (env.MBM_DATA_DIR) fromEnv.dataDir = env.MBM_DATA_DIR;
    if (env.MBM_WEB_ROOT) fromEnv.webRoot = env.MBM_WEB_ROOT;
    if (env.MBM_LOG_LEVEL) fromEnv.logLevel = env.MBM_LOG_LEVEL;
    if (env.MBM_SESSION_IDLE_MINUTES) fromEnv.sessionIdleMinutes = Number(env.MBM_SESSION_IDLE_MINUTES);
    if (env.MBM_AUTO_LOCK_MINUTES) fromEnv.autoLockMinutes = Number(env.MBM_AUTO_LOCK_MINUTES);
    if (env.MBM_TRANSFER_CONFIRM_MINUTES) fromEnv.transferConfirmMinutes = Number(env.MBM_TRANSFER_CONFIRM_MINUTES);
    if (env.MBM_BANK_DIRECTORY_UPDATE) fromEnv.bankDirectoryUpdate = env.MBM_BANK_DIRECTORY_UPDATE !== "false";
    if (env.MBM_TRUST_PROXY) fromEnv.trustProxy = env.MBM_TRUST_PROXY === "true" ? true : env.MBM_TRUST_PROXY === "false" ? false : env.MBM_TRUST_PROXY;
    if (env.MBM_ALLOWED_ORIGINS) fromEnv.allowedOrigins = env.MBM_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
    const embedded = env.MBM_FINTS_EMBEDDED === "1" || env.MBM_FINTS_EMBEDDED === "true";
    if (embedded && env.MBM_FINTS_SOCKET) {
        throw new Error("MBM_FINTS_EMBEDDED and MBM_FINTS_SOCKET are both set: the FinTS connector is either embedded or on its socket, not both.");
    }
    if (embedded || env.MBM_FINTS_SOCKET) {
        fromEnv.connectors = { ...((fromFile as { connectors?: object }).connectors ?? {}), fints: embedded ? { embedded: true } : { socket: env.MBM_FINTS_SOCKET } };
    }
    const config = ConfigSchema.parse({ ...fromFile, ...fromEnv });
    return { ...config, dataDir: path.resolve(cwd, config.dataDir), webRoot: config.webRoot ? path.resolve(cwd, config.webRoot) : "" };
}

export const testConfig = (overrides: Partial<Config> = {}): Config => ({ ...ConfigSchema.parse({}), logLevel: "fatal", bankDirectoryUpdate: false, ...overrides });
