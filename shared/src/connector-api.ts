// The connector API as one list of routes. Connectors register their handlers against it, the
// server calls through it, and `npm run contracts` writes contracts/connector-api.yaml.
// Reachable only over a Unix socket that only server and connector mount.

import { z } from "zod";
import { Ok } from "./schemas/common.js";
import * as C from "./schemas/connector.js";
import type { Method } from "./api.js";

export interface ConnectorRouteDef {
    method: Method;
    path: string;
    summary: string;
    params?: z.ZodType;
    body?: z.ZodType;
    response: z.ZodType;
}

const r = <T extends ConnectorRouteDef>(def: T): T => def;

export const connectorRoutes = {
    info: r({ method: "GET", path: "/v1/info", summary: "Name, version and what the connector can do", response: C.ConnectorInfo }),
    checkBank: r({ method: "POST", path: "/v1/bank", summary: "Fetch the bank parameters without credentials (anonymous dialog)", body: C.BankCheckRequest, response: C.BankCheckResponse }),
    tanMethods: r({ method: "POST", path: "/v1/tan-methods", summary: "TAN methods the bank allows this login", body: C.ConnectorRequest, response: C.outcome(C.TanMethodsData) }),
    tanMedia: r({ method: "POST", path: "/v1/tan-media", summary: "Active TAN media of the login", body: C.ConnectorRequest, response: C.outcome(C.TanMediaData) }),
    accounts: r({ method: "POST", path: "/v1/accounts", summary: "Accounts the login reaches", body: C.ConnectorRequest, response: C.outcome(C.AccountsData) }),
    balances: r({ method: "POST", path: "/v1/balances", summary: "Balances of accounts", body: C.BalancesRequest, response: C.outcome(C.BalancesData) }),
    transactions: r({ method: "POST", path: "/v1/transactions", summary: "Transactions of an account, booked and pending", body: C.TransactionsRequest, response: C.outcome(C.TransactionsData) }),
    cardTransactions: r({ method: "POST", path: "/v1/card-transactions", summary: "Transactions of a credit card account", body: C.TransactionsRequest, response: C.outcome(C.CardTransactionsData) }),
    standingOrders: r({ method: "POST", path: "/v1/standing-orders/list", summary: "Standing orders of an account as the bank holds them", body: C.OrdersRequest, response: C.outcome(C.StandingOrdersData) }),
    scheduledTransfers: r({ method: "POST", path: "/v1/scheduled-transfers/list", summary: "Scheduled transfers of an account that are still to be executed", body: C.OrdersRequest, response: C.outcome(C.ScheduledTransfersData) }),
    transfer: r({ method: "POST", path: "/v1/transfers", summary: "Submit a SEPA credit transfer with verification of payee; never repeated on its own", body: C.TransferRequest, response: C.paymentOutcome(C.TransferData) }),
    createScheduledTransfer: r({ method: "POST", path: "/v1/scheduled-transfers/create", summary: "Submit a scheduled transfer (HKCSE) with verification of payee; never repeated on its own", body: C.CreateScheduledTransferRequest, response: C.paymentOutcome(C.OrderWriteData) }),
    changeScheduledTransfer: r({ method: "POST", path: "/v1/scheduled-transfers/change", summary: "Change a scheduled transfer (HKCSA) after checking it against the bank's current list", body: C.ChangeScheduledTransferRequest, response: C.paymentOutcome(C.OrderWriteData) }),
    deleteScheduledTransfer: r({ method: "POST", path: "/v1/scheduled-transfers/delete", summary: "Delete a scheduled transfer (HKCSL) after checking it against the bank's current list", body: C.DeleteScheduledTransferRequest, response: C.outcome(C.OrderWriteData) }),
    createStandingOrder: r({ method: "POST", path: "/v1/standing-orders/create", summary: "Set up a standing order (HKCDE) with verification of payee; never repeated on its own", body: C.CreateStandingOrderRequest, response: C.paymentOutcome(C.OrderWriteData) }),
    changeStandingOrder: r({ method: "POST", path: "/v1/standing-orders/change", summary: "Change a standing order (HKCDN) after checking it against the bank's current list", body: C.ChangeStandingOrderRequest, response: C.paymentOutcome(C.OrderWriteData) }),
    deleteStandingOrder: r({ method: "POST", path: "/v1/standing-orders/delete", summary: "Delete a standing order (HKCDL) after checking it against the bank's current list", body: C.DeleteStandingOrderRequest, response: C.outcome(C.OrderWriteData) }),
    operation: r({ method: "GET", path: "/v1/operations/:id", summary: "State of an operation waiting for an approval or a confirmation; queries the bank when due", params: C.OperationParam, response: C.paymentOutcome(C.AnyOutcomeData) }),
    operationTan: r({ method: "POST", path: "/v1/operations/:id/tan", summary: "Hand in the TAN of an operation", params: C.OperationParam, body: C.TanRequest, response: C.paymentOutcome(C.AnyOutcomeData) }),
    confirmOperation: r({ method: "POST", path: "/v1/operations/:id/confirm", summary: "Go on with a payment although the payee's name differs; the bank then asks for the approval", params: C.OperationParam, response: C.paymentOutcome(C.AnyOutcomeData) }),
    cancelOperation: r({ method: "DELETE", path: "/v1/operations/:id", summary: "Cancel an operation and end its dialog", params: C.OperationParam, response: Ok }),
    psd2Banks: r({ method: "POST", path: "/v1/psd2/banks", summary: "PSD2: banks of a country that Enable Banking offers; checks application ID and key on the way", body: C.Psd2BanksRequest, response: C.Psd2BanksData }),
    psd2Consent: r({ method: "POST", path: "/v1/psd2/consents", summary: "PSD2: start the approval at the bank; answers with the address to send the user's browser to", body: C.Psd2ConsentRequest, response: C.Psd2ConsentData }),
    psd2Session: r({ method: "POST", path: "/v1/psd2/sessions", summary: "PSD2: finish the approval with the code from the redirect; answers with the state for later calls", body: C.Psd2SessionRequest, response: C.Psd2SessionData }),
    psd2CloseSession: r({ method: "POST", path: "/v1/psd2/sessions/close", summary: "PSD2: end the session at Enable Banking; the approval at the bank ends with it where the bank allows", body: C.Psd2CloseRequest, response: Ok }),
    psd2Accounts: r({ method: "POST", path: "/v1/psd2/accounts", summary: "PSD2: accounts of the approval", body: C.Psd2Request, response: C.outcome(C.AccountsData) }),
    psd2Balances: r({ method: "POST", path: "/v1/psd2/balances", summary: "PSD2: balances of accounts", body: C.Psd2BalancesRequest, response: C.outcome(C.BalancesData) }),
    psd2Transactions: r({ method: "POST", path: "/v1/psd2/transactions", summary: "PSD2: booked and pending transactions of an account; without a start date as far back as the bank allows", body: C.Psd2TransactionsRequest, response: C.outcome(C.Psd2TransactionsData) }),
} as const;

export type ConnectorRoutes = typeof connectorRoutes;
