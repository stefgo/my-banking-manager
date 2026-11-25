// The connector API (shared/src/connector-api.ts) over Fastify. Request bodies carry PINs: they
// are never logged, and neither are answers with bank data.

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { connectorRoutes, type ConnectorBank, type ConnectorError, type ConnectorLogin, type ConnectorRouteDef, type ConnectorRoutes } from "@mbm/shared";
import { fetchBankParameters } from "../dialog/anonymous.js";
import type { DialogOptions } from "../dialog/dialog.js";
import { FintsBankError, FintsOrderChangedError, FintsOutcomeUnknownError, FintsPinError, FintsSetupError } from "../dialog/errors.js";
import { discoverTanMethods } from "../dialog/session.js";
import { FintsNotSupportedError, fetchAccounts, fetchBalance, fetchCardTransactions, fetchScheduledTransfers, fetchStandingOrders, fetchTransactions } from "../jobs/jobs.js";
import {
    changeScheduledTransfer, changeStandingOrder, createScheduledTransfer, createStandingOrder, deleteScheduledTransfer, deleteStandingOrder, submitTransfer,
    type OrderContext, type PaymentOptions,
} from "../jobs/payments.js";
import { JobRunner, type Outcome } from "../operations/runner.js";
import { OperationStore } from "../operations/store.js";
import { hktab, hktabVersion, parseHitab } from "../segments/tan.js";
import type { Product } from "../segments/dialog.js";
import { parseState, serializeState } from "../state.js";
import { FintsSyntaxError } from "../syntax/types.js";
import { FintsTransportError, httpTransport, type Transport } from "../transport/http.js";
import { parseTanMethods } from "../segments/tan.js";

export interface ApiOptions {
    /** FinTS product registration number; without it no bank is contacted. */
    productId: string | null;
    productVersion: string;
    version: string;
    /** For tests: how to reach a bank. */
    transport?: (url: string) => Transport;
    store?: OperationStore;
    /** For tests: clock and waiting of payments. */
    payments?: PaymentOptions;
}

class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly body: ConnectorError,
    ) {
        super(body.message);
    }
}

type Body<K extends keyof ConnectorRoutes> = ConnectorRoutes[K] extends { body: z.ZodType } ? z.output<ConnectorRoutes[K]["body"]> : undefined;
type Params<K extends keyof ConnectorRoutes> = ConnectorRoutes[K] extends { params: z.ZodType } ? z.output<ConnectorRoutes[K]["params"]> : undefined;
type Handler<K extends keyof ConnectorRoutes> = (req: { body: Body<K>; params: Params<K> }) => Promise<unknown>;

export function buildApi(o: ApiOptions): { app: FastifyInstance; store: OperationStore } {
    const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
    const store = o.store ?? new OperationStore();
    const runner = new JobRunner(store);
    const transport = o.transport ?? ((url: string) => httpTransport(url));

    const product = (): Product => {
        if (!o.productId) throw new ApiError(503, { error: "product_id_missing", message: "Für den Konnektor ist keine FinTS-Produkt-ID eingetragen." });
        return { id: o.productId, version: o.productVersion };
    };

    const dialogOptions = (body: { bank: ConnectorBank; login: ConnectorLogin }): DialogOptions => {
        const state = parseState(body.login.state);
        if (body.login.tanMethod) state.securityFunction = body.login.tanMethod;
        if (body.login.tanMedium !== undefined) state.tanMedium = body.login.tanMedium;
        return {
            transport: transport(body.bank.url),
            product: product(),
            credentials: { blz: body.bank.blz, userId: body.login.userId, customerId: body.login.customerId, pin: body.login.pin },
            state,
        };
    };

    const route = <K extends keyof ConnectorRoutes>(name: K, handler: Handler<K>) => {
        const def = connectorRoutes[name] as ConnectorRouteDef;
        app.route({
            method: def.method,
            url: def.path,
            handler: async (request, reply) => {
                try {
                    const body = def.body ? parse(def.body, request.body) : undefined;
                    const params = def.params ? parse(def.params, request.params) : undefined;
                    const result = await handler({ body, params } as { body: Body<K>; params: Params<K> });
                    return reply.send(result);
                } catch (e) {
                    return sendError(reply, e);
                }
            },
        });
    };

    route("info", async () => ({
        name: "fints",
        version: o.version,
        productConfigured: !!o.productId,
        capabilities: ["accounts", "balances", "transactions", "card-transactions", "tan-media", "standing-orders", "scheduled-transfers", "transfers", "order-writes"],
    }));

    route("checkBank", async ({ body }) => {
        const result = await fetchBankParameters({ blz: body.bank.blz, product: product(), transport: transport(body.bank.url) });
        const bpd = result.bpd;
        if (!bpd) throw new ApiError(502, { error: "bank_answer_invalid", message: "Die Bank hat keine Bankparameter geliefert." });
        return { bankName: bpd.bankName, bpdVersion: bpd.version, pinTan: bpd.pinTan !== null, jobs: Object.keys(bpd.jobs).sort() };
    });

    route("tanMethods", async ({ body }) => {
        const d = dialogOptions(body);
        const methods = await discoverTanMethods(d);
        return {
            status: "done",
            data: { methods: methods.map((m) => ({ id: m.securityFunction, name: m.name, decoupled: m.decoupled !== null, needsMedium: m.mediumRequired === 2 })) },
            state: serializeState(d.state),
        } satisfies Outcome<unknown>;
    });

    route("tanMedia", async ({ body }) => {
        const d = dialogOptions(body);
        const version = hktabVersion(d.state.bpd);
        if (version === null) return { status: "done", data: { media: [] }, state: serializeState(d.state) };
        return runner.run(
            d,
            "tan-media",
            async (send) => {
                const m = await send([hktab(version)]);
                const hitab = m.find("HITAB");
                return { media: (hitab ? parseHitab(hitab) : []).map((x) => ({ name: x.name, active: x.status === "1" || x.status === "3" })) };
            },
            "HKTAB",
        );
    });

    route("accounts", async ({ body }) => {
        const d = dialogOptions(body);
        requireMethod(d);
        return runner.run(d, "accounts", async (send) => ({ accounts: await fetchAccounts(send, d.state) }));
    });

    route("balances", async ({ body }) => {
        const d = dialogOptions(body);
        requireMethod(d);
        return runner.run(d, "balances", async (send) => {
            const balances = [];
            for (const a of body.accounts) balances.push(await fetchBalance(send, d.state, body.bank.blz, a));
            return { balances };
        });
    });

    route("transactions", async ({ body }) => {
        const d = dialogOptions(body);
        requireMethod(d);
        return runner.run(d, "transactions", async (send) => ({ transactions: await fetchTransactions(send, d.state, body.bank.blz, body.account, body.from, body.to) }));
    });

    route("cardTransactions", async ({ body }) => {
        const d = dialogOptions(body);
        requireMethod(d);
        return runner.run(d, "card-transactions", async (send) => fetchCardTransactions(send, d.state, body.bank.blz, body.account, body.from, body.to));
    });

    route("standingOrders", async ({ body }) => {
        const d = dialogOptions(body);
        requireMethod(d);
        return runner.run(d, "standing-orders", async (send) => ({ orders: await fetchStandingOrders(send, d.state, body.bank.blz, body.account) }));
    });

    route("scheduledTransfers", async ({ body }) => {
        const d = dialogOptions(body);
        requireMethod(d);
        return runner.run(d, "scheduled-transfers", async (send) => ({ orders: await fetchScheduledTransfers(send, d.state, body.bank.blz, body.account) }));
    });

    route("transfer", async ({ body }) => {
        const d = dialogOptions(body);
        requireMethod(d);
        return runner.run(d, "transfer", (_send, _dialog, io) => submitTransfer(io, d.state, body.bank.blz, body.account, body.transfer, o.payments), "HKIDN", { payment: true });
    });

    // Orders that are written run as payments: a lost answer after sending leaves the outcome open
    const order = <K extends "createScheduledTransfer" | "changeScheduledTransfer" | "deleteScheduledTransfer" | "createStandingOrder" | "changeStandingOrder" | "deleteStandingOrder">(
        name: K,
        job: (c: OrderContext, body: Body<K>) => Promise<unknown>,
    ) =>
        route(name, async ({ body }) => {
            const b = body as Body<K> & { bank: ConnectorBank; login: ConnectorLogin; account: OrderContext["account"] };
            const d = dialogOptions(b);
            requireMethod(d);
            return runner.run(d, name, (send, _dialog, io) => job({ send, io, state: d.state, blz: b.bank.blz, account: b.account, o: o.payments ?? {} }, body), "HKIDN", { payment: true });
        });
    order("createScheduledTransfer", (c, b) => createScheduledTransfer(c, b.order));
    order("changeScheduledTransfer", (c, b) => changeScheduledTransfer(c, b.expected, b.order));
    order("deleteScheduledTransfer", (c, b) => deleteScheduledTransfer(c, b.expected));
    order("createStandingOrder", (c, b) => createStandingOrder(c, b.order));
    order("changeStandingOrder", (c, b) => changeStandingOrder(c, b.expected, b.order));
    order("deleteStandingOrder", (c, b) => deleteStandingOrder(c, b.expected));

    const unknownOperation = () => new ApiError(404, { error: "operation_unknown", message: "Der Vorgang ist unbekannt oder abgelaufen." });

    route("operation", async ({ params }) => (await runner.advance(params.id)) ?? Promise.reject(unknownOperation()));
    route("operationTan", async ({ params, body }) => (await runner.advance(params.id, body.tan)) ?? Promise.reject(unknownOperation()));
    route("confirmOperation", async ({ params }) => (await runner.confirm(params.id)) ?? Promise.reject(unknownOperation()));
    route("cancelOperation", async ({ params }) => {
        if (!(await runner.cancel(params.id))) throw unknownOperation();
        return { ok: true };
    });

    app.addHook("onClose", async () => store.close());
    return { app, store };
}

/** A TAN method must be chosen, and the bank must offer it, before any job. */
function requireMethod(d: DialogOptions): void {
    const f = d.state.securityFunction;
    if (f === "999" && !d.state.allowedFunctions.includes("999")) {
        throw new ApiError(409, { error: "no_tan_method", message: "Bitte zuerst ein TAN-Verfahren wählen." });
    }
    if (f !== "999" && d.state.bpd && !parseTanMethods(d.state.bpd).some((m) => m.securityFunction === f)) {
        throw new ApiError(409, { error: "no_tan_method", message: "Das gewählte TAN-Verfahren bietet die Bank nicht an." });
    }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
    const r = schema.safeParse(value ?? {});
    if (!r.success) {
        const issue = r.error.issues[0];
        throw new ApiError(400, { error: "invalid", message: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "Ungültige Anfrage"}` });
    }
    return r.data;
}

/** User-facing texts for setup errors; the error messages themselves stay English. */
const SETUP_TEXT: Record<FintsSetupError["reason"], string> = {
    no_tan_method: "Bitte zuerst ein TAN-Verfahren wählen, das die Bank anbietet.",
    no_bpd: "Die Bank hat keine Bankparameter geliefert.",
    dialog_closed: "Die Verbindung zur Bank wurde schon beendet. Bitte noch einmal versuchen.",
    no_pending_approval: "Es wartet keine Freigabe mehr. Bitte noch einmal versuchen.",
    nothing_to_confirm: "Dieser Vorgang wartet auf die Freigabe, nicht auf eine Bestätigung.",
};

function sendError(reply: FastifyReply, e: unknown) {
    const bankCodes = (codes: { code: string; text: string }[]) => codes.map((c) => ({ code: c.code, text: c.text }));
    let status = 500;
    let body: ConnectorError = { error: "internal", message: "Interner Fehler im Konnektor." };
    if (e instanceof ApiError) ({ status, body } = e);
    else if (e instanceof FintsOutcomeUnknownError) [status, body] = [502, { error: "outcome_unknown", message: "Die Antwort der Bank ist nicht angekommen. Ob der Auftrag ausgeführt wurde, ist unbekannt." }];
    else if (e instanceof FintsOrderChangedError) [status, body] = [409, { error: "order_changed", message: "Der Auftrag wurde inzwischen bei der Bank geändert oder gelöscht. Bitte die Aufträge neu abrufen. Es wurde nichts gesendet." }];
    else if (e instanceof FintsPinError) [status, body] = [422, { error: "pin_wrong", message: "Die Bank hat die PIN abgelehnt oder den Zugang gesperrt.", bankCodes: bankCodes(e.codes) }];
    else if (e instanceof FintsBankError) [status, body] = [422, { error: "bank_error", message: e.message, bankCodes: bankCodes(e.codes) }];
    else if (e instanceof FintsNotSupportedError) [status, body] = [422, { error: "not_supported", message: e.message }];
    else if (e instanceof FintsSetupError) [status, body] = [409, { error: e.reason === "no_tan_method" ? "no_tan_method" : "invalid", message: SETUP_TEXT[e.reason] }];
    else if (e instanceof FintsTransportError) {
        if (e.kind === "timeout") [status, body] = [504, { error: "timeout", message: "Die Bank hat nicht rechtzeitig geantwortet." }];
        else if (e.kind === "network") [status, body] = [502, { error: "unreachable", message: "Die Bank ist nicht erreichbar." }];
        else [status, body] = [502, { error: "bank_answer_invalid", message: e.message }];
    } else if (e instanceof FintsSyntaxError) [status, body] = [502, { error: "bank_answer_invalid", message: "Die Antwort der Bank ist nicht lesbar." }];
    return reply.status(status).send(body);
}
