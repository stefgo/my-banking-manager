// What the connector reads from its environment, the same for both ways to run it: on its own
// Unix socket (index.ts, image mbm-fints) and inside the server's process (embedded.ts, image
// mbm-server-full).
//   MBM_FINTS_PRODUCT_ID       FinTS product registration number (required to contact banks); without
//                              it, the number of an official build (file dist/product-id) applies
//   MBM_FINTS_PRODUCT_VERSION  product version sent to the bank (default: package version),
//                              shortened to the five characters FinTS allows
//   MBM_VERSION                version this connector reports (default: package version; set by
//                              the image build, e.g. dev-abc1234)
//   MBM_FINTS_TRACE=1          print the structure of each message to stderr (no contents)

import { readFileSync } from "node:fs";
import type { ApiOptions } from "./api/server.js";
import { fintsProductVersion, resolveProductId, type ProductIdSource } from "./product.js";
import { httpTransport } from "./transport/http.js";
import { traced } from "./transport/trace.js";

export interface ConnectorSetup {
    options: ApiOptions;
    version: string;
    productSource: ProductIdSource;
    trace: boolean;
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export function connectorSetup(env: NodeJS.ProcessEnv = process.env, productIdFile?: URL | string): ConnectorSetup {
    const version = env.MBM_VERSION?.trim() || pkg.version;
    const { id: productId, source: productSource } = resolveProductId(env.MBM_FINTS_PRODUCT_ID, productIdFile);
    const trace = env.MBM_FINTS_TRACE === "1";
    return {
        options: {
            productId,
            productVersion: fintsProductVersion(env.MBM_FINTS_PRODUCT_VERSION || pkg.version),
            version,
            ...(trace ? { transport: (url: string) => traced(httpTransport(url)) } : {}),
        },
        version,
        productSource,
        trace,
    };
}

/** What the start line says about the product ID: where it comes from, never its value. */
export function productNote(source: ProductIdSource): string {
    if (source === "build") return "product ID of this build";
    if (source === "env") return "product ID from the environment";
    return "no product ID: banks will not be contacted";
}
