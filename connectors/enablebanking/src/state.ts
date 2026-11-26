// The opaque state the server keeps for a PSD2 login, sealed with the user key: the session of the
// approval and its accounts. Account ids ("uid") of Enable Banking hold only within a session; the
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

export const State = z.object({
    v: z.literal(1),
    sessionId: z.string().min(1),
    validUntil: z.string(),
    /** PSU headers the bank wants on calls the user started (all or none). */
    psuHeaders: z.array(z.string()),
    accounts: z.array(StoredAccount),
});
export type State = z.infer<typeof State>;

/** The state of a login, or null if there is none or it cannot be read (then the user approves again). */
export function parseState(text: string | undefined): State | null {
    if (!text) return null;
    try {
        const r = State.safeParse(JSON.parse(text));
        return r.success ? r.data : null;
    } catch {
        return null;
    }
}

export const serializeState = (state: State): string => JSON.stringify(state);
