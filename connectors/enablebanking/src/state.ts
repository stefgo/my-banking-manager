// The opaque state the server keeps for a PSD2 login, sealed with the user key: the sessions of the
// approvals and their accounts. One login may hold several approvals at the same bank (PayPal: one
// per PayPal account). Account ids ("uid") of Enable Banking hold only within a session; the
// identification hash stays across sessions and links them.

import { z } from "zod";
import { ConnectorAccountKind, IconKeySchema } from "@mbm/shared";

export const StoredAccount = z.object({
    hash: z.string(),
    /** Id for balances and transactions in this session; null if the session no longer reaches it. */
    uid: z.string().nullable(),
    externalId: z.string(),
    accountNumber: z.string().max(35),
    iban: z.string().nullable(),
    name: z.string(),
    owner: z.string(),
    currency: z.string(),
    kind: ConnectorAccountKind,
    icon: IconKeySchema.optional(),
});
export type StoredAccount = z.infer<typeof StoredAccount>;

export const StoredSession = z.object({
    sessionId: z.string().min(1),
    validUntil: z.string(),
    /** When the connector found the session over (expired, closed or revoked); absent while it holds. */
    ended: z.string().optional(),
    accounts: z.array(StoredAccount),
});
export type StoredSession = z.infer<typeof StoredSession>;

export const State = z.object({
    v: z.literal(2),
    /** PSU headers the bank wants on calls the user started (all or none). */
    psuHeaders: z.array(z.string()),
    /** Oldest first; an account is in at most one of them. */
    sessions: z.array(StoredSession),
});
export type State = z.infer<typeof State>;

/** Version 1: a single approval. */
const StateV1 = z.object({
    v: z.literal(1),
    sessionId: z.string().min(1),
    validUntil: z.string(),
    psuHeaders: z.array(z.string()),
    accounts: z.array(StoredAccount),
});

/** The state of a login, or null if there is none or it cannot be read (then the user approves again). */
export function parseState(text: string | undefined): State | null {
    if (!text) return null;
    try {
        const json: unknown = JSON.parse(text);
        const r = State.safeParse(json);
        if (r.success) return r.data;
        const v1 = StateV1.safeParse(json);
        if (!v1.success) return null;
        const { sessionId, validUntil, psuHeaders, accounts } = v1.data;
        return { v: 2, psuHeaders, sessions: [{ sessionId, validUntil, accounts }] };
    } catch {
        return null;
    }
}

export const serializeState = (state: State): string => JSON.stringify(state);

/** When the approval of a session ends, or ended. */
export const sessionEnd = (s: StoredSession): string => s.ended ?? s.validUntil;

/** The latest end of all approvals; null without any. */
export function latestEnd(state: State): string | null {
    const ends = state.sessions.map(sessionEnd).filter((t) => !Number.isNaN(Date.parse(t)));
    return ends.length ? ends.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
}

/**
 * Adds a new session. Earlier sessions that share an account with it are replaced (the same account
 * approved again); answers with the merged state and the ids of the sessions it replaced.
 */
export function addSession(state: State | null, session: StoredSession, psuHeaders: string[]): { state: State; replaced: string[] } {
    const hashes = new Set(session.accounts.map((a) => a.hash));
    const before = state?.sessions ?? [];
    const kept = before.filter((s) => !s.accounts.some((a) => hashes.has(a.hash)));
    const replaced = before.filter((s) => !kept.includes(s)).map((s) => s.sessionId);
    return { state: { v: 2, psuHeaders, sessions: [...kept, session] }, replaced };
}

/** All accounts of all sessions. */
export const allAccounts = (state: State): StoredAccount[] => state.sessions.flatMap((s) => s.accounts);
