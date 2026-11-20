// Where the FinTS product registration number comes from. The registration terms allow the number
// only inside the registered product: the official mbm-server-full images carry it in a file next
// to the built code (written at build time from a build secret, docker/server-full.Dockerfile),
// never in the source. The image mbm-fints never carries it. Anyone who runs mbm-fints, builds or
// modifies the software registers their own number and sets it in the environment, which takes
// precedence.

import { readFileSync } from "node:fs";

export type ProductIdSource = "env" | "build" | null;

/** File with the number in an official build, next to the compiled entry point. */
export const PRODUCT_ID_FILE = new URL("./product-id", import.meta.url);

export function resolveProductId(envValue: string | undefined, file: URL | string = PRODUCT_ID_FILE): { id: string | null; source: ProductIdSource } {
    const fromEnv = envValue?.trim();
    if (fromEnv) return { id: fromEnv, source: "env" };
    let fromFile = "";
    try {
        fromFile = readFileSync(file, "utf8").trim();
    } catch {
        // No file: a build without the number (anyone building from source)
    }
    return fromFile ? { id: fromFile, source: "build" } : { id: null, source: null };
}

/** FinTS allows at most this many characters for the product version (HKVVB). */
export const PRODUCT_VERSION_MAX = 5;

/**
 * The product version sent to the bank. A version that fits stays as it is; a longer semantic
 * version becomes "major.minor", and if that is still too long, the major version. A pre-release
 * part (1.1.0-beta.2) is dropped, FinTS has none. Anything else is cut to the limit.
 */
export function fintsProductVersion(version: string): string {
    const v = version.trim();
    if (v.length <= PRODUCT_VERSION_MAX) return v;
    const m = /^v?(\d+)\.(\d+)/.exec(v);
    if (!m) return v.slice(0, PRODUCT_VERSION_MAX);
    const [, major = "", minor = ""] = m;
    const short = `${major}.${minor}`;
    if (short.length <= PRODUCT_VERSION_MAX) return short;
    return major.slice(0, PRODUCT_VERSION_MAX);
}
