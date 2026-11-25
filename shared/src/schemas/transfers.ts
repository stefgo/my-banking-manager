// Transfers: submitted from the own bank login, with verification of payee and approval. The
// server keeps the state and the history; the list of payees is shared by all users.

import { z } from "zod";
import { Cents, Id, IsoDate, Timestamp } from "./common.js";
import { ConnectorChallenge, ConnectorOrderRules, ConnectorRecurrence, ConnectorVop } from "./connector.js";
import { cleanIban, ibanProblem } from "../iban.js";
import { BIC_PATTERN, SEPA_NAME_MAX, SEPA_REMITTANCE_MAX, TRANSFER_MAX_CENTS, sepaCharsMessage } from "../sepa.js";

/**
 * submitting            on its way to the bank
 * awaiting_vop_confirm  the payee's name differs (or could not be checked): waits for the user
 * awaiting_tan          waits for the approval (app or TAN)
 * executed              accepted by the bank
 * rejected              refused by the bank
 * failed                never reached the bank
 * cancelled             cancelled by the user (or ran out before the confirmation)
 * unknown               sent, but the bank's answer was lost: check the bookings
 */
export const TransferStatus = z.enum(["submitting", "awaiting_vop_confirm", "awaiting_tan", "executed", "rejected", "failed", "cancelled", "unknown"]);
export type TransferStatus = z.infer<typeof TransferStatus>;

/**
 * What a transfer does at the bank: `now` a transfer (or instant transfer), `date` a scheduled
 * transfer, `standing` a standing order; `action` creates, changes or deletes the order.
 */
export const TransferExecution = z.enum(["now", "date", "standing"]);
export type TransferExecution = z.infer<typeof TransferExecution>;
export const TransferAction = z.enum(["create", "change", "delete"]);
export type TransferAction = z.infer<typeof TransferAction>;

/** An order as it was before a change or deletion, for "before → after". */
export const OrderSnapshot = z.object({
    bankOrderId: z.string(),
    payeeName: z.string(),
    payeeIban: z.string(),
    payeeBic: z.string().nullable(),
    amount: Cents,
    remittance: z.string(),
    executionDate: IsoDate.nullable(),
    recurrence: ConnectorRecurrence.nullable(),
});
export type OrderSnapshot = z.infer<typeof OrderSnapshot>;

export const Transfer = z.object({
    id: Id,
    accountId: Id,
    /** Name of the user who started it. */
    createdBy: z.string(),
    /** Started by the signed-in user: only they can confirm, approve or cancel it. */
    mine: z.boolean(),
    payeeName: z.string(),
    payeeIban: z.string(),
    payeeBic: z.string().nullable(),
    amount: Cents,
    remittance: z.string(),
    endToEndId: z.string(),
    instant: z.boolean(),
    execution: TransferExecution,
    action: TransferAction,
    /** `date`: the day of execution. */
    executionDate: IsoDate.nullable(),
    /** `standing`: the rhythm. */
    recurrence: ConnectorRecurrence.nullable(),
    /** The order a change or deletion refers to (row in the orders), if it still exists. */
    orderId: Id.nullable(),
    /** The bank's identification of the order: given for changes and deletions, reported for new ones. */
    bankOrderId: z.string().nullable(),
    /** Changes and deletions: the order as it was. */
    previous: OrderSnapshot.nullable(),
    status: TransferStatus,
    vop: ConnectorVop.nullable(),
    /** While it waits for the approval, for the user who started it. */
    challenge: ConnectorChallenge.nullable(),
    bankMessage: z.string().nullable(),
    bankReference: z.string().nullable(),
    /** Instant: the bank has not confirmed the arrival yet. */
    unconfirmed: z.boolean(),
    /** The booking a fetch brought for it (found by the end-to-end ID). */
    transactionId: Id.nullable(),
    createdAt: Timestamp,
    finishedAt: Timestamp.nullable(),
});
export type Transfer = z.infer<typeof Transfer>;

const text = (max: number, what: string) =>
    z
        .string()
        .trim()
        .max(max, `${what}: höchstens ${max} Zeichen`)
        .superRefine((s, ctx) => {
            const msg = sepaCharsMessage(s);
            if (msg) ctx.addIssue({ code: "custom", message: msg });
        });

const execution = {
    date: z.object({ kind: z.literal("date"), date: IsoDate }),
    standing: ConnectorRecurrence.extend({ kind: z.literal("standing") }),
};
export const TransferExecutionRequest = z.discriminatedUnion("kind", [z.object({ kind: z.literal("now") }), execution.date, execution.standing]);
export type TransferExecutionRequest = z.infer<typeof TransferExecutionRequest>;

const paymentFields = {
    payeeName: text(SEPA_NAME_MAX, "Empfänger").pipe(z.string().min(1, "Bitte den Empfänger eingeben")),
    payeeIban: z
        .string()
        .transform(cleanIban)
        .superRefine((s, ctx) => {
            const msg = ibanProblem(s);
            if (msg) ctx.addIssue({ code: "custom", message: msg });
        }),
    payeeBic: z.string().trim().toUpperCase().regex(BIC_PATTERN, "BIC mit 8 oder 11 Zeichen").nullable().default(null),
    amount: Cents.refine((c) => c > 0, "Der Betrag muss größer als 0 sein.").refine((c) => c <= TRANSFER_MAX_CENTS, "Der Betrag ist zu groß."),
    remittance: text(SEPA_REMITTANCE_MAX, "Verwendungszweck").default(""),
};

/** Chosen by the client once per form: sending it twice gives the same transfer. */
const requestId = z.string().uuid();
/** The PIN, if the login does not store it; used for this transfer only. */
const pin = z.string().min(1).max(64).optional();

export const CreateTransferRequest = z
    .object({
        requestId,
        accountId: Id,
        ...paymentFields,
        instant: z.boolean().default(false),
        /** Now (default), on a date, or as a standing order. */
        execution: TransferExecutionRequest.default({ kind: "now" }),
        pin,
    })
    .refine((r) => !r.instant || r.execution.kind === "now", { message: "Echtzeitüberweisungen gibt es nur sofort.", path: ["instant"] });

/** The complete order as it shall be after the change; its kind decides the execution. */
export const ChangeOrderRequest = z.object({
    requestId,
    ...paymentFields,
    execution: z.discriminatedUnion("kind", [execution.date, execution.standing]),
    pin,
});

export const DeleteOrderRequest = z.object({ requestId, pin });

export const OrderKind = z.enum(["standing", "scheduled"]);
export const OrderParam = z.object({ kind: OrderKind, id: z.coerce.number().int().positive() });

export const TransfersQuery = z.object({
    accountId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** An account the signed-in user can send transfers from. */
export const TransferAccount = z.object({
    id: Id,
    name: z.string(),
    iban: z.string().nullable(),
    connectionName: z.string(),
    instant: z.boolean(),
    /** The bank checks the payee's name. */
    payeeVerification: z.boolean(),
    /** The PIN is not stored: the form asks for it. */
    pinRequired: z.boolean(),
    /** Standard transfers (an account may allow only orders). */
    transfer: z.boolean(),
    /** Scheduled transfers and standing orders: what the bank allows from this account. */
    scheduled: z.boolean(),
    standing: z.boolean(),
    /** The bank's rules for them; null until the connector has reported them (next fetch). */
    orderRules: ConnectorOrderRules.nullable(),
});

export const TransferPayee = z.object({
    id: Id,
    name: z.string(),
    iban: z.string(),
    bic: z.string().nullable(),
    lastUsedAt: Timestamp.nullable(),
});
export type TransferPayee = z.infer<typeof TransferPayee>;

/** A counterparty of a debit booking with an IBAN that is not a payee yet. */
export const PayeeSuggestion = z.object({ name: z.string(), iban: z.string(), bic: z.string().nullable(), lastDate: z.string() });

export const PayeesResponse = z.object({ payees: z.array(TransferPayee), suggestions: z.array(PayeeSuggestion) });

