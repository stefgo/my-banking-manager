// Bank accesses in the server API: a connection (the bank, shared by all users) and per user
// one login (credentials sealed with the user key). Calls that talk to the bank may answer
// "approval"; the client then follows the operation until it is done.

import { z } from "zod";
import { ColorKeySchema, IconKeySchema, Id, IsoDate, Name, Timestamp } from "./common.js";
import { Blz, ConnectorAccountCapabilities, ConnectorChallenge } from "./connector.js";

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

export const BankLoginStatus = z.enum(["setup", "ready", "credentials_lost", "pin_wrong", "error"]);

export const BankLogin = z.object({
    id: Id,
    loginHint: z.string(),
    status: BankLoginStatus,
    tanMethod: z.object({ id: z.string(), name: z.string() }).nullable(),
    tanMedium: z.string().nullable(),
    savePin: z.boolean(),
    lastSyncAt: Timestamp.nullable(),
    lastError: z.string().nullable(),
});
export type BankLogin = z.infer<typeof BankLogin>;

export const BankConnection = z.object({
    id: Id,
    name: z.string(),
    bankName: z.string(),
    blz: z.string(),
    bic: z.string().nullable(),
    fintsUrl: z.string(),
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

export const BankOperationParam = z.object({ id: z.string().uuid() });
export const BankTanRequest = z.object({ tan: z.string().trim().min(1).max(64) });

export const ConnectorStatus = z.object({ name: z.string(), reachable: z.boolean(), version: z.string().nullable(), productConfigured: z.boolean() });

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
    /** The run fetches only standing orders and scheduled transfers. */
    ordersOnly: z.boolean(),
    /** Set when bookings arrived but the orders could not be fetched; the run still counts as done. */
    ordersMessage: z.string().nullable(),
    /** Error code ("pin_required", "pin_wrong", "bank_error", …) and text, if the run failed. */
    error: z.string().nullable(),
    message: z.string().nullable(),
    startedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
});
export type SyncRun = z.infer<typeof SyncRun>;

export const SyncRunParam = z.object({ id: z.string().uuid() });
