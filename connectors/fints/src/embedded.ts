// The FinTS connector inside the server's process (image mbm-server-full). Same routes, same
// contract and same handling of concurrent requests as on the Unix socket: the server hands each
// request in as JSON text through Fastify's inject(), so the two sides never share an object.
// Nothing listens on a socket or a port.

import { buildApi, type ApiOptions } from "./api/server.js";
import type { ProductIdSource } from "./product.js";
import { connectorSetup, productNote } from "./setup.js";

export interface EmbeddedRequest {
    method: string;
    url: string;
    /** JSON text of the body. */
    payload?: string;
}

export interface EmbeddedConnector {
    readonly version: string;
    readonly productSource: ProductIdSource;
    /** Start line for the server's log: version and where the product ID comes from, never its value. */
    readonly startLine: string;
    /** One connector call; answers with the status and the JSON text of the reply. */
    request(req: EmbeddedRequest): Promise<{ status: number; body: string }>;
    /** Ends waiting operations and their dialogs. */
    close(): Promise<void>;
}

/**
 * Builds the connector from the environment (see setup.ts). `overrides` are for tests: how to
 * reach the bank, the operation store.
 */
export async function createEmbeddedConnector(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ApiOptions> = {}): Promise<EmbeddedConnector> {
    const setup = connectorSetup(env);
    const { app } = buildApi({ ...setup.options, ...overrides });
    await app.ready();
    return {
        version: setup.version,
        productSource: setup.productSource,
        startLine: `MBM FinTS connector ${setup.version} embedded (${productNote(setup.productSource)})${setup.trace ? " (trace on)" : ""}`,
        async request(req) {
            const res = await app.inject({
                method: req.method as "GET",
                url: req.url,
                ...(req.payload === undefined ? {} : { payload: req.payload, headers: { "content-type": "application/json" } }),
            });
            return { status: res.statusCode, body: res.body };
        },
        async close() {
            // Closes the operation store too (onClose hook of buildApi)
            await app.close();
        },
    };
}
