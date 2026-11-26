// HTTPS calls to the Enable Banking API. Only api.enablebanking.com, no redirects, a time limit on
// every call. Nothing of requests or answers is logged here or anywhere else.

import type { KeyObject } from "node:crypto";
import { signToken } from "./jwt.js";

export const API_BASE = "https://api.enablebanking.com";

export interface Credentials {
    applicationId: string;
    privateKey: KeyObject;
}

/**
 * A call failed. `status` is the HTTP status (0: no answer), `code` the error code of Enable Banking
 * (e.g. EXPIRED_SESSION) or UNREACHABLE / TIMEOUT / INVALID_ANSWER / HTTP_<status>.
 */
export class EnableBankingError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "EnableBankingError";
    }
}

export interface ClientOptions {
    timeoutMs?: number;
    /** Only for tests: a simulated API instead of the real one. */
    baseUrl?: string;
    fetch?: typeof fetch;
}

export type Query = Record<string, string | undefined>;

export interface Client {
    get<T>(path: string, query?: Query, headers?: Record<string, string>): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
    delete<T>(path: string): Promise<T>;
}

export function createClient(credentials: Credentials, options: ClientOptions = {}): Client {
    const base = options.baseUrl ?? API_BASE;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const doFetch = options.fetch ?? fetch;

    async function call<T>(method: string, path: string, query?: Query, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
        const url = new URL(path, base);
        for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
        const headers: Record<string, string> = {
            ...extraHeaders,
            authorization: `Bearer ${signToken(credentials.applicationId, credentials.privateKey)}`,
            accept: "application/json",
        };
        if (body !== undefined) headers["content-type"] = "application/json";
        let res: Response;
        try {
            res = await doFetch(url, {
                method,
                headers,
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                redirect: "error",
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            if ((e as { name?: string } | null)?.name === "TimeoutError") throw new EnableBankingError(0, "TIMEOUT", "Enable Banking did not answer in time.");
            throw new EnableBankingError(0, "UNREACHABLE", "Enable Banking is not reachable.");
        }
        const text = await res.text().catch(() => "");
        let json: unknown;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        if (!res.ok) {
            const err = (json ?? {}) as { error?: unknown; message?: unknown };
            throw new EnableBankingError(
                res.status,
                typeof err.error === "string" && err.error ? err.error : `HTTP_${res.status}`,
                typeof err.message === "string" ? err.message : `HTTP ${res.status}`,
            );
        }
        if (json === null || typeof json !== "object") throw new EnableBankingError(res.status, "INVALID_ANSWER", "Enable Banking sent no JSON object.");
        return json as T;
    }

    return {
        get: (path, query, headers) => call("GET", path, query, undefined, headers),
        post: (path, body) => call("POST", path, undefined, body),
        delete: (path) => call("DELETE", path),
    };
}
