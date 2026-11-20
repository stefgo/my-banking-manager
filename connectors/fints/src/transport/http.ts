// FinTS over HTTPS: one POST per message, body Base64-encoded (filter "MIM" in HIKOM).
// Nothing of the content is logged here or anywhere else.

export interface Transport {
    send(message: Uint8Array): Promise<Uint8Array>;
}

export type TransportErrorKind = "timeout" | "network" | "http" | "invalid";

export class FintsTransportError extends Error {
    constructor(
        readonly kind: TransportErrorKind,
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "FintsTransportError";
    }
}

export interface HttpOptions {
    timeoutMs?: number;
    /** Plain HTTP, only for the simulated bank in tests. */
    allowInsecure?: boolean;
}

export function httpTransport(url: string, options: HttpOptions = {}): Transport {
    const target = new URL(url);
    if (target.protocol !== "https:" && !(options.allowInsecure && target.protocol === "http:")) {
        throw new FintsTransportError("invalid", "FinTS address must use HTTPS");
    }
    const timeoutMs = options.timeoutMs ?? 60_000;
    return {
        async send(message) {
            let res: Response;
            try {
                res = await fetch(target, {
                    method: "POST",
                    headers: { "content-type": "text/plain; charset=us-ascii" },
                    body: Buffer.from(message).toString("base64"),
                    signal: AbortSignal.timeout(timeoutMs),
                    redirect: "error",
                });
            } catch (e) {
                const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
                throw new FintsTransportError(timeout ? "timeout" : "network", timeout ? "The bank did not answer in time" : "The bank could not be reached");
            }
            if (!res.ok) throw new FintsTransportError("http", `The bank answered with HTTP ${res.status}`, res.status);
            return decodeBody(Buffer.from(await res.arrayBuffer()));
        },
    };
}

/** Base64 as agreed; a few servers answer unencoded, which starts with the message header. */
export function decodeBody(body: Buffer): Buffer {
    const raw = body.toString("latin1");
    if (raw.startsWith("HNHBK:")) return body;
    const compact = raw.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new FintsTransportError("invalid", "The bank's answer is not Base64");
    const decoded = Buffer.from(compact, "base64");
    if (!decoded.toString("latin1").startsWith("HNHBK:")) throw new FintsTransportError("invalid", "The bank's answer is not a FinTS message");
    return decoded;
}
