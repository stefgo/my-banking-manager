import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { FastifyBaseLogger as Logger } from "fastify";
import { AutoLock } from "./autolock.js";
import { BankDirectory } from "./services/bankdirectory.js";
import { ConnectorRegistry, type EmbeddedLoader } from "./connectors/client.js";
import { SyncManager } from "./services/sync.js";
import { TransferManager } from "./services/transfers.js";
import type { Config } from "./config.js";
import { CLOSE_LOCKED, CLOSE_SESSION_LOCKED, CLOSE_SIGNED_OUT, EventHub } from "./http/events.js";
import { HttpError } from "./http/errors.js";
import { registerOriginCheck } from "./http/origin.js";
import { Reauth } from "./http/reauth.js";
import { SESSION_COOKIE, sessionOf, type AppContext } from "./http/route.js";
import { registerBankRoutes } from "./routes/bank.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTransferRoutes } from "./routes/transfers.js";
import type { Vault } from "./vault.js";

export interface BuiltApp {
    app: FastifyInstance;
    ctx: AppContext;
}

export interface AppOptions {
    /** For tests: how an embedded connector is made (default: @mbm/connector-fints/embedded). */
    loadEmbeddedConnector?: EmbeddedLoader;
}

export async function buildApp(config: Config, vault: Vault, logger: Logger, opts: AppOptions = {}): Promise<BuiltApp> {
    const app = Fastify({
        loggerInstance: logger,
        trustProxy: config.trustProxy,
        bodyLimit: 25 * 1024 * 1024,
        logController: new LogController({ disableRequestLogging: true }),
    });
    const events = new EventHub();
    const ctx = { config, vault, events, connectors: new ConnectorRegistry(config, opts.loadEmbeddedConnector ? { loadEmbedded: opts.loadEmbeddedConnector } : {}) } as AppContext;
    await ctx.connectors.start(logger);
    ctx.sync = new SyncManager(ctx, config.bankPollMs);
    ctx.transfers = new TransferManager(ctx, { pollMs: config.bankPollMs });
    // Transfers that were waiting when the server stopped end as cancelled or unknown
    vault.onOpen((db) => ctx.transfers.recover(db));
    ctx.reauth = new Reauth(vault, events, (reply) => reply.clearCookie(SESSION_COOKIE, { path: "/" }));
    ctx.autoLock = new AutoLock(ctx, logger);
    vault.onLock(() => events.locked());
    ctx.autoLock.start();
    // Public data from bundesbank.de, checked once a day; works also while the server is locked
    ctx.bankDirectory = new BankDirectory({
        dataDir: config.dataDir,
        pageUrl: config.bankDirectoryUrl,
        autoUpdate: config.bankDirectoryUpdate,
        log: logger,
        onChange: () => events.changed("bankDirectory"),
    });
    ctx.bankDirectory.start();
    app.addHook("onClose", async () => {
        ctx.autoLock.stop();
        ctx.bankDirectory.stop();
        await ctx.connectors.close();
    });

    await app.register(cookie);
    await app.register(websocket);
    // Requests of other pages in a signed-in browser (same site, other origin) go no further
    registerOriginCheck(app, config.allowedOrigins);

    // Security headers for the API and the web client. No resource from other origins.
    app.addHook("onSend", async (request, reply, payload) => {
        // API answers hold bank data: the browser must not keep them in its cache
        if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Referrer-Policy", "no-referrer");
        reply.header("X-Frame-Options", "DENY");
        reply.header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        );
        return payload;
    });

    app.setErrorHandler((err, request, reply) => {
        if (err instanceof HttpError) {
            return reply.status(err.status).send({ error: err.code, message: err.message });
        }
        const status = (err as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500) {
            return reply.status(status).send({ error: "invalid", message: status === 413 ? "Die Datei ist zu groß." : "Ungültige Anfrage." });
        }
        request.log.error({ err }, "request failed");
        return reply.status(500).send({ error: "internal", message: "Auf dem Server ist ein Fehler aufgetreten." });
    });

    registerSystemRoutes(app, ctx);
    registerDataRoutes(app, ctx);
    registerBankRoutes(app, ctx);
    registerTransferRoutes(app, ctx);

    app.get("/api/events", { websocket: true }, (socket, request) => {
        try {
            const session = vault.state() === "ready" ? sessionOf(ctx, request) : null;
            if (!session) {
                socket.close(CLOSE_SIGNED_OUT, "signed out");
                return;
            }
            if (ctx.autoLock.isSessionLocked(session)) {
                socket.close(CLOSE_SESSION_LOCKED, "session locked");
                return;
            }
            events.add(socket, { userId: session.userId, deviceId: session.deviceId, kind: session.kind });
        } catch {
            socket.close(CLOSE_LOCKED, "locked");
        }
    });

    app.get("/api/health", async () => ({ ok: true, state: vault.state() }));

    app.all("/api/*", async (_request, reply) => reply.status(404).send({ error: "not_found", message: "Diese Schnittstelle gibt es nicht." }));

    if (config.webRoot && existsSync(path.join(config.webRoot, "index.html"))) {
        await app.register(fastifyStatic, { root: config.webRoot, wildcard: false, index: ["index.html"] });
        // Every other path is a route of the web client
        app.setNotFoundHandler((request, reply) => {
            if (request.method !== "GET") return reply.status(404).send({ error: "not_found", message: "Nicht gefunden." });
            return reply.header("Cache-Control", "no-cache").sendFile("index.html");
        });
    }

    return { app, ctx };
}
