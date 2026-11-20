// Orders the bank holds for an account: standing orders and scheduled transfers. MBM only shows
// what the last fetch brought; the bank is the source.

import { z } from "zod";
import { Cents, Id, IsoDate, Timestamp } from "./common.js";
import { OrderExecutionDay, OrderUnit } from "./connector.js";
import { AccountScope } from "./profile.js";

const OrderBase = z.object({
    id: Id,
    accountId: Id,
    payeeName: z.string(),
    payeeIban: z.string(),
    payeeBic: z.string().nullable(),
    /** Not negative; an order is always a debit of its account. */
    amount: Cents,
    remittance: z.string(),
    /** The payee is another account in MBM: the order moves money between own accounts. */
    payeeAccountId: Id.nullable(),
    /** Next date the order runs, today included; null if it has ended. */
    nextDate: IsoDate.nullable(),
    /** Whether the bank lets it be changed or deleted; null if it does not say. */
    canChange: z.boolean().nullable(),
    canDelete: z.boolean().nullable(),
    fetchedAt: Timestamp,
});

export const StandingOrder = OrderBase.extend({
    kind: z.literal("standing"),
    unit: OrderUnit,
    every: z.number().int(),
    executionDay: OrderExecutionDay,
    firstDate: IsoDate,
    lastDate: IsoDate.nullable(),
});
export type StandingOrder = z.infer<typeof StandingOrder>;

export const ScheduledTransfer = OrderBase.extend({ kind: z.literal("scheduled"), executionDate: IsoDate });
export type ScheduledTransfer = z.infer<typeof ScheduledTransfer>;

export const Order = z.discriminatedUnion("kind", [StandingOrder, ScheduledTransfer]);
export type Order = z.infer<typeof Order>;

/** What the signed-in user's login may do with the orders of a bank account. */
export const OrderAccount = z.object({
    accountId: Id,
    standingOrders: z.boolean(),
    scheduledTransfers: z.boolean(),
    /** The bank asks for an approval every time: orders come only with "Aufträge abrufen". */
    needsApproval: z.boolean(),
    /** Last successful fetch of the orders; null if never. */
    fetchedAt: Timestamp.nullable(),
});
export type OrderAccount = z.infer<typeof OrderAccount>;

export const OrdersQuery = z.object({ scope: AccountScope.default("all") });
export const OrdersResponse = z.object({
    orders: z.array(Order),
    /** The bank accounts in scope whose orders the user can fetch. */
    accounts: z.array(OrderAccount),
});

export const UpcomingQuery = z.object({
    scope: AccountScope.default("all"),
    days: z.coerce.number().int().min(1).max(366).default(30),
    count: z.coerce.number().int().min(1).max(200).default(20),
});
/** One run of an order on one day. */
export const UpcomingOrder = z.object({
    date: IsoDate,
    orderId: Id,
    kind: z.enum(["standing", "scheduled"]),
    accountId: Id,
    payeeName: z.string(),
    remittance: z.string(),
    amount: Cents,
    payeeAccountId: Id.nullable(),
});
export type UpcomingOrder = z.infer<typeof UpcomingOrder>;
export const UpcomingResponse = z.object({ items: z.array(UpcomingOrder) });
