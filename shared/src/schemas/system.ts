import { z } from "zod";
import { Id, Name, Timestamp } from "./common.js";
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
    /** Appearance of the web client before sign-in (start value from the server's configuration). */
    webTheme: Theme,
});
export type StatusResponse = z.infer<typeof StatusResponse>;

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

/** Password lost: the recovery key opens the database and sets a new password for the user. */
export const RecoverRequest = z.object({
    recoveryKey: z.string().min(1),
    name: z.string().trim().min(1),
    password: Password,
});

export const NewRecoveryKeyRequest = z.object({ password: z.string().min(1) });

/** A code from the authenticator app. */
export const TotpCode = z.string().regex(/^\d{6}$/, "6 Ziffern");

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
export const ChangePasswordRequest = z.object({ current: z.string().min(1), next: Password });
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
