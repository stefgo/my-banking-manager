import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RouteBody, RouteDef, RouteParams, RouteQuery, RouteResponse } from "@mbm/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/database.js";
import type { FieldCipher } from "../crypto/secrets.js";
import { resolveToken, type Actor, type Session } from "../services/users.js";
import { userKeyOfSession } from "../services/userkey.js";
import type { AutoLock } from "../autolock.js";
import type { BankDirectory } from "../services/bankdirectory.js";
import type { ConnectorRegistry } from "../connectors/client.js";
import type { SyncManager } from "../services/sync.js";
import type { TransferManager } from "../services/transfers.js";
import type { Vault } from "../vault.js";
import type { EventHub } from "./events.js";
import { HttpError } from "./errors.js";
import type { Reauth } from "./reauth.js";

export const SESSION_COOKIE = "mbm_session";

export interface AppContext {
    config: Config;
    vault: Vault;
    events: EventHub;
    autoLock: AutoLock;
    connectors: ConnectorRegistry;
    sync: SyncManager;
    transfers: TransferManager;
    bankDirectory: BankDirectory;
    /** Confirmation of sensitive steps with code or password; counts wrong ones per session. */
    reauth: Reauth;
}

type Parsed<T> = T extends z.ZodType ? z.output<T> : undefined;

export interface Req<R extends RouteDef> {
    params: Parsed<R["params"]>;
    query: Parsed<R["query"]>;
    body: Parsed<R["body"]>;
    /** Set for routes with access "user" or "session". */
    session: Session;
    actor: Actor;
    db: Db;
    fields: FieldCipher;
    request: FastifyRequest;
    reply: FastifyReply;
    /**
     * The signed-in user's key for their bank logins, unwrapped with this session's token.
     * Throws 403 `relogin_required` for sessions from before the user key existed.
     */
    userKey(): Buffer;
}

/** Reads the session token from the cookie (web) or the Authorization header (devices). */
export function tokenOf(request: FastifyRequest): string | null {
    const auth = request.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
    return request.cookies?.[SESSION_COOKIE] ?? null;
}

export function sessionOf(ctx: AppContext, request: FastifyRequest): Session | null {
    const token = tokenOf(request);
    if (!token) return null;
    return resolveToken(ctx.vault.database, token, ctx.config.sessionDays);
}

const validateResponses = process.env.NODE_ENV !== "production";

function parse<T extends z.ZodType>(schema: T | undefined, value: unknown, where: string): z.output<T> | undefined {
    if (!schema) return undefined;
    const result = schema.safeParse(value ?? (where === "body" ? undefined : {}));
    if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        throw new HttpError(400, "invalid", `${field}${issue?.message ?? "Ungültige Anfrage"}`);
    }
    return result.data;
}

/**
 * Registers a handler for a route of the shared list. Params, query and body are checked against
 * the route's schemas; the access level decides whether the database must be open and a user
 * signed in.
 */
export function handle<R extends RouteDef>(
    app: FastifyInstance,
    ctx: AppContext,
    def: R,
    handler: (req: Req<R>) => Promise<z.input<R["response"]>> | z.input<R["response"]>,
): void {
    app.route({
        method: def.method,
        url: def.path,
        handler: async (request, reply) => {
            let session: Session | null = null;
            if (def.access !== "none") {
                if (ctx.vault.state() === "setup") throw new HttpError(409, "not_set_up", "MBM ist noch nicht eingerichtet.");
                void ctx.vault.database; // throws 423 while locked
                if (def.access === "user" || def.access === "session") {
                    session = sessionOf(ctx, request);
                    if (!session) throw new HttpError(401, "signed_out", "Bitte melde dich an.");
                    session = { ...session, idleLocked: ctx.autoLock.isSessionLocked(session) };
                    if (session.idleLocked && def.access === "user") {
                        throw new HttpError(423, "session_locked", "Die Sitzung ist gesperrt. Bitte das Passwort eingeben.");
                    }
                }
            }
            const req = {
                params: parse(def.params, request.params, "params"),
                query: parse(def.query, request.query, "query"),
                body: parse(def.body, request.body, "body"),
                session: session as Session,
                actor: session ? { userId: session.userId, userName: session.userName, deviceId: session.deviceId } : { userId: null, userName: null, deviceId: null },
                get db() {
                    return ctx.vault.database;
                },
                get fields() {
                    return ctx.vault.fields;
                },
                request,
                reply,
                userKey() {
                    const token = tokenOf(request);
                    const key = session && token ? userKeyOfSession(ctx.vault.database, session.deviceId, token) : null;
                    if (!key) throw new HttpError(403, "relogin_required", "Bitte einmal abmelden und neu anmelden, damit MBM deine Bank-Anmeldung schützen kann.");
                    return key;
                },
            } as Req<R>;
            const result = await handler(req);
            if (validateResponses) {
                const check = def.response.safeParse(result);
                if (!check.success) {
                    request.log.error({ route: def.path, issues: check.error.issues.slice(0, 3) }, "response does not match the contract");
                    throw new HttpError(500, "contract", "Die Antwort des Servers passt nicht zum Vertrag.");
                }
            }
            return result;
        },
    });
}

export type { RouteBody, RouteParams, RouteQuery, RouteResponse };
