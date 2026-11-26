// The PSD2 routes of the connector API (shared/src/connector-api.ts, /v1/psd2/…) over Fastify.
// Request bodies carry the private key of the user's Enable Banking application: they are never
// logged, and neither are answers with bank data. Every call builds its own client; nothing of a
// user stays in memory after the answer.

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { connectorRoutes, type ConnectorError, type ConnectorRouteDef, type ConnectorRoutes, type Psd2Credentials, type Psd2Login } from "@mbm/shared";
import { createClient, EnableBankingError, type Client, type ClientOptions } from "../client.js";
import { readPrivateKey } from "../jwt.js";
import { connectorAccount, connectorBalance, connectorTransactions, storedAccount, VOID_REFUND_DAYS, type EbAccount, type EbBalance, type EbTransaction } from "../mapping.js";
import { parseState, serializeState, type State } from "../state.js";

export interface ApiOptions {
    version: string;
    /** For tests: a simulated Enable Banking. */
    client?: Pick<ClientOptions, "fetch" | "baseUrl" | "timeoutMs">;
    /** For tests: the clock. */
    now?: () => number;
}

class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly body: ConnectorError,
    ) {
        super(body.message);
    }
}

interface Aspsp {
    name: string;
    country: string;
    beta?: boolean;
    maximum_consent_validity?: number;
    psu_types?: string[];
    required_psu_headers?: string[];
}

/** Most pages of bookings one call follows; far more than a bank sends for years. */
const MAX_PAGES = 500;
/** An approval asks for a little less than the bank's maximum, so the clocks never disagree. */
const CONSENT_MARGIN_SECONDS = 600;
/** PSU headers the connector can send: from the user's browser, handed in by the server. */
const PSU_HEADERS: Record<string, "ipAddress" | "userAgent"> = { "psu-ip-address": "ipAddress", "psu-user-agent": "userAgent" };

type Body<K extends keyof ConnectorRoutes> = ConnectorRoutes[K] extends { body: z.ZodType } ? z.output<ConnectorRoutes[K]["body"]> : undefined;
type Handler<K extends keyof ConnectorRoutes> = (req: { body: Body<K> }) => Promise<unknown>;

export function buildApi(o: ApiOptions): { app: FastifyInstance } {
    const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
    const now = o.now ?? Date.now;
    const today = () => new Date(now()).toISOString().slice(0, 10);

    const client = (c: Psd2Credentials): Client => {
        let privateKey;
        try {
            privateKey = readPrivateKey(c.privateKey);
        } catch {
            throw new ApiError(422, { error: "pin_wrong", message: "Der private Schlüssel ist kein RSA-Schlüssel im PEM-Format." });
        }
        return createClient({ applicationId: c.applicationId, privateKey }, o.client ?? {});
    };

    const requireState = (login: Psd2Login): State => {
        const state = parseState(login.state);
        if (!state) throw new ApiError(422, { error: "consent_expired", message: "Für diesen Zugang gibt es noch keine gültige Freigabe bei der Bank." });
        return state;
    };

    const aspsps = async (api: Client, country: string): Promise<Aspsp[]> => (await api.get<{ aspsps?: Aspsp[] }>("/aspsps", { country, service: "AIS" })).aspsps ?? [];

    const findAspsp = async (api: Client, bank: { aspsp: string; country: string }): Promise<Aspsp> => {
        const found = (await aspsps(api, bank.country)).find((a) => a.name === bank.aspsp);
        if (!found) throw new ApiError(422, { error: "not_supported", message: `Enable Banking bietet „${bank.aspsp}“ (${bank.country}) nicht an.` });
        return found;
    };

    /** PSU headers for a call the user started, if the bank wants none or only those the connector has. */
    const psuHeaders = (state: State, psu: { ipAddress: string; userAgent: string } | undefined): Record<string, string> => {
        if (!psu) return {};
        const wanted = state.psuHeaders.map((h) => h.toLowerCase());
        if (wanted.some((h) => !(h in PSU_HEADERS))) return {}; // all or none: the connector lacks some of them
        return { "psu-ip-address": psu.ipAddress, "psu-user-agent": psu.userAgent };
    };

    const route = <K extends keyof ConnectorRoutes>(name: K, handler: Handler<K>) => {
        const def = connectorRoutes[name] as ConnectorRouteDef;
        app.route({
            method: def.method,
            url: def.path,
            handler: async (request, reply) => {
                try {
                    const body = def.body ? parse(def.body, request.body) : undefined;
                    return reply.send(await handler({ body } as { body: Body<K> }));
                } catch (e) {
                    return sendError(reply, e);
                }
            },
        });
    };

    route("info", async () => ({ name: "enablebanking", version: o.version, productConfigured: true, capabilities: ["accounts", "balances", "transactions", "psd2"] }));

    route("psd2Banks", async ({ body }) => {
        const list = await aspsps(client(body.credentials), body.country);
        return {
            banks: list
                .map((a) => ({
                    name: a.name,
                    country: a.country,
                    beta: a.beta === true,
                    maxConsentDays: Math.floor((a.maximum_consent_validity ?? 0) / 86_400),
                    psuTypes: (a.psu_types ?? []).filter((t): t is "personal" | "business" => t === "personal" || t === "business"),
                }))
                .sort((x, y) => x.name.localeCompare(y.name, "de")),
        };
    });

    route("psd2Consent", async ({ body }) => {
        const api = client(body.login);
        const aspsp = await findAspsp(api, body.bank);
        const seconds = Math.max(3_600, (aspsp.maximum_consent_validity ?? 7_776_000) - CONSENT_MARGIN_SECONDS);
        const types = aspsp.psu_types ?? [];
        const psuType = types.length === 0 || types.includes(body.psuType) ? body.psuType : types[0];
        const res = await api.post<{ url?: string }>("/auth", {
            access: { valid_until: new Date(now() + seconds * 1000).toISOString() },
            aspsp: { name: aspsp.name, country: aspsp.country },
            state: body.state,
            redirect_url: body.redirectUrl,
            psu_type: psuType,
            language: "de",
        });
        if (typeof res.url !== "string" || !res.url.startsWith("https://")) throw new EnableBankingError(200, "INVALID_ANSWER", "No approval address in the answer.");
        return { url: res.url };
    });

    route("psd2Session", async ({ body }) => {
        const api = client(body.login);
        const aspsp = await findAspsp(api, body.bank);
        const session = await api.post<{ session_id?: string; accounts?: EbAccount[]; access?: { valid_until?: string } }>("/sessions", { code: body.code });
        if (!session.session_id) throw new EnableBankingError(200, "INVALID_ANSWER", "No session in the answer.");
        const accounts = (session.accounts ?? []).filter((a) => typeof a.identification_hash === "string");
        const validUntil = session.access?.valid_until && !Number.isNaN(Date.parse(session.access.valid_until)) ? new Date(session.access.valid_until).toISOString() : new Date(now()).toISOString();
        const state: State = {
            v: 1,
            sessionId: session.session_id,
            validUntil,
            psuHeaders: aspsp.required_psu_headers ?? [],
            accounts: accounts.map((a) => storedAccount(a, aspsp.name, accounts.length === 1)),
        };
        return { state: serializeState(state), validUntil };
    });

    route("psd2CloseSession", async ({ body }) => {
        const state = parseState(body.login.state);
        if (!state) return { ok: true };
        try {
            await client(body.login).delete(`/sessions/${encodeURIComponent(state.sessionId)}`);
        } catch (e) {
            // Already over at Enable Banking: nothing left to end.
            if (!(e instanceof EnableBankingError && (SESSION_GONE.has(e.code) || e.status === 404))) throw e;
        }
        return { ok: true };
    });

    route("psd2Accounts", async ({ body }) => {
        const state = requireState(body.login);
        const session = await client(body.login).get<{ status?: string; accounts_data?: { uid?: string; identification_hash?: string }[] }>(`/sessions/${encodeURIComponent(state.sessionId)}`);
        if (session.status !== "AUTHORIZED") throw consentExpired();
        // Ids of the accounts in this session, linked over the hash that stays across sessions.
        const uids = new Map((session.accounts_data ?? []).filter((a) => a.uid && a.identification_hash).map((a) => [a.identification_hash!, a.uid!]));
        const next: State = { ...state, accounts: state.accounts.map((a) => ({ ...a, uid: uids.get(a.hash) ?? (uids.size === 0 ? a.uid : null) })) };
        return { status: "done", data: { accounts: next.accounts.filter((a) => a.uid !== null).map(connectorAccount) }, state: serializeState(next) };
    });

    route("psd2Balances", async ({ body }) => {
        const state = requireState(body.login);
        const api = client(body.login);
        const headers = psuHeaders(state, body.psu);
        const balances = [];
        for (const ref of body.accounts) {
            const account = state.accounts.find((a) => a.accountNumber === ref.accountNumber);
            if (!account?.uid) continue;
            const res = await api.get<{ balances?: EbBalance[] }>(`/accounts/${encodeURIComponent(account.uid)}/balances`, undefined, headers);
            const balance = connectorBalance(account, res.balances ?? [], today());
            if (balance) balances.push(balance);
        }
        return { status: "done", data: { balances }, state: serializeState(state) };
    });

    route("psd2Transactions", async ({ body }) => {
        const state = requireState(body.login);
        const account = state.accounts.find((a) => a.accountNumber === body.account.accountNumber);
        if (!account?.uid) throw new ApiError(422, { error: "not_supported", message: "Die Freigabe umfasst dieses Konto nicht mehr. Bitte die Freigabe erneuern." });
        const api = client(body.login);
        const headers = psuHeaders(state, body.psu);
        const raw: EbTransaction[] = [];
        // Reaches back further than asked, to see the rejected payment a refund gives back
        const lookBack = body.from ? new Date(Date.parse(`${body.from}T00:00:00Z`) - VOID_REFUND_DAYS * 86_400_000).toISOString().slice(0, 10) : undefined;
        let continuationKey: string | undefined;
        let pages = 0;
        do {
            const page = await api.get<{ transactions?: EbTransaction[]; continuation_key?: string | null }>(
                `/accounts/${encodeURIComponent(account.uid)}/transactions`,
                {
                    // Without a start: as far back as the bank allows (first fetch after an approval).
                    ...(lookBack ? { date_from: lookBack } : { strategy: "longest" }),
                    ...(continuationKey ? { continuation_key: continuationKey } : {}),
                },
                headers,
            );
            raw.push(...(page.transactions ?? []));
            continuationKey = page.continuation_key || undefined;
            pages++;
        } while (continuationKey && pages < MAX_PAGES);
        const { transactions, foreignCurrency } = connectorTransactions(raw, account.currency, today(), body.from);
        return { status: "done", data: { transactions, foreignCurrency }, state: serializeState(state) };
    });

    return { app };
}

/** Error codes of Enable Banking for a session that is over. */
const SESSION_GONE = new Set(["EXPIRED_SESSION", "CLOSED_SESSION", "REVOKED_SESSION", "SESSION_DOES_NOT_EXIST"]);

const consentExpired = () => new ApiError(422, { error: "consent_expired", message: "Die Freigabe bei der Bank ist abgelaufen oder wurde widerrufen. Bitte neu freigeben." });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
    const r = schema.safeParse(value ?? {});
    if (!r.success) {
        const issue = r.error.issues[0];
        throw new ApiError(400, { error: "invalid", message: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "Ungültige Anfrage"}` });
    }
    return r.data;
}

/** User-facing texts for the errors of Enable Banking the user can act on. */
const BANK_TEXT: Record<string, string> = {
    EXPIRED_AUTHORIZATION_CODE: "Die Freigabe hat zu lange gedauert. Bitte noch einmal freigeben.",
    WRONG_AUTHORIZATION_CODE: "Die Adresse gehört zu keiner gültigen Freigabe. Bitte noch einmal freigeben.",
    REDIRECT_URI_NOT_ALLOWED: "Die Rückleitungsadresse ist in der Anwendung bei Enable Banking nicht eingetragen.",
    NO_ACCOUNTS_ADDED: "In der Anwendung bei Enable Banking ist noch kein Konto verknüpft („Activate by linking accounts“).",
    ASPSP_ACCOUNT_NOT_ACCESSIBLE: "Die Bank gibt dieses Konto nicht frei.",
    ASPSP_RATE_LIMIT_EXCEEDED: "Die Bank lässt gerade keine weiteren Abrufe zu. Bitte später noch einmal versuchen.",
    ASPSP_ERROR: "Die Bank hat einen Fehler gemeldet.",
};

function sendError(reply: FastifyReply, e: unknown) {
    let status = 500;
    let body: ConnectorError = { error: "internal", message: "Interner Fehler im Konnektor." };
    if (e instanceof ApiError) ({ status, body } = e);
    else if (e instanceof EnableBankingError) [status, body] = fromEnableBanking(e);
    return reply.status(status).send(body);
}

function fromEnableBanking(e: EnableBankingError): [number, ConnectorError] {
    const bankCodes = [{ code: e.code, text: e.message }];
    if (e.code === "UNREACHABLE") return [502, { error: "unreachable", message: "Enable Banking ist nicht erreichbar." }];
    if (e.code === "TIMEOUT" || e.code === "ASPSP_TIMEOUT") return [504, { error: "timeout", message: "Enable Banking oder die Bank hat nicht rechtzeitig geantwortet." }];
    if (e.code === "INVALID_ANSWER") return [502, { error: "bank_answer_invalid", message: "Die Antwort von Enable Banking ist nicht lesbar." }];
    if (SESSION_GONE.has(e.code) || e.code === "WRONG_SESSION_STATUS") return [422, consentExpired().body];
    if (BANK_TEXT[e.code]) return [422, { error: "bank_error", message: BANK_TEXT[e.code]!, bankCodes }];
    if (e.status === 401 || e.status === 403 || e.code === "UNAUTHORIZED_ACCESS" || e.code === "AUTHORIZATION_NOT_PROVIDED") {
        return [422, { error: "pin_wrong", message: "Enable Banking hat Application-ID oder Schlüssel abgelehnt.", bankCodes }];
    }
    if (e.status === 429) return [422, { error: "bank_error", message: "Enable Banking lässt gerade keine weiteren Anfragen zu. Bitte später noch einmal versuchen.", bankCodes }];
    if (e.status >= 500) return [502, { error: "bank_error", message: "Enable Banking hat einen Fehler gemeldet.", bankCodes }];
    return [422, { error: "bank_error", message: "Enable Banking hat die Anfrage abgelehnt.", bankCodes }];
}
