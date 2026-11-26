// The Enable Banking connector inside the server's process (image mbm-server-full). Same routes and
// contract as on the Unix socket: the server hands each request in as JSON text through Fastify's
// inject(), so the two sides never share an object. Nothing listens on a socket or a port.

import { buildApi, type ApiOptions } from "./api/server.js";
import { connectorSetup } from "./setup.js";

export interface EmbeddedRequest {
    method: string;
    url: string;
    /** JSON text of the body. */
    payload?: string;
}

export interface EmbeddedConnector {
    readonly version: string;
    /** Start line for the server's log. */
    readonly startLine: string;
    /** One connector call; answers with the status and the JSON text of the reply. */
    request(req: EmbeddedRequest): Promise<{ status: number; body: string }>;
    close(): Promise<void>;
}

/** Builds the connector from the environment (see setup.ts). `overrides` are for tests. */
export async function createEmbeddedConnector(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ApiOptions> = {}): Promise<EmbeddedConnector> {
    const setup = connectorSetup(env);
    const { app } = buildApi({ ...setup.options, ...overrides });
    await app.ready();
    return {
        version: setup.version,
        startLine: `MBM Enable Banking connector ${setup.version} embedded`,
        async request(req) {
            const res = await app.inject({
                method: req.method as "GET",
                url: req.url,
                ...(req.payload === undefined ? {} : { payload: req.payload, headers: { "content-type": "application/json" } }),
            });
            return { status: res.statusCode, body: res.body };
        },
        async close() {
            await app.close();
        },
    };
}
