import { z } from "zod";
import { SyncRun } from "./schemas/bankaccess.js";

/** What a change touched; a client refetches what it shows of these. */
export const Topic = z.enum([
    "accounts",
    "groups",
    "transactions",
    "categories",
    "rules",
    "imports",
    "users",
    "devices",
    "activity",
    "connections",
    "orders",
    "transfers",
    "payees",
    "bankDirectory",
    /** Which bookings are new for a user. */
    "unread",
]);
export type Topic = z.infer<typeof Topic>;

/** Messages on the WebSocket `/api/events`, server → client only. */
export const ServerEvent = z.discriminatedUnion("type", [
    z.object({ type: z.literal("changed"), topics: z.array(Topic) }),
    /** The profile of the signed-in user changed on another device. */
    z.object({ type: z.literal("profile") }),
    /** The server was locked; every client shows the unlock screen. */
    z.object({ type: z.literal("locked") }),
    /** This session was signed out (device removed, user deleted). */
    z.object({ type: z.literal("signed_out") }),
    /** This session was locked after inactivity; the password unlocks it. */
    z.object({ type: z.literal("session_locked") }),
    /** Fetch runs of this user changed (progress, approval needed, done). */
    z.object({ type: z.literal("sync"), runs: z.array(SyncRun) }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Messages on the WebSocket `/api/events`, client → server. */
export const ClientEvent = z.discriminatedUnion("type", [
    /** The user gave input (key, click, scroll …); sent at most once a minute. */
    z.object({ type: z.literal("active") }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;
