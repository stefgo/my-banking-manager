// Bank accesses in the server API: a connection (the bank, shared by all users) and per user
// one login (credentials sealed with the user key). Calls that talk to the bank may answer
// "approval"; the client then follows the operation until it is done.

import { z } from "zod";
import { ColorKeySchema, IconKeySchema, Id, IsoDate, Name, Timestamp } from "./common.js";
import { Blz, ConnectorAccountCapabilities, ConnectorChallenge, CountryCode, Psd2Bank, Psd2BankInfo, Psd2Credentials, Psd2RedirectUrl } from "./connector.js";

export const BankSearchQuery = z.object({ q: z.string().trim().min(2, "Mindestens zwei Zeichen").max(60) });
export const BankDirectoryEntry = z.object({ blz: z.string(), name: z.string(), place: z.string(), bic: z.string() });
export const BankDirectoryStatus = z.object({
    banks: z.number().int(),
    /** Day the directory was made (downloaded, or converted for the image). */
    generated: IsoDate,
    /** image = the copy the server came with; download = loaded from bundesbank.de. */
    origin: z.enum(["image", "download"]),
    /** Whether the server checks bundesbank.de once a day. */
    autoUpdate: z.boolean(),
    /** Last check since the server started. */
    checkedAt: Timestamp.nullable(),
    lastError: z.string().nullable(),
});
export type BankDirectoryStatus = z.infer<typeof BankDirectoryStatus>;

export const FintsUrl = z.string().trim().url("Bitte eine Adresse wie https://… eingeben").startsWith("https://", "Die FinTS-Adresse muss mit https:// beginnen").max(300);

/** consent_needed: PSD2 approval missing, ended or revoked; the user approves again at the bank. */
export const BankLoginStatus = z.enum(["setup", "ready", "credentials_lost", "pin_wrong", "error", "consent_needed"]);

export const BankLogin = z.object({
    id: Id,
    loginHint: z.string(),
    status: BankLoginStatus,
    tanMethod: z.object({ id: z.string(), name: z.string() }).nullable(),
    tanMedium: z.string().nullable(),
    savePin: z.boolean(),
    lastSyncAt: Timestamp.nullable(),
    lastError: z.string().nullable(),
    /** PSD2: when the last approval at the bank ends; null for FinTS and before the first approval. */
    consentUntil: Timestamp.nullable(),
    /** PSD2: per account taken over, when the approval that reaches it ends (one access may hold several approvals). */
    accountConsents: z.array(z.object({ accountId: Id, until: Timestamp })),
});
export type BankLogin = z.infer<typeof BankLogin>;

/** fints: FinTS with login name and PIN; psd2: through Enable Banking with an approval at the bank. */
export const BankConnectionKind = z.enum(["fints", "psd2"]);
export type BankConnectionKind = z.infer<typeof BankConnectionKind>;

export const BankConnection = z.object({
    id: Id,
    kind: BankConnectionKind,
    name: z.string(),
    bankName: z.string(),
    blz: z.string(),
    bic: z.string().nullable(),
    fintsUrl: z.string(),
    /** PSD2: the bank as Enable Banking names it; null for FinTS (blz and fintsUrl are then empty for PSD2). */
    psd2: Psd2Bank.nullable(),
    icon: IconKeySchema,
    color: ColorKeySchema,
    /** The signed-in user's login; null if they have none yet. */
    myLogin: BankLogin.nullable(),
    /** Logins of other users: only name and status. */
    otherLogins: z.array(z.object({ userName: z.string(), status: BankLoginStatus })),
    accountCount: z.number().int(),
});
export type BankConnection = z.infer<typeof BankConnection>;

export const CreateConnectionRequest = z.object({
    blz: Blz,
    fintsUrl: FintsUrl,
    name: Name.optional(),
    icon: IconKeySchema.optional(),
    color: ColorKeySchema.optional(),
});
export const DeleteConnectionQuery = z.object({
    /** keep: accounts become offline accounts with their bookings; delete: they go too. */
    accounts: z.enum(["keep", "delete"]),
});

export const SetLoginRequest = z.object({
    loginName: z.string().trim().min(1, "Bitte den Anmeldenamen eingeben").max(30),
    customerId: z.string().trim().max(30).optional(),
    pin: z.string().min(1, "Bitte die PIN eingeben").max(64),
    /** false: the PIN is never stored; the client sends it with every call that talks to the bank. */
    savePin: z.boolean().default(true),
});
/**
 * For calls that talk to the bank: the PIN, if the login does not store it. Used for this
 * request only and never written anywhere.
 */
export const PinBody = z.object({ pin: z.string().min(1).max(64).optional() }).default({});

export const ChangePinRequest = z.object({ pin: z.string().min(1).max(64), savePin: z.boolean().optional() });

export const TanMethodOption = z.object({ id: z.string(), name: z.string(), decoupled: z.boolean(), needsMedium: z.boolean() });
export const SetLoginResponse = z.object({ login: BankLogin, tanMethods: z.array(TanMethodOption) });

export const ChooseTanMethodRequest = z.object({ tanMethod: z.string().regex(/^9\d\d$/), tanMedium: z.string().max(32).optional() });

/** Answer of a call that talks to the bank. */
export const bankOutcome = <T extends z.ZodType>(data: T) =>
    z.discriminatedUnion("status", [
        z.object({ status: z.literal("done"), data }),
        z.object({ status: z.literal("approval"), operationId: z.string(), challenge: ConnectorChallenge }),
    ]);

export const TanMediaResult = z.object({ media: z.array(z.object({ name: z.string(), active: z.boolean() })) });

export const OfferedAccount = z.object({
    externalId: z.string(),
    name: z.string(),
    iban: z.string().nullable(),
    /** Card number of a credit card. */
    cardNumber: z.string().nullable(),
    owner: z.string(),
    currency: z.string(),
    kind: z.enum(["giro", "savings", "credit_card", "loan", "depot", "other"]),
    /** Giro, savings, credit card and loan accounts can be taken over; depots not yet. */
    supported: z.boolean(),
    capabilities: ConnectorAccountCapabilities,
    /** Already in MBM (through another login or earlier): its id. */
    accountId: Id.nullable(),
    /** In MBM and reached by the own login, so a fetch with it covers the account. */
    linked: z.boolean(),
    /** Left out on purpose (not taken over, or detached): a fetch does not report it as new. */
    ignored: z.boolean(),
});
export type OfferedAccount = z.infer<typeof OfferedAccount>;
export const OfferedAccounts = z.object({
    accounts: z.array(OfferedAccount),
    /** When the bank sent this list. */
    fetchedAt: z.string(),
});

export const ImportAccountsRequest = z.object({
    accounts: z
        .array(
            z.object({
                externalId: z.string().min(1),
                name: Name.optional(),
                groupId: Id.nullable().default(null),
                icon: IconKeySchema.optional(),
                color: ColorKeySchema.optional(),
            }),
        )
        .max(100),
    /** Offered accounts not in MBM that should stay out: a fetch no longer reports them as new. */
    ignore: z.array(z.string().min(1)).max(100).default([]),
});
export const ImportAccountsResponse = z.object({ created: z.array(Id), linked: z.array(Id) });

export const DetachAccountRequest = z.object({
    /** keep: the account stays as an offline account with its bookings; delete: it goes with them. */
    mode: z.enum(["keep", "delete"]),
});

// ---------- PSD2 through Enable Banking ----------

/** Banks of a country; with credentials typed in (used for this request only) or those of the own login at another PSD2 access (by connection id). */
export const Psd2BankSearchRequest = z
    .object({ country: CountryCode, credentials: Psd2Credentials.optional(), fromConnection: Id.optional() })
    .refine((r) => (r.credentials === undefined) !== (r.fromConnection === undefined), "Entweder Zugangsdaten oder einen eigenen PSD2-Zugang angeben");
export const Psd2BankSearchResponse = z.object({ banks: z.array(Psd2BankInfo) });

export const CreatePsd2ConnectionRequest = Psd2Bank.extend({
    name: Name.optional(),
    icon: IconKeySchema.optional(),
    color: ColorKeySchema.optional(),
});

/** The own Enable Banking application: typed in, or taken from another own PSD2 login (by connection id). */
export const SetPsd2LoginRequest = z
    .object({ credentials: Psd2Credentials.optional(), fromConnection: Id.optional() })
    .refine((r) => (r.credentials === undefined) !== (r.fromConnection === undefined), "Entweder Zugangsdaten oder einen eigenen PSD2-Zugang angeben");

export const StartConsentRequest = z.object({
    /** The client's own address plus /bank-callback; must be registered in the application. */
    redirectUrl: Psd2RedirectUrl,
});
export const StartConsentResponse = z.object({ url: z.string() });

/** What the bank's redirect brought back to /bank-callback (or the address pasted by hand). */
export const CompleteConsentRequest = z.object({
    state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "Die Adresse gehört zu keiner Freigabe"),
    code: z.string().min(1).max(2_000),
});
/** The access after the approval; `newAccounts`: accounts of the approval not taken over or hidden yet. */
export const CompleteConsentResponse = BankConnection.extend({ newAccounts: z.number().int() });

export const BankOperationParam = z.object({ id: z.string().uuid() });
export const BankTanRequest = z.object({ tan: z.string().trim().min(1).max(64) });

/** `embedded`: runs inside the server's process; otherwise a service of its own behind a socket. */
export const ConnectorStatus = z.object({ name: z.string(), embedded: z.boolean(), reachable: z.boolean(), version: z.string().nullable(), productConfigured: z.boolean() });

// ---------- Fetching (sync) ----------

export const SyncRequest = z.object({
    /**
     * One account; else one bank access; else the bank accounts of one account group (with its
     * subgroups); else all accounts the user's logins reach.
     */
    accountId: Id.optional(),
    connectionId: Id.optional(),
    groupId: Id.optional(),
    /** PINs of logins that do not store theirs, by connection id; used for this run only. */
    pins: z.record(z.string(), z.string().min(1).max(64)).optional(),
});

export const SyncRunStatus = z.enum(["running", "approval", "done", "error"]);

export const SyncRun = z.object({
    id: z.string(),
    connectionId: Id,
    connectionName: z.string(),
    status: SyncRunStatus,
    /** What the user has to do while the status is "approval". */
    challenge: ConnectorChallenge.nullable(),
    accountIds: z.array(Id),
    newTransactions: z.number().int(),
    /** Accounts the bank reports that MBM does not have yet. */
    newAccounts: z.array(z.string()),
    /** Accounts of MBM the bank no longer reports. */
    missingAccounts: z.array(Id),
    /** PSD2: accounts left out because the approval that reaches them has ended; the others are fetched. */
    consentEndedAccounts: z.array(Id),
    /** The run fetches only standing orders and scheduled transfers. */
    ordersOnly: z.boolean(),
    /** Set when bookings arrived but the orders could not be fetched; the run still counts as done. */
    ordersMessage: z.string().nullable(),
    /** PSD2: bookings left out because their currency differs from the account's. */
    foreignCurrency: z.number().int(),
    /** Error code ("pin_required", "pin_wrong", "consent_expired", "bank_error", …) and text, if the run failed. */
    error: z.string().nullable(),
    message: z.string().nullable(),
    startedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
});
export type SyncRun = z.infer<typeof SyncRun>;

export const SyncRunParam = z.object({ id: z.string().uuid() });
