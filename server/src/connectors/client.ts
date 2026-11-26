// Calls connectors along the routes of shared/src/connector-api.ts: over their Unix socket, or
// (FinTS in the image mbm-server-full) inside the server's own process.
// Bodies hold PINs: they are never logged. Answers are checked against the contract.

import { request } from "node:http";
import type { z } from "zod";
import { ConnectorError as ConnectorErrorSchema, connectorRoutes, type ConnectorRoutes } from "@mbm/shared";
import type { Config } from "../config.js";

type Body<K extends keyof ConnectorRoutes> = ConnectorRoutes[K] extends { body: z.ZodType } ? z.input<ConnectorRoutes[K]["body"]> : undefined;
type Response<K extends keyof ConnectorRoutes> = z.output<ConnectorRoutes[K]["response"]>;

/** A connector call failed: its error code (see ConnectorErrorCode) or "connector_unavailable". */
export class ConnectorCallError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly bankCodes: { code: string; text: string }[] = [],
    ) {
        super(message);
        this.name = "ConnectorCallError";
    }
}

/** One HTTP exchange with a connector: method, path and JSON text of the body in, status and text out. */
export type ConnectorExchange = (req: { method: string; path: string; body?: string }) => Promise<{ status: number; text: string }>;

/** Thrown by an exchange that did not reach the connector or got no answer in time. */
class Unreachable extends Error {}

/** Over the connector's Unix socket (images mbm-server + mbm-fints). */
export function socketExchange(socketPath: string, timeoutMs: number): ConnectorExchange {
    return ({ method, path, body }) =>
        new Promise((resolve, reject) => {
            const req = request(
                { socketPath, method, path, headers: body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}, timeout: timeoutMs },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
                    res.on("error", () => reject(new Unreachable()));
                },
            );
            req.on("timeout", () => req.destroy(new Error("timeout")));
            req.on("error", () => reject(new Unreachable()));
            req.end(body);
        });
}

/**
 * What the server needs of a connector inside its own process (image mbm-server-full); provided
 * by @mbm/connector-fints/embedded. Requests go in as JSON text, never as shared objects.
 */
export interface EmbeddedConnector {
    readonly startLine: string;
    request(req: { method: string; url: string; payload?: string }): Promise<{ status: number; body: string }>;
    close(): Promise<void>;
}

/**
 * Into the embedded connector. Calls of different users run side by side, as over the socket. The
 * same time limit applies: a call without an answer is given up (its bank request ends with the
 * connector's own limits), so it holds nothing on the server's side.
 */
export function embeddedExchange(connector: Promise<EmbeddedConnector>, timeoutMs: number): ConnectorExchange {
    return async ({ method, path, body }) => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Unreachable()), timeoutMs);
            timer.unref();
        });
        try {
            const c = await connector;
            const res = await Promise.race([c.request({ method, url: path, ...(body === undefined ? {} : { payload: body }) }), timeout]);
            return { status: res.status, text: res.body };
        } catch {
            throw new Unreachable();
        } finally {
            clearTimeout(timer);
        }
    };
}

export const CONNECTOR_TIMEOUT_MS = 10 * 60_000;

export type EmbeddedLoader = () => Promise<EmbeddedConnector>;

/** Connectors that can run inside the server's process, with their package and switch. */
const EMBEDDABLE = {
    fints: { specifier: "@mbm/connector-fints/embedded", env: "MBM_FINTS_EMBEDDED", label: "FinTS" },
    enablebanking: { specifier: "@mbm/connector-enablebanking/embedded", env: "MBM_ENABLEBANKING_EMBEDDED", label: "Enable Banking" },
} as const;
export type EmbeddableConnector = keyof typeof EMBEDDABLE;

/**
 * A connector of this installation, loaded only when it is configured as embedded. The image
 * mbm-server has no connector inside; there this fails with a clear message.
 */
async function loadEmbedded(name: EmbeddableConnector): Promise<EmbeddedConnector> {
    const { specifier, env, label } = EMBEDDABLE[name];
    // A specifier TypeScript does not follow: the server builds without the connectors.
    let mod: { createEmbeddedConnector(env?: NodeJS.ProcessEnv): Promise<EmbeddedConnector> };
    try {
        mod = (await import(specifier)) as typeof mod;
    } catch (e) {
        if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
            throw new Error(`${env} is set, but this installation has no ${label} connector inside (the image mbm-server-full has one).`, { cause: e });
        }
        throw e;
    }
    return mod.createEmbeddedConnector(process.env);
}

const isEmbeddable = (name: string): name is EmbeddableConnector => Object.hasOwn(EMBEDDABLE, name);

export class ConnectorClient {
    constructor(
        readonly name: string,
        private readonly exchange: ConnectorExchange,
    ) {}

    async call<K extends keyof ConnectorRoutes>(route: K, opts: { body?: Body<K>; id?: string } = {}): Promise<Response<K>> {
        const def = connectorRoutes[route];
        const path = def.path.replace(":id", encodeURIComponent(opts.id ?? ""));
        const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
        let res: { status: number; text: string };
        try {
            res = await this.exchange({ method: def.method, path, ...(data === undefined ? {} : { body: data }) });
        } catch {
            throw new ConnectorCallError("connector_unavailable", `Der Konnektor „${this.name}“ ist nicht erreichbar.`);
        }
        let json: unknown;
        try {
            json = JSON.parse(res.text);
        } catch {
            throw new ConnectorCallError("connector_unavailable", "Der Konnektor hat keine lesbare Antwort geliefert.");
        }
        if (res.status === 200) {
            const ok = (def.response as z.ZodType).safeParse(json);
            if (ok.success) return ok.data as Response<K>;
            throw new ConnectorCallError("internal", "Die Antwort des Konnektors passt nicht zum Vertrag.");
        }
        const err = ConnectorErrorSchema.safeParse(json);
        if (err.success) throw new ConnectorCallError(err.data.error, err.data.message, err.data.bankCodes);
        throw new ConnectorCallError("internal", `Der Konnektor antwortete mit HTTP ${res.status}.`);
    }
}

/** The configured connectors and what each reported at its last info call. */
export class ConnectorRegistry {
    private readonly clients = new Map<string, ConnectorClient>();
    private readonly infos = new Map<string, Response<"info"> | null>();

    private readonly embedded = new Map<string, Promise<EmbeddedConnector>>();

    /** `loadEmbedded`: for tests, how an embedded connector is made, by name. */
    constructor(config: Pick<Config, "connectors">, opts: { loadEmbedded?: Partial<Record<EmbeddableConnector, EmbeddedLoader>>; timeoutMs?: number } = {}) {
        const timeoutMs = opts.timeoutMs ?? CONNECTOR_TIMEOUT_MS;
        for (const [name, c] of Object.entries(config.connectors)) {
            if ("socket" in c) {
                this.clients.set(name, new ConnectorClient(name, socketExchange(c.socket, timeoutMs)));
                continue;
            }
            const loading = isEmbeddable(name)
                ? (opts.loadEmbedded?.[name] ?? (() => loadEmbedded(name)))()
                : Promise.reject(new Error(`Only the FinTS and the Enable Banking connector can be embedded, not "${name}".`));
            // Reported by start(); until then no call is made
            loading.catch(() => undefined);
            this.embedded.set(name, loading);
            this.clients.set(name, new ConnectorClient(name, embeddedExchange(loading, timeoutMs)));
        }
    }

    /** Loads the embedded connectors (a missing one stops the start) and asks all for their info. */
    async start(log: { info(msg: string): void }): Promise<void> {
        for (const loading of this.embedded.values()) log.info((await loading).startLine);
        void this.refresh();
    }

    /** Ends the embedded connectors and the operations they hold. */
    async close(): Promise<void> {
        await Promise.all([...this.embedded.values()].map(async (loading) => (await loading.catch(() => null))?.close()));
    }

    get(name: string): ConnectorClient {
        const c = this.clients.get(name);
        if (!c) throw new ConnectorCallError("connector_unavailable", `Der Konnektor „${name}“ ist nicht eingerichtet.`);
        return c;
    }

    /** Asks every connector for its info; one that does not answer is reported as missing. */
    async refresh(): Promise<void> {
        await Promise.all(
            [...this.clients.values()].map(async (c) => {
                try {
                    this.infos.set(c.name, await c.call("info"));
                } catch {
                    this.infos.set(c.name, null);
                }
            }),
        );
    }

    status(): { name: string; reachable: boolean; version: string | null; productConfigured: boolean }[] {
        return [...this.clients.keys()].map((name) => {
            const info = this.infos.get(name);
            return { name, reachable: !!info, version: info?.version ?? null, productConfigured: info?.productConfigured ?? false };
        });
    }
}
