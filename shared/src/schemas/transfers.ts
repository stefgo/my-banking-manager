// Transfers: submitted from the own bank login, with verification of payee and approval. The
// server keeps the state and the history; the list of payees is shared by all users.

import { z } from "zod";
import { Cents, Id, Timestamp } from "./common.js";
import { ConnectorChallenge, ConnectorVop } from "./connector.js";
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

export const CreateTransferRequest = z.object({
    /** Chosen by the client once per form: sending it twice gives the same transfer. */
    requestId: z.string().uuid(),
    accountId: Id,
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
    instant: z.boolean().default(false),
    /** The PIN, if the login does not store it; used for this transfer only. */
    pin: z.string().min(1).max(64).optional(),
});

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

