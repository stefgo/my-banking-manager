// Refuses requests that another web page sends in the name of a signed-in browser. The session
// cookie (SameSite=Strict) still goes along with requests from the same site: other subdomains
// of the domain, or other ports of the same host. Browsers send `Origin` with every WebSocket
// upgrade and every request that changes something; it has to be MBM's own address.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";

/** Methods that only read; a page of another origin cannot read their answers anyway. */
const READING = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True when a request with this `Origin` may pass: no header (macOS client, curl), MBM's own
 * host (as the request names it, behind a trusted proxy from X-Forwarded-Host), or one of the
 * configured `allowed` origins. Ports count: another port of the same host is another origin.
 */
export function originAllowed(origin: string | undefined, host: string, allowed: readonly string[]): boolean {
    if (origin === undefined) return true;
    let from: URL;
    try {
        from = new URL(origin);
    } catch {
        return false; // "null" (sandboxed frames, files) and anything unreadable
    }
    if (from.protocol !== "http:" && from.protocol !== "https:") return false;
    if (allowed.some((a) => new URL(a).origin === from.origin)) return true;
    try {
        // Read the own host with the origin's scheme, so a default port written out compares equal
        return new URL(`${from.protocol}//${host}`).host === from.host;
    } catch {
        return false;
    }
}

/** Checks `Origin` for every API request that changes something and for the event WebSocket. */
export function registerOriginCheck(app: FastifyInstance, allowed: readonly string[]): void {
    const checked = (request: FastifyRequest) => request.url.startsWith("/api/") && (!READING.has(request.method) || request.url.startsWith("/api/events"));
    app.addHook("onRequest", async (request) => {
        if (!checked(request)) return;
        const origin = request.headers.origin;
        if (originAllowed(origin, request.host, allowed)) return;
        request.log.warn({ origin, host: request.host, url: request.url.split("?")[0] }, "request from another origin refused");
        throw new HttpError(403, "foreign_origin", "Diese Anfrage kam von einer anderen Seite und wurde abgelehnt.");
    });
}
