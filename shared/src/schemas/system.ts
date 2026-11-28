import { z } from "zod";
import { Id, Name, Timestamp } from "./common.js";
import { ConnectorStatus } from "./bankaccess.js";
import { Theme } from "./profile.js";

/**
 * setup:  no key store yet, the installation has to be set up with its first user
 * locked: key store exists, the database waits for a user's password
 * ready:  database open
 */
export const ServerState = z.enum(["setup", "locked", "ready"]);
export type ServerState = z.infer<typeof ServerState>;

export const StatusResponse = z.object({
    state: ServerState,
    version: z.string(),
    /** Build of the web client the server delivers (null without one); a window with another reloads. */
    webBuild: z.string().nullable(),
    /** Appearance of the web client before sign-in (start value from the server's configuration). */
    webTheme: Theme,
});
export type StatusResponse = z.infer<typeof StatusResponse>;

/** Versions of all modules of this installation, for signed-in users only. */
export const VersionsResponse = z.object({
    server: z.string(),
    /** Build of the web client the server delivers (null without one). */
    webBuild: z.string().nullable(),
    /** The configured connectors; one that is not configured is missing. */
    connectors: z.array(ConnectorStatus),
    node: z.string(),
    sqlite: z.string(),
    /** Version of SQLite3 Multiple Ciphers, which encrypts the database. */
    sqliteCiphers: z.string(),
    /** Last applied migration of the database, e.g. "0017-booking-edits". */
    schema: z.string().nullable(),
});
export type VersionsResponse = z.infer<typeof VersionsResponse>;

/** A user's password also wraps the key of the database, so it has to be long. */
export const Password = z.string().min(12, "Mindestens 12 Zeichen").max(1024);

/** A new TOTP secret to scan; `setupToken` confirms it with the first code. */
export const TotpSetup = z.object({ setupToken: z.string(), secret: z.string(), uri: z.string() });

export const SetupRequest = z.object({
    name: Name,
    password: Password,
    defaultCategories: z.boolean().default(true).describe("Create the start tree of categories"),
    defaultAccountGroups: z.boolean().default(true).describe("Create the start tree of account groups"),
});
export const SetupResponse = z.object({
    recoveryKey: z.string().describe("Shown once; opens the database when a password is lost"),
    totp: TotpSetup.describe("The first user's second factor, confirmed with `confirmTotp`"),
});

/** A code from the authenticator app. */
export const TotpCode = z.string().regex(/^\d{6}$/, "6 Ziffern");

const RecoveryKey = z.string().min(1).max(200);

/** Password lost: the recovery key opens the database and sets a new password for the user. */
export const RecoverRequest = z.object({
    recoveryKey: RecoveryKey,
    name: z.string().trim().min(1),
    password: Password,
    resetTotp: z.boolean().default(false).describe("The phone is lost as well: answer with a new TOTP secret to confirm"),
});
export const RecoverResponse = z.object({
    ok: z.literal(true),
    totp: TotpSetup.optional().describe("With `resetTotp`; confirmed with `confirmTotp`. Until then the old secret stays valid"),
});

/** Phone lost, password known: password and recovery key together allow a new TOTP secret. */
export const RecoverTotpRequest = z.object({
    recoveryKey: RecoveryKey,
    name: z.string().trim().min(1),
    password: z.string().min(1).max(1024),
});

export const NewRecoveryKeyRequest = z.object({ password: z.string().min(1), code: TotpCode.describe("Code of the signed-in user") });

/** Changing the own second factor: the password, and the current code or, without the phone, the recovery key. */
export const StartTotpChangeRequest = z.union([
    z.object({ password: z.string().min(1).max(1024), code: TotpCode }),
    z.object({ password: z.string().min(1).max(1024), recoveryKey: RecoveryKey }),
]);
export const ConfirmTotpChangeRequest = z.object({ setupToken: z.string().min(1), code: TotpCode.describe("First code of the new secret") });

/** Confirms a sensitive step with the signed-in user's current code from the authenticator app. */
export const ConfirmCodeRequest = z.object({ code: TotpCode });
/** Confirms a step with the signed-in user's password. */
export const ConfirmPasswordRequest = z.object({ password: z.string().min(1).max(512) });
export const RecoveryKeyResponse = z.object({ recoveryKey: z.string().describe("Shown once") });

// ---------- Users and sign-in ----------

export const Me = z.object({
    id: Id,
    name: z.string(),
    deviceId: Id,
    /** Locked after inactivity: the client shows only the password prompt. */
    sessionLocked: z.boolean(),
    /** Minutes without input until the session locks (from config.yaml); 0 = never. */
    sessionIdleMinutes: z.number().int().min(0),
});
export type Me = z.infer<typeof Me>;

export const LoginRequest = z.object({
    name: z.string().trim().min(1),
    password: z.string().min(1),
    code: TotpCode.optional(),
    client: z.enum(["web", "macos"]).default("web"),
    deviceName: z.string().trim().max(80).optional(),
});

/**
 * ok:            signed in (web: session cookie is set; macOS: token in the answer), or the
 *                existing session of this user goes on (no code needed, no new cookie)
 * code_required: password right, the TOTP code is missing; a locked server stays locked
 * totp_setup:    password right, the user has no TOTP yet: scan the secret, then confirm
 */
export const LoginResponse = z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), user: Me, token: z.string().optional() }),
    z.object({ status: z.literal("code_required") }),
    TotpSetup.extend({ status: z.literal("totp_setup") }),
]);

export const TotpConfirmRequest = z.object({
    setupToken: z.string().min(1),
    code: TotpCode,
    client: z.enum(["web", "macos"]).default("web"),
    deviceName: z.string().trim().max(80).optional(),
});

export const User = z.object({
    id: Id,
    name: z.string(),
    totpActive: z.boolean(),
    createdAt: Timestamp,
    lastLoginAt: Timestamp.nullable(),
});
export type User = z.infer<typeof User>;

export const CreateUserRequest = z.object({ name: Name, password: Password, code: TotpCode.describe("Code of the signed-in user") });
export const ChangePasswordRequest = z.object({ current: z.string().min(1), next: Password, code: TotpCode.describe("Code of the signed-in user") });
export const SetPasswordRequest = z.object({ password: Password, code: TotpCode.describe("Code of the signed-in user") });

export const Device = z.object({
    id: Id,
    userId: Id,
    name: z.string(),
    kind: z.enum(["web", "device"]),
    createdAt: Timestamp,
    lastSeenAt: Timestamp.nullable(),
    current: z.boolean(),
});
export type Device = z.infer<typeof Device>;

export const CreateDeviceRequest = z.object({ name: Name, code: TotpCode.describe("Code of the signed-in user") });
export const CreateDeviceResponse = z.object({ device: Device, token: z.string().describe("Shown once") });

export const ActivityEntry = z.object({
    id: Id,
    createdAt: Timestamp,
    userId: Id.nullable(),
    userName: z.string().nullable(),
    action: z.string(),
    target: z.string().nullable(),
    details: z.string().nullable(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;
export const ActivityQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
