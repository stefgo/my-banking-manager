// A simulated Enable Banking for tests, as a fetch function: the routes the connector uses, with
// made-up data in the form PayPal sends (no IBAN, "XXX", only the transaction date, empty purpose).
// Never talks to the real service.

import { randomUUID, verify, type KeyObject } from "node:crypto";
import type { EbAccount, EbBalance, EbTransaction } from "../mapping.js";

export interface FakeAspsp {
    name: string;
    country: string;
    beta?: boolean;
    maximum_consent_validity: number;
    psu_types: string[];
    required_psu_headers?: string[];
}

export interface FakeAccount {
    account: EbAccount;
    balances: EbBalance[];
    transactions: EbTransaction[];
}

export interface FakeOptions {
    applicationId: string;
    /** Verifies the token signature when given. */
    publicKey?: KeyObject;
    aspsps?: FakeAspsp[];
    accounts?: FakeAccount[];
    redirectUrls?: string[];
    /** Bookings per page. */
    pageSize?: number;
    /** The clock, as the connector under test sees it. */
    now?: () => number;
}

export interface RecordedCall {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
}

export const PAYPAL: FakeAspsp = { name: "PayPal", country: "DE", beta: false, maximum_consent_validity: 15_552_000, psu_types: ["personal", "business"] };

export const paypalAccount = (): FakeAccount => ({
    account: {
        account_id: { iban: null, other: { identification: "PAYPALACCOUNT00000000000001", scheme_name: "OTHI" } },
        all_account_ids: [{ identification: "PAYPALACCOUNT00000000000001", scheme_name: "OTHI" }],
        name: "Alex Beispiel",
        product: "PAYPAL_PREMIER_ACCOUNT",
        cash_account_type: "OTHR",
        currency: "XXX",
        identification_hash: "hash-paypal-1",
    },
    balances: [{ balance_amount: { currency: "EUR", amount: "123.45" }, balance_type: "XPCD", reference_date: null }],
    transactions: [
        {
            entry_reference: "1AB23456CD789012E",
            transaction_amount: { currency: "EUR", amount: "19.99" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            transaction_date: "2026-11-20",
            creditor: { name: "Beispiel Shop GmbH", contact_details: { email_address: "shop@example.com" } },
            debtor: {},
            bank_transaction_code: { code: "PAYMENT", sub_code: "PAYMENT", description: null },
            remittance_information: [],
        },
        {
            entry_reference: "2AB23456CD789012F",
            transaction_amount: { currency: "EUR", amount: "5.00" },
            credit_debit_indicator: "CRDT",
            status: "BOOK",
            transaction_date: "2026-11-18",
            creditor: {},
            debtor: { name: null, contact_details: { email_address: "erika@example.com" } },
            bank_transaction_code: { code: "PAYMENT", sub_code: "REFUND" },
            remittance_information: [],
        },
        {
            entry_reference: "3AB23456CD789012G",
            transaction_amount: { currency: "EUR", amount: "7.50" },
            credit_debit_indicator: "DBIT",
            status: "RJCT",
            transaction_date: "2026-11-17",
            creditor: { name: "Abgelehnt AG" },
            bank_transaction_code: { code: "PAYMENT", sub_code: "PAYMENT" },
        },
        {
            entry_reference: "4AB23456CD789012H",
            transaction_amount: { currency: "USD", amount: "10.00" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            transaction_date: "2026-11-16",
            creditor: { name: "US Store" },
            bank_transaction_code: { code: "PAYMENT", sub_code: "PAYMENT" },
        },
    ],
});

/** A second PayPal account of another holder: a second approval at the same access. */
export function secondPaypalAccount(): FakeAccount {
    const b = paypalAccount();
    b.account = {
        ...b.account,
        account_id: { iban: null, other: { identification: "PAYPALACCOUNT00000000000002", scheme_name: "OTHI" } },
        all_account_ids: [{ identification: "PAYPALACCOUNT00000000000002", scheme_name: "OTHI" }],
        name: "Kim Beispiel",
        identification_hash: "hash-paypal-2",
    };
    b.balances = [{ balance_amount: { currency: "EUR", amount: "50.00" }, balance_type: "XPCD", reference_date: null }];
    b.transactions = b.transactions.slice(0, 1).map((t) => ({ ...t, entry_reference: "9ZZ23456CD789012Z" }));
    return b;
}

interface Session {
    id: string;
    status: "AUTHORIZED" | "EXPIRED" | "CLOSED" | "REVOKED";
    uids: Map<string, number>; // uid → index into accounts
}

export function fakeEnableBanking(o: FakeOptions) {
    const aspsps = o.aspsps ?? [PAYPAL];
    const accounts = o.accounts ?? [paypalAccount()];
    const redirectUrls = o.redirectUrls ?? ["https://localhost/bank-callback"];
    const pageSize = o.pageSize ?? 100;
    const now = o.now ?? Date.now;
    const calls: RecordedCall[] = [];
    const auths = new Map<string, { state: string; validUntil: string; aspsp: FakeAspsp; accounts?: number[] }>(); // code → auth
    const sessions = new Map<string, Session>();
    let lastAuth: { state: string; code: string; body: Record<string, unknown> } | null = null;

    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const error = (status: number, code: string, message: string) => json(status, { message, code: status, error: code });

    const authorized = (header: string | undefined): boolean => {
        const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
        if (!token) return false;
        const [h, p, s] = token.split(".");
        if (!h || !p || !s) return false;
        const head = JSON.parse(Buffer.from(h, "base64url").toString()) as { kid?: string; alg?: string };
        const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { aud?: string; iss?: string; exp?: number; iat?: number };
        if (head.kid !== o.applicationId || head.alg !== "RS256" || claims.aud !== "api.enablebanking.com" || claims.iss !== "enablebanking.com") return false;
        if ((claims.exp ?? 0) - (claims.iat ?? 0) > 86_400) return false;
        return !o.publicKey || verify("sha256", Buffer.from(`${h}.${p}`), o.publicKey, Buffer.from(s, "base64url"));
    };

    const sessionOf = (id: string): Session | Response => {
        const s = sessions.get(id);
        if (!s) return error(404, "SESSION_DOES_NOT_EXIST", "Session does not exist");
        if (s.status === "EXPIRED") return error(401, "EXPIRED_SESSION", "Session is expired");
        if (s.status === "CLOSED") return error(401, "CLOSED_SESSION", "Session is closed");
        if (s.status === "REVOKED") return error(401, "REVOKED_SESSION", "Session is revoked");
        return s;
    };

    const accountOf = (uid: string): FakeAccount | Response => {
        for (const s of sessions.values()) {
            const i = s.uids.get(uid);
            if (i === undefined) continue;
            if (s.status !== "AUTHORIZED") return sessionOf(s.id) as Response;
            return accounts[i]!;
        }
        return error(404, "ACCOUNT_DOES_NOT_EXIST", "Account does not exist");
    };

    const fetch = (async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body });
        if (url.origin !== "https://api.enablebanking.com") throw new TypeError("fetch failed");
        if (init?.redirect !== "error") return error(500, "TEST", "The connector must refuse redirects");
        if (!authorized(headers.authorization)) return error(401, "UNAUTHORIZED_ACCESS", "Unauthorized access");
        const path = url.pathname;

        if (method === "GET" && path === "/aspsps") {
            const country = url.searchParams.get("country");
            return json(200, { aspsps: aspsps.filter((a) => !country || a.country === country).map((a) => ({ ...a, logo: "https://enablebanking.example/logo.png", auth_methods: [] })) });
        }
        if (method === "POST" && path === "/auth") {
            const aspsp = aspsps.find((a) => a.name === (body?.aspsp as { name?: string })?.name && a.country === (body?.aspsp as { country?: string })?.country);
            if (!aspsp) return error(404, "ASPSP_NOT_FOUND", "ASPSP not found");
            if (!redirectUrls.includes(String(body?.redirect_url))) return error(400, "REDIRECT_URI_NOT_ALLOWED", "Redirect URI not allowed");
            const validUntil = String((body?.access as { valid_until?: string })?.valid_until);
            if (Date.parse(validUntil) > now() + aspsp.maximum_consent_validity * 1000 + 60_000) return error(422, "WRONG_REQUEST_PARAMETERS", "valid_until too far");
            const code = randomUUID();
            auths.set(code, { state: String(body?.state), validUntil, aspsp });
            lastAuth = { state: String(body?.state), code, body: body ?? {} };
            return json(200, { url: `https://tilisy.enablebanking.example/ais/start?sessionid=${randomUUID()}`, authorization_id: randomUUID(), psu_id_hash: "x" });
        }
        if (method === "POST" && path === "/sessions") {
            const auth = auths.get(String(body?.code));
            if (!auth) return error(400, "WRONG_AUTHORIZATION_CODE", "Wrong authorization code");
            auths.delete(String(body?.code));
            const session: Session = { id: randomUUID(), status: "AUTHORIZED", uids: new Map() };
            // The accounts the user approved at the bank (PayPal: the one signed in with); all by default
            accounts.forEach((_, i) => {
                if (!auth.accounts || auth.accounts.includes(i)) session.uids.set(randomUUID(), i);
            });
            sessions.set(session.id, session);
            return json(200, {
                session_id: session.id,
                accounts: [...session.uids].map(([uid, i]) => ({ ...accounts[i]!.account, uid })),
                aspsp: { name: auth.aspsp.name, country: auth.aspsp.country },
                psu_type: "personal",
                access: { valid_until: auth.validUntil },
            });
        }
        const sessionPath = /^\/sessions\/([^/]+)$/.exec(path);
        if (sessionPath) {
            const s = sessions.get(decodeURIComponent(sessionPath[1]!));
            if (!s) return error(404, "SESSION_DOES_NOT_EXIST", "Session does not exist");
            if (method === "DELETE") {
                s.status = "CLOSED";
                return json(200, { message: "OK" });
            }
            return json(200, {
                status: s.status,
                accounts: [...s.uids.keys()],
                accounts_data: [...s.uids].map(([uid, i]) => ({ uid, identification_hash: accounts[i]!.account.identification_hash })),
            });
        }
        const accountPath = /^\/accounts\/([^/]+)\/(balances|transactions)$/.exec(path);
        if (accountPath && method === "GET") {
            const account = accountOf(decodeURIComponent(accountPath[1]!));
            if (account instanceof Response) return account;
            if (accountPath[2] === "balances") return json(200, { balances: account.balances });
            const from = url.searchParams.get("date_from");
            const all = account.transactions.filter((t) => !from || (t.booking_date ?? t.transaction_date ?? "") >= from);
            const start = Number(url.searchParams.get("continuation_key") ?? "0");
            const next = start + pageSize < all.length ? String(start + pageSize) : null;
            return json(200, { transactions: all.slice(start, start + pageSize), continuation_key: next });
        }
        return error(404, "NOT_FOUND", `No route ${method} ${path}`);
    }) as typeof globalThis.fetch;

    return {
        fetch,
        calls,
        /**
         * The code the bank's redirect would bring back for the last approval started, with its state;
         * `only`: the accounts (indexes) the user approves, as PayPal approves the one signed in with.
         */
        approve(only?: number[]): { code: string; state: string } {
            if (!lastAuth) throw new Error("No approval started");
            const auth = auths.get(lastAuth.code);
            if (auth && only) auth.accounts = only;
            return { code: lastAuth.code, state: lastAuth.state };
        },
        lastAuthBody: () => lastAuth?.body ?? null,
        setSessionStatus(id: string, status: Session["status"]) {
            const s = sessions.get(id);
            if (!s) throw new Error("No such session");
            s.status = status;
        },
        sessionStatus: (id: string) => sessions.get(id)?.status ?? null,
        sessionIds: () => [...sessions.keys()],
        accounts,
    };
}

export type FakeEnableBanking = ReturnType<typeof fakeEnableBanking>;
