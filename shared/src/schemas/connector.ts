// Schemas of the connector API (server ↔ connector over a Unix socket). The connector is
// stateless: the server sends bank, login and the opaque state with every call and stores the
// state the connector returns. Amounts in cents, dates as JJJJ-MM-TT.

import { z } from "zod";
import { Cents, IsoDate } from "./common.js";
import { SEPA_NAME_MAX, SEPA_REMITTANCE_MAX, TRANSFER_MAX_CENTS } from "../sepa.js";

export const Blz = z.string().regex(/^\d{8}$/, "Bankleitzahl mit 8 Ziffern");

/** The bank: shared by all users (bank_connections). */
export const ConnectorBank = z.object({
    blz: Blz,
    /** FinTS address of the bank (HTTPS). */
    url: z.string().url().startsWith("https://"),
});
export type ConnectorBank = z.infer<typeof ConnectorBank>;

/** A user's bank login (bank_logins), unsealed by the server for this call only. */
export const ConnectorLogin = z.object({
    userId: z.string().trim().min(1).max(30),
    /** Kunden-ID, only if the bank gave one that differs from the login name. */
    customerId: z.string().trim().max(30).optional(),
    pin: z.string().min(1).max(64),
    /** Opaque state from the previous call; absent at the first call. */
    state: z.string().max(2_000_000).optional(),
    /** Chosen TAN method (id from /v1/tan-methods); absent until chosen. */
    tanMethod: z.string().regex(/^9\d\d$/).optional(),
    /** Chosen TAN medium (name from /v1/tan-media), if the method needs one. */
    tanMedium: z.string().max(32).optional(),
});
export type ConnectorLogin = z.infer<typeof ConnectorLogin>;

export const ConnectorRequest = z.object({ bank: ConnectorBank, login: ConnectorLogin });

/** Identifies an account of a login; as the connector reported it in /v1/accounts. */
export const ConnectorAccountRef = z.object({
    accountNumber: z.string().min(1).max(35),
    subAccount: z.string().max(30).default(""),
    iban: z.string().max(34).nullable().default(null),
    bic: z.string().max(11).nullable().default(null),
});
export type ConnectorAccountRef = z.infer<typeof ConnectorAccountRef>;

export const ConnectorAccountKind = z.enum(["giro", "savings", "credit_card", "loan", "depot", "other"]);

/** How far ahead an order must and may be given, in calendar days (Data Dictionary „Vorlaufzeit“). */
export const OrderLeadTime = z.object({ minDays: z.number().int().min(0), maxDays: z.number().int().min(0) });
export type OrderLeadTime = z.infer<typeof OrderLeadTime>;

/** What the bank allows for the rhythm of a standing order (HICDES, HICDNS). */
export const StandingOrderRules = OrderLeadTime.extend({
    /** Allowed "every n months"; empty if the bank offers no monthly rhythm. */
    months: z.array(z.number().int()),
    /** Allowed days of the month: 1–30, 97–99 counted from the end. */
    monthDays: z.array(z.number().int()),
    /** Allowed "every n weeks"; empty if the bank offers no weekly rhythm. */
    weeks: z.array(z.number().int()),
    /** Allowed weekdays, 1 (Monday) – 7. */
    weekDays: z.array(z.number().int()),
});
export type StandingOrderRules = z.infer<typeof StandingOrderRules>;

/** Which parts of a standing order a change may touch (HICDNS). */
export const StandingOrderChangeable = z.object({
    /** IBAN and BIC of the payee. */
    payeeAccount: z.boolean(),
    payeeName: z.boolean(),
    amount: z.boolean(),
    remittance: z.boolean(),
    firstDate: z.boolean(),
    unit: z.boolean(),
    every: z.boolean(),
    executionDay: z.boolean(),
    lastDate: z.boolean(),
});
export type StandingOrderChangeable = z.infer<typeof StandingOrderChangeable>;

/** The bank's rules for writing orders; null where it does not offer the business transaction. */
export const ConnectorOrderRules = z.object({
    /** HKCSE */
    scheduled: OrderLeadTime.nullable(),
    /** HKCSA */
    scheduledChange: OrderLeadTime.nullable(),
    /** HKCDE */
    standing: StandingOrderRules.nullable(),
    /** HKCDN */
    standingChange: StandingOrderRules.extend({ changeable: StandingOrderChangeable }).nullable(),
});
export type ConnectorOrderRules = z.infer<typeof ConnectorOrderRules>;

export const ConnectorAccountCapabilities = z.object({
    balance: z.boolean(),
    transactions: z.boolean(),
    cardTransactions: z.boolean(),
    transfer: z.boolean(),
    instantTransfer: z.boolean(),
    /** The standing orders of the account can be listed (HKCDB). */
    standingOrders: z.boolean(),
    /** The scheduled transfers of the account can be listed (HKCSB). */
    scheduledTransfers: z.boolean(),
    /** Listing them needs an approval every time (HIPINS); such lists are not fetched along with the bookings. */
    standingOrdersTan: z.boolean().default(false),
    scheduledTransfersTan: z.boolean().default(false),
    /** The bank checks the payee's name before a transfer (verification of payee). */
    payeeVerification: z.boolean().default(false),
    /** Writing orders (HKCSE, HKCSA, HKCSL, HKCDE, HKCDN, HKCDL); older connectors leave them out. */
    createScheduledTransfer: z.boolean().default(false),
    changeScheduledTransfer: z.boolean().default(false),
    deleteScheduledTransfer: z.boolean().default(false),
    createStandingOrder: z.boolean().default(false),
    changeStandingOrder: z.boolean().default(false),
    deleteStandingOrder: z.boolean().default(false),
    /** The bank's rules for writing orders; null if it offers none of it. */
    orderRules: ConnectorOrderRules.nullable().default(null),
});
export type ConnectorAccountCapabilities = z.infer<typeof ConnectorAccountCapabilities>;

export const ConnectorAccount = ConnectorAccountRef.extend({
    /** Stable key per bank access: IBAN, else account number and sub-account. */
    externalId: z.string(),
    name: z.string(),
    owner: z.string(),
    currency: z.string(),
    kind: ConnectorAccountKind,
    capabilities: ConnectorAccountCapabilities,
});
export type ConnectorAccount = z.infer<typeof ConnectorAccount>;

export const ConnectorBalance = z.object({
    externalId: z.string(),
    booked: Cents,
    currency: z.string(),
    /** Date of the booked balance. */
    date: IsoDate.nullable(),
    pending: Cents.nullable(),
    available: Cents.nullable(),
    creditLine: Cents.nullable(),
});
export type ConnectorBalance = z.infer<typeof ConnectorBalance>;

export const ConnectorTransaction = z.object({
    bookingDate: IsoDate,
    valueDate: IsoDate.nullable(),
    /** Signed: negative = debit. */
    amount: Cents,
    currency: z.string(),
    status: z.enum(["booked", "pending"]),
    counterpartyName: z.string(),
    /**
     * Ultimate creditor of a debit or ultimate debtor of a credit, e.g. the shop of a card payment
     * whose counterparty is the bank that processes it; "" if none. Older connectors leave it out.
     */
    ultimateParty: z.string().default(""),
    counterpartyIban: z.string().nullable(),
    counterpartyBic: z.string().nullable(),
    /** Account of the counterparty when the bank names no IBAN; "" if none. Older connectors leave it out. */
    counterpartyAccount: z.string().default(""),
    /** National bank code that goes with `counterpartyAccount`; "" if none. Older connectors leave it out. */
    counterpartyBankCode: z.string().default(""),
    remittance: z.string(),
    endToEndId: z.string().nullable(),
    /** Customer reference (KREF) the payer gave the order, if the bank sends it. Older connectors leave it out. */
    customerReference: z.string().nullable().default(null),
    mandateId: z.string().nullable(),
    creditorId: z.string().nullable(),
    /** Booking text of the bank, e.g. "Lastschrift", "Kartenzahlung". */
    bookingText: z.string(),
    /** Reference of the bank for this booking, if it sends one. */
    bankReference: z.string().nullable(),
    /** Gives back an earlier booking (return debit, cancellation). Older connectors leave it out. */
    isReturn: z.boolean().default(false),
    /** Reason code of the return as the bank sends it; "" if none. Older connectors leave it out. */
    returnReason: z.string().default(""),
    /**
     * For a batch booking: the values of its first item, which earlier versions stored as the whole
     * booking. They give its old fingerprint, so that the stored booking is corrected, not doubled.
     */
    replaces: z.object({ counterpartyIban: z.string().nullable(), remittance: z.string(), endToEndId: z.string().nullable() }).nullable().default(null),
});
export type ConnectorTransaction = z.infer<typeof ConnectorTransaction>;

/** What standing orders and scheduled transfers share: the payment as the bank holds it. */
const ConnectorOrderBase = z.object({
    /** Order identification of the bank; null if it gave none. */
    bankOrderId: z.string().nullable(),
    payeeName: z.string(),
    payeeIban: z.string(),
    payeeBic: z.string().nullable(),
    /** Not negative; an order is always a debit. */
    amount: Cents,
    currency: z.string(),
    remittance: z.string(),
    endToEndId: z.string().nullable(),
    /** Whether the bank lets the order be changed or deleted; null if it does not say. */
    canChange: z.boolean().nullable(),
    canDelete: z.boolean().nullable(),
});

export const OrderUnit = z.enum(["month", "week"]);
export type OrderUnit = z.infer<typeof OrderUnit>;

/**
 * Day of execution: with unit "month" the day of the month (1–30) or 97, 98, 99 for two days
 * before, one day before and the last day of the month; with unit "week" 1 (Monday) to 7.
 */
export const OrderExecutionDay = z.number().int().min(1).max(99);

export const ConnectorStandingOrder = ConnectorOrderBase.extend({
    firstDate: IsoDate,
    unit: OrderUnit,
    /** Every n months or weeks. */
    every: z.number().int().min(1).max(52),
    executionDay: OrderExecutionDay,
    lastDate: IsoDate.nullable(),
});
export type ConnectorStandingOrder = z.infer<typeof ConnectorStandingOrder>;

export const ConnectorScheduledTransfer = ConnectorOrderBase.extend({ executionDate: IsoDate });
export type ConnectorScheduledTransfer = z.infer<typeof ConnectorScheduledTransfer>;

export const ConnectorTanMethod = z.object({
    id: z.string(),
    name: z.string(),
    /** Approval in an app instead of a TAN. */
    decoupled: z.boolean(),
    /** The method needs a TAN medium (see /v1/tan-media). */
    needsMedium: z.boolean(),
});

export const ConnectorTanMedium = z.object({ name: z.string(), active: z.boolean() });

export const ConnectorChallenge = z.object({
    decoupled: z.boolean(),
    /** The bank's instructions, to be shown unchanged. */
    text: z.string(),
    medium: z.string(),
    validUntil: z.string(),
    methodName: z.string(),
});
export type ConnectorChallenge = z.infer<typeof ConnectorChallenge>;

/**
 * Result of the verification of payee: match (RCVC), close match (RVMC), no match (RVNM), not
 * applicable (RVNA), still pending (PDNG); "none" when the bank did not check the name.
 */
export const VopResult = z.enum(["match", "close_match", "no_match", "not_applicable", "pending", "none"]);
export type VopResult = z.infer<typeof VopResult>;

export const ConnectorVop = z.object({
    result: VopResult,
    /** The name the payee's bank holds, on a close match. */
    payeeName: z.string().nullable(),
    /** Why the check was not applicable, as the bank put it. */
    reason: z.string().nullable(),
    /** The bank's explanation, to be shown to the user before any approval; "" if none. */
    explanation: z.string(),
    /** The explanation may carry the markup of the VoP specification (<p>, <br>, <b>, <ul>, …). */
    structured: z.boolean(),
});
export type ConnectorVop = z.infer<typeof ConnectorVop>;

const doneOutcome = <T extends z.ZodType>(data: T) => z.object({ status: z.literal("done"), data, state: z.string() });
const approvalOutcome = z.object({
    status: z.literal("approval"),
    operationId: z.string(),
    challenge: ConnectorChallenge,
    /** Payments: the result of the verification of payee, shown next to the approval. */
    vop: ConnectorVop.optional(),
});

/** Answer of every call that talks to the bank: done, or waiting for an approval. */
export const outcome = <T extends z.ZodType>(data: T) => z.discriminatedUnion("status", [doneOutcome(data), approvalOutcome]);

/**
 * Answer of a payment: additionally "confirm" when the name of the payee differs (or could not
 * be checked) and the user has to confirm before the bank asks for the approval.
 */
export const paymentOutcome = <T extends z.ZodType>(data: T) =>
    z.discriminatedUnion("status", [doneOutcome(data), approvalOutcome, z.object({ status: z.literal("confirm"), operationId: z.string(), vop: ConnectorVop })]);

export const AnyOutcomeData = z.unknown();

// ---------- Requests and data ----------

export const BankCheckRequest = z.object({ bank: ConnectorBank });
export const BankCheckResponse = z.object({
    bankName: z.string(),
    bpdVersion: z.number().int(),
    pinTan: z.boolean(),
    /** Business transactions the bank offers, e.g. "HKCAZ", "HKKKU". */
    jobs: z.array(z.string()),
});

export const TanMethodsData = z.object({ methods: z.array(ConnectorTanMethod) });
export const TanMediaData = z.object({ media: z.array(ConnectorTanMedium) });
export const AccountsData = z.object({ accounts: z.array(ConnectorAccount) });

export const BalancesRequest = ConnectorRequest.extend({ accounts: z.array(ConnectorAccountRef).min(1).max(100) });
export const BalancesData = z.object({ balances: z.array(ConnectorBalance) });

export const TransactionsRequest = ConnectorRequest.extend({
    account: ConnectorAccountRef,
    from: IsoDate.optional(),
    to: IsoDate.optional(),
});
export const TransactionsData = z.object({ transactions: z.array(ConnectorTransaction) });

export const CardTransactionsData = z.object({
    transactions: z.array(ConnectorTransaction),
    balance: ConnectorBalance.nullable(),
});

export const OrdersRequest = ConnectorRequest.extend({ account: ConnectorAccountRef });
export const StandingOrdersData = z.object({ orders: z.array(ConnectorStandingOrder) });
export const ScheduledTransfersData = z.object({ orders: z.array(ConnectorScheduledTransfer) });

/** One SEPA credit transfer as the connector sends it; the server has checked it already. */
export const ConnectorTransfer = z.object({
    payeeName: z.string().trim().min(1).max(SEPA_NAME_MAX),
    payeeIban: z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/),
    payeeBic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/).nullable(),
    amount: Cents.refine((c) => c > 0 && c <= TRANSFER_MAX_CENTS, "Betrag außerhalb der Grenzen"),
    remittance: z.string().max(SEPA_REMITTANCE_MAX),
    endToEndId: z.string().regex(/^[A-Za-z0-9/?:().,'+\- ]{1,35}$/),
    /** Instant credit transfer (HKIPZ) instead of a standard one (HKCCS). */
    instant: z.boolean(),
});
export type ConnectorTransfer = z.infer<typeof ConnectorTransfer>;

export const TransferRequest = ConnectorRequest.extend({ account: ConnectorAccountRef, transfer: ConnectorTransfer });

export const TransferData = z.object({
    /** What the bank said about the order (e.g. "Auftrag ausgeführt"). */
    bankMessage: z.string(),
    /** Processing reference of the bank (return code 3070), if it gave one. */
    reference: z.string().nullable(),
    vop: ConnectorVop,
    /** Instant transfers: the bank has not yet confirmed that the money arrived (3045/3046). */
    unconfirmed: z.boolean(),
    /** Instant transfers: the bank turned it into a standard transfer (3270). */
    converted: z.boolean(),
});
export type TransferData = z.infer<typeof TransferData>;

// ---------- Writing orders ----------

/** The payment of an order as the connector sends it; the server has checked it already. */
export const ConnectorOrderPayment = ConnectorTransfer.omit({ instant: true });
export type ConnectorOrderPayment = z.infer<typeof ConnectorOrderPayment>;

/** The rhythm of a standing order, as in the Dauerauftragdetails. */
export const ConnectorRecurrence = z.object({
    firstDate: IsoDate,
    unit: OrderUnit,
    every: z.number().int().min(1).max(99),
    executionDay: OrderExecutionDay,
    lastDate: IsoDate.nullable(),
});
export type ConnectorRecurrence = z.infer<typeof ConnectorRecurrence>;

export const ScheduledTransferWrite = ConnectorOrderPayment.extend({ executionDate: IsoDate });
export type ScheduledTransferWrite = z.infer<typeof ScheduledTransferWrite>;
export const StandingOrderWrite = ConnectorOrderPayment.extend({ recurrence: ConnectorRecurrence });
export type StandingOrderWrite = z.infer<typeof StandingOrderWrite>;

/**
 * The order as the user saw it. Before a change or deletion the connector fetches the bank's
 * current list and goes on only if the order is still the same.
 */
export const ExpectedScheduledTransfer = ConnectorScheduledTransfer.pick({ bankOrderId: true, payeeName: true, payeeIban: true, amount: true, remittance: true, executionDate: true }).extend({ bankOrderId: z.string().min(1) });
export type ExpectedScheduledTransfer = z.infer<typeof ExpectedScheduledTransfer>;
export const ExpectedStandingOrder = ConnectorStandingOrder.pick({ bankOrderId: true, payeeName: true, payeeIban: true, amount: true, remittance: true, firstDate: true, unit: true, every: true, executionDay: true, lastDate: true }).extend({ bankOrderId: z.string().min(1) });
export type ExpectedStandingOrder = z.infer<typeof ExpectedStandingOrder>;

export const CreateScheduledTransferRequest = ConnectorRequest.extend({ account: ConnectorAccountRef, order: ScheduledTransferWrite });
export const ChangeScheduledTransferRequest = ConnectorRequest.extend({ account: ConnectorAccountRef, expected: ExpectedScheduledTransfer, order: ScheduledTransferWrite });
export const DeleteScheduledTransferRequest = ConnectorRequest.extend({ account: ConnectorAccountRef, expected: ExpectedScheduledTransfer });
export const CreateStandingOrderRequest = ConnectorRequest.extend({ account: ConnectorAccountRef, order: StandingOrderWrite });
export const ChangeStandingOrderRequest = ConnectorRequest.extend({ account: ConnectorAccountRef, expected: ExpectedStandingOrder, order: StandingOrderWrite });
export const DeleteStandingOrderRequest = ConnectorRequest.extend({ account: ConnectorAccountRef, expected: ExpectedStandingOrder });

export const OrderWriteData = z.object({
    /** What the bank said about the order (e.g. "Auftrag zur Ausführung vorgemerkt"). */
    bankMessage: z.string(),
    /** Processing reference of the bank (return code 3070), if it gave one. */
    reference: z.string().nullable(),
    /** The order identification the bank gave the new or changed order; null if it gave none. */
    bankOrderId: z.string().nullable(),
    /** "none" for deletions and where the bank does not check the name. */
    vop: ConnectorVop,
});
export type OrderWriteData = z.infer<typeof OrderWriteData>;

export const TanRequest = z.object({ tan: z.string().trim().min(1).max(64) });
export const OperationParam = z.object({ id: z.string().uuid() });

export const ConnectorInfo = z.object({
    name: z.string(),
    version: z.string(),
    /** False while no FinTS product ID is configured: the connector then refuses to contact banks. */
    productConfigured: z.boolean(),
    capabilities: z.array(z.enum(["accounts", "balances", "transactions", "card-transactions", "tan-media", "standing-orders", "scheduled-transfers", "transfers", "order-writes"])),
});

export const ConnectorErrorCode = z.enum([
    "invalid", // request does not match the contract
    "pin_wrong", // wrong PIN or access blocked; do not retry with the same PIN
    "bank_error", // the bank refused; see bankCodes
    "unreachable", // network error
    "timeout", // the bank did not answer in time
    "bank_answer_invalid", // the bank's answer could not be read
    "no_tan_method", // no TAN method chosen or not offered
    "not_supported", // the bank or account does not offer this
    "operation_unknown", // unknown or expired operation
    "product_id_missing", // connector has no FinTS product ID
    "outcome_unknown", // a payment was sent, but the bank's answer was lost: it may or may not have been executed
    "order_changed", // the order to change or delete is no longer as expected at the bank; nothing was sent
    "internal",
]);

export const ConnectorError = z.object({
    error: ConnectorErrorCode,
    message: z.string(),
    bankCodes: z.array(z.object({ code: z.string(), text: z.string() })).optional(),
});
export type ConnectorError = z.infer<typeof ConnectorError>;
