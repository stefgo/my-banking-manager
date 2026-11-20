import type { RouteBody, RouteDef, RouteParams, RouteQuery, RouteResponse } from "@mbm/shared";

export class ApiFailure extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

type Listener = (code: "signed_out" | "locked" | "session_locked" | "not_set_up") => void;
const listeners = new Set<Listener>();

/** Called when a request finds the session ended or locked, the server locked or not set up. */
export function onAuthProblem(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
}

type Args<R extends RouteDef> = (RouteParams<R> extends undefined ? { params?: undefined } : { params: RouteParams<R> }) &
    (RouteQuery<R> extends undefined ? { query?: undefined } : { query?: RouteQuery<R> }) &
    (RouteBody<R> extends undefined ? { body?: undefined } : { body: RouteBody<R> });

function buildUrl(def: RouteDef, params?: Record<string, unknown>, query?: Record<string, unknown>): string {
    let path = def.path.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(String(params?.[k] ?? "")));
    if (query) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
        const s = qs.toString();
        if (s) path += `?${s}`;
    }
    return path;
}

/** Calls a route of the shared route list. Errors arrive as ApiFailure with the server's German message. */
export async function call<R extends RouteDef>(def: R, ...rest: keyof Args<R> extends never ? [] : [Args<R>] | []): Promise<RouteResponse<R>> {
    const args = (rest[0] ?? {}) as { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
    let res: Response;
    try {
        res = await fetch(buildUrl(def, args.params, args.query), {
            method: def.method,
            credentials: "same-origin",
            headers: args.body !== undefined ? { "Content-Type": "application/json" } : undefined,
            body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        });
    } catch {
        throw new ApiFailure(0, "offline", "Der Server ist nicht erreichbar.");
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
        const code = (data?.error as string) ?? "error";
        const failure = new ApiFailure(res.status, code, (data?.message as string) ?? `Fehler ${res.status}`);
        if (res.status === 401 && code === "signed_out") listeners.forEach((l) => l("signed_out"));
        if (res.status === 423) listeners.forEach((l) => l(code === "session_locked" ? "session_locked" : "locked"));
        if (res.status === 409 && code === "not_set_up") listeners.forEach((l) => l("not_set_up"));
        throw failure;
    }
    return data as RouteResponse<R>;
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : "Unbekannter Fehler");

/** A wrong or used code, or a wrong password: a form shows it at its field, not as a message. */
export const isSecretError = (err: unknown): err is ApiFailure =>
    err instanceof ApiFailure && ["wrong_code", "code_used", "totp_missing", "wrong_password"].includes(err.code);
