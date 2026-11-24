// The server API as one list of routes. The server registers its handlers against it, the web
// client calls through it, and `npm run contracts` writes it as contracts/server-api.yaml for the
// macOS client. A route that is not listed here does not exist.

import { z } from "zod";
import { IdParam, Ok } from "./schemas/common.js";
import * as S from "./schemas/system.js";
import * as P from "./schemas/profile.js";
import * as B from "./schemas/banking.js";
import * as K from "./schemas/bankaccess.js";
import * as O from "./schemas/orders.js";
import * as T from "./schemas/transfers.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * none:     reachable in every state
 * unlocked: needs the open database, no sign-in (confirming a new TOTP secret)
 * user:     needs a signed-in user whose session is not locked after inactivity
 * session:  needs a signed-in user, also while the session is locked after inactivity
 */
export type Access = "none" | "unlocked" | "user" | "session";

export interface RouteDef {
    method: Method;
    path: string;
    summary: string;
    tag: string;
    access: Access;
    params?: z.ZodType;
    query?: z.ZodType;
    body?: z.ZodType;
    response: z.ZodType;
}

const r = <T extends RouteDef>(def: T): T => def;

const List = <T extends z.ZodType>(item: T) => z.array(item);

export const routes = {
    // ---------- System ----------
    status: r({ method: "GET", path: "/api/status", summary: "State of the server", tag: "System", access: "none", response: S.StatusResponse }),
    setup: r({ method: "POST", path: "/api/setup", summary: "Set up encryption with the first user; their password opens the database", tag: "System", access: "none", body: S.SetupRequest, response: S.SetupResponse }),
    recover: r({ method: "POST", path: "/api/recover", summary: "Open the database with the recovery key and set a new password for a user; with `resetTotp` also start a new second factor", tag: "System", access: "none", body: S.RecoverRequest, response: S.RecoverResponse }),
    recoverTotp: r({ method: "POST", path: "/api/recover/totp", summary: "Phone lost: start a new second factor with password and recovery key, confirmed with `confirmTotp`. The bank logins stay", tag: "System", access: "none", body: S.RecoverTotpRequest, response: S.TotpSetup }),
    lock: r({ method: "POST", path: "/api/lock", summary: "Lock the database until a user enters their password", tag: "System", access: "user", response: Ok }),
    newRecoveryKey: r({ method: "POST", path: "/api/system/recovery-key", summary: "Replace the recovery key of the installation; confirmed with the signed-in user's password and TOTP code", tag: "System", access: "user", body: S.NewRecoveryKeyRequest, response: S.RecoveryKeyResponse }),
    activity: r({ method: "GET", path: "/api/activity", summary: "Activity log", tag: "System", access: "user", query: S.ActivityQuery, response: List(S.ActivityEntry) }),

    // ---------- Sign-in ----------
    login: r({ method: "POST", path: "/api/auth/login", summary: "Sign in with name, password and TOTP code. Also opens a locked database and a locked session; a session of the same user needs no code", tag: "Auth", access: "none", body: S.LoginRequest, response: S.LoginResponse }),
    confirmTotp: r({ method: "POST", path: "/api/auth/totp", summary: "Confirm a new TOTP secret and sign in", tag: "Auth", access: "unlocked", body: S.TotpConfirmRequest, response: S.LoginResponse }),
    logout: r({ method: "POST", path: "/api/auth/logout", summary: "Sign out this device", tag: "Auth", access: "session", response: Ok }),
    me: r({ method: "GET", path: "/api/auth/me", summary: "The signed-in user and whether the session is locked", tag: "Auth", access: "session", response: S.Me }),
    lockSession: r({ method: "POST", path: "/api/auth/session/lock", summary: "Lock this session (no input for the configured time)", tag: "Auth", access: "session", response: Ok }),
    changePassword: r({ method: "POST", path: "/api/auth/password", summary: "Change the own password; confirmed with the current password and TOTP code. The bank logins stay", tag: "Auth", access: "user", body: S.ChangePasswordRequest, response: Ok }),
    startTotpChange: r({ method: "POST", path: "/api/auth/totp/change", summary: "Start replacing the own second factor; confirmed with the password and the TOTP code or recovery key", tag: "Auth", access: "user", body: S.StartTotpChangeRequest, response: S.TotpSetup }),
    confirmTotpChange: r({ method: "POST", path: "/api/auth/totp/change/confirm", summary: "Confirm the new second factor: it replaces the old one, other sessions end, this one stays", tag: "Auth", access: "user", body: S.ConfirmTotpChangeRequest, response: Ok }),

    // ---------- Users and devices ----------
    listUsers: r({ method: "GET", path: "/api/users", summary: "All users", tag: "Users", access: "user", response: List(S.User) }),
    createUser: r({ method: "POST", path: "/api/users", summary: "Add a user; TOTP is set up at the first sign-in. Confirmed with the signed-in user's TOTP code", tag: "Users", access: "user", body: S.CreateUserRequest, response: S.User }),
    deleteUser: r({ method: "DELETE", path: "/api/users/:id", summary: "Remove a user and sign out all their devices; confirmed with the signed-in user's TOTP code", tag: "Users", access: "user", params: IdParam, body: S.ConfirmCodeRequest, response: Ok }),
    setUserPassword: r({ method: "POST", path: "/api/users/:id/password", summary: "Reset another user's password; their bank logins need the credentials again. Confirmed with the signed-in user's TOTP code. Refused for the own user", tag: "Users", access: "user", params: IdParam, body: S.SetPasswordRequest, response: Ok }),
    resetUserTotp: r({ method: "POST", path: "/api/users/:id/reset-totp", summary: "Another user sets up TOTP again at their next sign-in; confirmed with the signed-in user's password. Refused for the own user", tag: "Users", access: "user", params: IdParam, body: S.ConfirmPasswordRequest, response: Ok }),
    listDevices: r({ method: "GET", path: "/api/devices", summary: "Signed-in browsers and device tokens of all users", tag: "Users", access: "user", response: List(S.Device) }),
    createDevice: r({ method: "POST", path: "/api/devices", summary: "Create a device token (macOS client); confirmed with the signed-in user's TOTP code", tag: "Users", access: "user", body: S.CreateDeviceRequest, response: S.CreateDeviceResponse }),
    revokeDevice: r({ method: "DELETE", path: "/api/devices/:id", summary: "Sign out a device", tag: "Users", access: "user", params: IdParam, response: Ok }),

    // ---------- Profile ----------
    profile: r({ method: "GET", path: "/api/profile", summary: "Settings and overview cards of the signed-in user", tag: "Profile", access: "user", query: P.ClientQuery, response: P.Profile }),
    clientSettings: r({ method: "GET", path: "/api/profile/settings", summary: "Settings of the signed-in user for one device class", tag: "Profile", access: "user", query: P.ClientQuery, response: P.SettingsSchema }),
    setSetting: r({ method: "PUT", path: "/api/profile/settings/:key", summary: "Change one setting", tag: "Profile", access: "user", params: P.SettingParams, query: P.ClientQuery, body: P.SetSettingRequest, response: Ok }),
    createCard: r({ method: "POST", path: "/api/profile/cards", summary: "Add a card to the overview", tag: "Profile", access: "user", body: P.CreateCardRequest, response: P.Card }),
    updateCard: r({ method: "PATCH", path: "/api/profile/cards/:id", summary: "Change a card", tag: "Profile", access: "user", params: IdParam, body: P.UpdateCardRequest, response: P.Card }),
    deleteCard: r({ method: "DELETE", path: "/api/profile/cards/:id", summary: "Remove a card", tag: "Profile", access: "user", params: IdParam, response: Ok }),
    orderCards: r({ method: "PUT", path: "/api/profile/cards/order", summary: "Reorder the cards", tag: "Profile", access: "user", body: P.OrderCardsRequest, response: Ok }),
    resetCards: r({ method: "POST", path: "/api/profile/cards/reset", summary: "Restore the default overview", tag: "Profile", access: "user", response: List(P.Card) }),

    // ---------- Account groups and accounts ----------
    listGroups: r({ method: "GET", path: "/api/account-groups", summary: "Account groups", tag: "Accounts", access: "user", response: List(B.AccountGroup) }),
    createGroup: r({ method: "POST", path: "/api/account-groups", summary: "Add a group", tag: "Accounts", access: "user", body: B.CreateGroupRequest, response: B.AccountGroup }),
    updateGroup: r({ method: "PATCH", path: "/api/account-groups/:id", summary: "Rename a group, change symbol or colour", tag: "Accounts", access: "user", params: IdParam, body: B.UpdateGroupRequest, response: B.AccountGroup }),
    deleteGroup: r({ method: "DELETE", path: "/api/account-groups/:id", summary: "Dissolve a group; its content moves up", tag: "Accounts", access: "user", params: IdParam, response: Ok }),
    moveTreeNode: r({ method: "POST", path: "/api/account-tree/move", summary: "Move a group or an account in the tree", tag: "Accounts", access: "user", body: B.MoveTreeNodeRequest, response: Ok }),
    listAccounts: r({ method: "GET", path: "/api/accounts", summary: "Accounts with balance", tag: "Accounts", access: "user", response: List(B.Account) }),
    createOfflineAccount: r({ method: "POST", path: "/api/accounts", summary: "Add an offline account", tag: "Accounts", access: "user", body: B.CreateOfflineAccountRequest, response: B.Account }),
    updateAccount: r({ method: "PATCH", path: "/api/accounts/:id", summary: "Change an account", tag: "Accounts", access: "user", params: IdParam, body: B.UpdateAccountRequest, response: B.Account }),
    deleteAccount: r({ method: "DELETE", path: "/api/accounts/:id", summary: "Remove an offline account with its bookings", tag: "Accounts", access: "user", params: IdParam, response: Ok }),
    reconcile: r({ method: "POST", path: "/api/accounts/:id/reconcile", summary: "Book the difference to a counted balance", tag: "Accounts", access: "user", params: IdParam, body: B.ReconcileRequest, response: B.ReconcileResponse }),

    // ---------- Transactions ----------
    listTransactions: r({ method: "GET", path: "/api/transactions", summary: "Bookings matching the filters, newest first", tag: "Transactions", access: "user", query: B.TransactionQuery, response: B.TransactionList }),
    createTransaction: r({ method: "POST", path: "/api/accounts/:id/transactions", summary: "Book by hand (offline accounts)", tag: "Transactions", access: "user", params: IdParam, body: B.ManualTransactionRequest, response: B.Transaction }),
    updateTransaction: r({ method: "PATCH", path: "/api/transactions/:id", summary: "Change a booking entered by hand", tag: "Transactions", access: "user", params: IdParam, body: B.UpdateManualTransactionRequest, response: B.Transaction }),
    deleteTransaction: r({ method: "DELETE", path: "/api/transactions/:id", summary: "Delete a booking entered by hand", tag: "Transactions", access: "user", params: IdParam, response: Ok }),
    assignCategory: r({ method: "PUT", path: "/api/transactions/category", summary: "Assign a category to bookings", tag: "Transactions", access: "user", body: B.AssignCategoryRequest, response: B.AssignCategoryResponse }),
    unreadCounts: r({ method: "GET", path: "/api/transactions/unread", summary: "Number of new bookings of the signed-in user per account", tag: "Transactions", access: "user", response: B.UnreadCounts }),
    markRead: r({ method: "POST", path: "/api/transactions/read", summary: "Mark bookings as read or as new again, for the signed-in user", tag: "Transactions", access: "user", body: B.MarkReadRequest, response: B.MarkReadResponse }),
    setTransactionEdit: r({ method: "PUT", path: "/api/transactions/:id/edits/:field", summary: "Show an own text instead of the bank's; null shows the bank's value on purpose", tag: "Transactions", access: "user", params: B.TxEditParams, body: B.SetTransactionEditRequest, response: B.Transaction }),
    clearTransactionEdit: r({ method: "DELETE", path: "/api/transactions/:id/edits/:field", summary: "Take back the own decision for a field; rules may fill it at their next run", tag: "Transactions", access: "user", params: B.TxEditParams, response: B.Transaction }),
    createCounterBooking: r({ method: "POST", path: "/api/transactions/:id/counter", summary: "Book the opposite amount in an offline account", tag: "Transactions", access: "user", params: IdParam, body: B.CounterBookingRequest, response: B.Transaction }),
    deleteCounterBooking: r({ method: "DELETE", path: "/api/transactions/:id/counter", summary: "Remove the counter booking of a booking", tag: "Transactions", access: "user", params: IdParam, response: Ok }),
    payees: r({ method: "GET", path: "/api/payees", summary: "Counterparties used before, most used first", tag: "Transactions", access: "user", query: B.PayeeQuery, response: List(B.Payee) }),
    series: r({ method: "GET", path: "/api/stats/series", summary: "Daily balance", tag: "Transactions", access: "user", query: B.SeriesQuery, response: B.SeriesResponse }),
    cashflow: r({ method: "GET", path: "/api/stats/cashflow", summary: "Income and expenses without own transfers", tag: "Transactions", access: "user", query: B.StatsQuery, response: B.CashflowResponse }),
    categorySums: r({ method: "GET", path: "/api/stats/categories", summary: "Sums per category", tag: "Transactions", access: "user", query: B.StatsQuery, response: B.CategorySumsResponse }),

    // ---------- Categories and rules ----------
    listCategories: r({ method: "GET", path: "/api/categories", summary: "Category tree", tag: "Categories", access: "user", response: B.CategoryList }),
    createCategory: r({ method: "POST", path: "/api/categories", summary: "Add a category", tag: "Categories", access: "user", body: B.CreateCategoryRequest, response: B.Category }),
    updateCategory: r({ method: "PATCH", path: "/api/categories/:id", summary: "Change a category", tag: "Categories", access: "user", params: IdParam, body: B.UpdateCategoryRequest, response: B.Category }),
    deleteCategory: r({ method: "DELETE", path: "/api/categories/:id", summary: "Delete a category; its bookings move to `moveTo` or lose their category", tag: "Categories", access: "user", params: IdParam, query: B.DeleteCategoryQuery, response: Ok }),
    moveCategory: r({ method: "POST", path: "/api/categories/move", summary: "Move a category in the tree", tag: "Categories", access: "user", body: B.MoveCategoryRequest, response: Ok }),
    moveUncategorized: r({ method: "POST", path: "/api/categories/uncategorized/move", summary: "Move \"Ohne Kategorie\" in the tree", tag: "Categories", access: "user", body: B.MoveUncategorizedRequest, response: Ok }),
    listRules: r({ method: "GET", path: "/api/rules", summary: "Rules in the order they are tried", tag: "Categories", access: "user", response: List(B.Rule) }),
    createRule: r({ method: "POST", path: "/api/rules", summary: "Add a rule", tag: "Categories", access: "user", body: B.CreateRuleRequest, response: B.Rule }),
    updateRule: r({ method: "PATCH", path: "/api/rules/:id", summary: "Change a rule", tag: "Categories", access: "user", params: IdParam, body: B.UpdateRuleRequest, response: B.Rule }),
    deleteRule: r({ method: "DELETE", path: "/api/rules/:id", summary: "Delete a rule", tag: "Categories", access: "user", params: IdParam, response: Ok }),
    orderRules: r({ method: "PUT", path: "/api/rules/order", summary: "Reorder the rules", tag: "Categories", access: "user", body: B.OrderRulesRequest, response: Ok }),
    testRule: r({ method: "POST", path: "/api/rules/test", summary: "Try a rule draft on the stored bookings; writes nothing", tag: "Categories", access: "user", body: B.TestRuleRequest, response: B.RuleTestResult }),
    previewRules: r({ method: "GET", path: "/api/rules/preview", summary: "Every change a rule run would make; writes nothing", tag: "Categories", access: "user", query: B.RulePreviewQuery, response: B.RulePreview }),
    applyRules: r({ method: "POST", path: "/api/rules/apply", summary: "Write the chosen changes of a checked rule run", tag: "Categories", access: "user", body: B.ApplyRulesRequest, response: B.ApplyRulesResponse }),

    // ---------- CSV import ----------
    importPreview: r({ method: "POST", path: "/api/accounts/:id/import/preview", summary: "Read a CSV file and show what would be imported", tag: "Import", access: "user", params: IdParam, body: B.ImportRequest, response: B.ImportPreview }),
    importCommit: r({ method: "POST", path: "/api/accounts/:id/import", summary: "Import a CSV file; duplicates are skipped", tag: "Import", access: "user", params: IdParam, body: B.ImportRequest, response: B.ImportResult }),
    listImports: r({ method: "GET", path: "/api/imports", summary: "Past imports", tag: "Import", access: "user", response: List(B.ImportRecord) }),
    undoImport: r({ method: "DELETE", path: "/api/imports/:id", summary: "Delete an import: its remaining bookings and the record", tag: "Import", access: "user", params: IdParam, response: Ok }),
    listImportFormats: r({ method: "GET", path: "/api/import-formats", summary: "Import formats: those of the app and own ones", tag: "Import", access: "user", response: List(B.ImportFormat) }),
    detectImportFormat: r({ method: "POST", path: "/api/import-formats/detect", summary: "Choose the format for a CSV file by its header", tag: "Import", access: "user", body: B.DetectImportFormatRequest, response: B.DetectedImportFormat }),
    createImportFormat: r({ method: "POST", path: "/api/import-formats", summary: "Save an own import format", tag: "Import", access: "user", body: B.CreateImportFormatRequest, response: B.ImportFormat }),
    updateImportFormat: r({ method: "PATCH", path: "/api/import-formats/:id", summary: "Change an own import format", tag: "Import", access: "user", params: IdParam, body: B.UpdateImportFormatRequest, response: B.ImportFormat }),
    deleteImportFormat: r({ method: "DELETE", path: "/api/import-formats/:id", summary: "Delete an own import format", tag: "Import", access: "user", params: IdParam, response: Ok }),
    // ---------- Bank accesses ----------
    searchBanks: r({ method: "GET", path: "/api/banks", summary: "Search the bank directory of the Bundesbank by bank code, BIC or name", tag: "Banks", access: "user", query: K.BankSearchQuery, response: List(K.BankDirectoryEntry) }),
    bankDirectory: r({ method: "GET", path: "/api/bank-directory", summary: "State of the bank directory and of its daily update from bundesbank.de", tag: "Banks", access: "user", response: K.BankDirectoryStatus }),
    checkBankDirectory: r({ method: "POST", path: "/api/bank-directory/check", summary: "Check bundesbank.de for a new bank directory now", tag: "Banks", access: "user", response: K.BankDirectoryStatus }),
    connectorStatus: r({ method: "GET", path: "/api/connectors", summary: "Configured connectors and whether they answer", tag: "Banks", access: "user", response: List(K.ConnectorStatus) }),
    listConnections: r({ method: "GET", path: "/api/bank-connections", summary: "Bank accesses with the own login and the other users' logins", tag: "Banks", access: "user", response: List(K.BankConnection) }),
    createConnection: r({ method: "POST", path: "/api/bank-connections", summary: "Add a bank access (checks the FinTS address); an existing one for the same bank is returned", tag: "Banks", access: "user", body: K.CreateConnectionRequest, response: K.BankConnection }),
    deleteConnection: r({ method: "DELETE", path: "/api/bank-connections/:id", summary: "Remove a bank access with all logins; its accounts are kept as offline accounts or deleted", tag: "Banks", access: "user", params: IdParam, query: K.DeleteConnectionQuery, response: Ok }),
    setLogin: r({ method: "PUT", path: "/api/bank-connections/:id/login", summary: "Set the own login (login name, PIN) and fetch the TAN methods it may use", tag: "Banks", access: "user", params: IdParam, body: K.SetLoginRequest, response: K.SetLoginResponse }),
    changePin: r({ method: "PATCH", path: "/api/bank-connections/:id/login", summary: "Change the stored PIN of the own login or whether it is stored", tag: "Banks", access: "user", params: IdParam, body: K.ChangePinRequest, response: K.BankLogin }),
    deleteLogin: r({ method: "DELETE", path: "/api/bank-connections/:id/login", summary: "Remove the own login; accounts stay", tag: "Banks", access: "user", params: IdParam, response: Ok }),
    chooseTanMethod: r({ method: "PUT", path: "/api/bank-connections/:id/login/tan-method", summary: "Choose the TAN method (and medium) of the own login", tag: "Banks", access: "user", params: IdParam, body: K.ChooseTanMethodRequest, response: K.BankLogin }),
    tanMedia: r({ method: "POST", path: "/api/bank-connections/:id/login/tan-media", summary: "Fetch the active TAN media of the own login", tag: "Banks", access: "user", params: IdParam, body: K.PinBody, response: K.bankOutcome(K.TanMediaResult) }),
    lastOfferedAccounts: r({ method: "GET", path: "/api/bank-connections/:id/login/accounts", summary: "The account list the own login last fetched, with the current state of each account; null before the first fetch. Does not ask the bank", tag: "Banks", access: "user", params: IdParam, response: K.OfferedAccounts.nullable() }),
    offeredAccounts: r({ method: "POST", path: "/api/bank-connections/:id/login/accounts", summary: "Fetch the accounts the own login reaches (approval may be needed)", tag: "Banks", access: "user", params: IdParam, body: K.PinBody, response: K.bankOutcome(K.OfferedAccounts) }),
    importAccounts: r({ method: "POST", path: "/api/bank-connections/:id/accounts", summary: "Take over accounts of the last account list into MBM, or link known ones to the own login", tag: "Banks", access: "user", params: IdParam, body: K.ImportAccountsRequest, response: K.ImportAccountsResponse }),
    detachAccount: r({ method: "POST", path: "/api/accounts/:id/detach", summary: "Detach a bank account from its bank access: keep it as an offline account or delete it; the bank's account is ignored from then on", tag: "Banks", access: "user", params: IdParam, body: K.DetachAccountRequest, response: Ok }),
    bankOperation: r({ method: "GET", path: "/api/bank-operations/:id", summary: "State of a bank operation waiting for an approval", tag: "Banks", access: "user", params: K.BankOperationParam, response: K.bankOutcome(z.unknown()) }),
    bankOperationTan: r({ method: "POST", path: "/api/bank-operations/:id/tan", summary: "Hand in the TAN of a bank operation", tag: "Banks", access: "user", params: K.BankOperationParam, body: K.BankTanRequest, response: K.bankOutcome(z.unknown()) }),
    startSync: r({ method: "POST", path: "/api/sync", summary: "Fetch balances and bookings from the banks: one account, one access, one account group or all; runs in the background", tag: "Banks", access: "user", body: K.SyncRequest, response: List(K.SyncRun) }),
    listSync: r({ method: "GET", path: "/api/sync", summary: "Fetch runs of the signed-in user (running and recent)", tag: "Banks", access: "user", response: List(K.SyncRun) }),
    syncTan: r({ method: "POST", path: "/api/sync/:id/tan", summary: "Hand in the TAN a fetch run waits for", tag: "Banks", access: "user", params: K.SyncRunParam, body: K.BankTanRequest, response: K.SyncRun }),
    cancelSync: r({ method: "DELETE", path: "/api/sync/:id", summary: "Cancel a fetch run", tag: "Banks", access: "user", params: K.SyncRunParam, response: Ok }),
    listOrders: r({ method: "GET", path: "/api/orders", summary: "Standing orders and scheduled transfers as last fetched from the banks", tag: "Banks", access: "user", query: O.OrdersQuery, response: O.OrdersResponse }),
    upcomingOrders: r({ method: "GET", path: "/api/orders/upcoming", summary: "The single runs of orders in the coming days, by date", tag: "Banks", access: "user", query: O.UpcomingQuery, response: O.UpcomingResponse }),
    fetchOrders: r({ method: "POST", path: "/api/orders/fetch", summary: "Fetch only the orders from the banks: one account, one access, one account group or all; runs in the background like a fetch run", tag: "Banks", access: "user", body: K.SyncRequest, response: List(K.SyncRun) }),
    cancelBankOperation: r({ method: "DELETE", path: "/api/bank-operations/:id", summary: "Cancel a bank operation", tag: "Banks", access: "user", params: K.BankOperationParam, response: Ok }),

    // ---------- Transfers ----------
    transferAccounts: r({ method: "GET", path: "/api/transfers/accounts", summary: "Accounts the signed-in user can send transfers from (own bank login that allows it)", tag: "Transfers", access: "user", response: List(T.TransferAccount) }),
    createTransfer: r({ method: "POST", path: "/api/transfers", summary: "Submit a transfer with verification of payee; runs in the background. The same request ID gives the same transfer. 403 confirm_required: the password is due again", tag: "Transfers", access: "user", body: T.CreateTransferRequest, response: T.Transfer }),
    listTransfers: r({ method: "GET", path: "/api/transfers", summary: "History of transfers of all users, newest first", tag: "Transfers", access: "user", query: T.TransfersQuery, response: List(T.Transfer) }),
    getTransfer: r({ method: "GET", path: "/api/transfers/:id", summary: "One transfer with its current state", tag: "Transfers", access: "user", params: IdParam, response: T.Transfer }),
    confirmTransfer: r({ method: "POST", path: "/api/transfers/:id/confirm", summary: "Go on although the payee's name differs or could not be checked; the bank then asks for the approval", tag: "Transfers", access: "user", params: IdParam, response: T.Transfer }),
    transferTan: r({ method: "POST", path: "/api/transfers/:id/tan", summary: "Hand in the TAN a transfer waits for", tag: "Transfers", access: "user", params: IdParam, body: K.BankTanRequest, response: T.Transfer }),
    cancelTransfer: r({ method: "POST", path: "/api/transfers/:id/cancel", summary: "Cancel a transfer that waits for the confirmation or the approval", tag: "Transfers", access: "user", params: IdParam, response: T.Transfer }),
    listPayees: r({ method: "GET", path: "/api/transfers/payees", summary: "Saved payees (last used first) and counterparties of debits that could become payees", tag: "Transfers", access: "user", response: T.PayeesResponse }),
    deletePayee: r({ method: "DELETE", path: "/api/transfers/payees/:id", summary: "Remove a payee from the list", tag: "Transfers", access: "user", params: IdParam, response: Ok }),
    confirmPassword: r({ method: "POST", path: "/api/session/password", summary: "Enter the password again for this session (asked before a transfer after a while)", tag: "Transfers", access: "user", body: S.ConfirmPasswordRequest, response: Ok }),
} as const;

export type Routes = typeof routes;

export type RouteParams<R extends RouteDef> = R["params"] extends z.ZodType ? z.input<R["params"]> : undefined;
export type RouteQuery<R extends RouteDef> = R["query"] extends z.ZodType ? z.input<R["query"]> : undefined;
export type RouteBody<R extends RouteDef> = R["body"] extends z.ZodType ? z.input<R["body"]> : undefined;
export type RouteResponse<R extends RouteDef> = z.infer<R["response"]>;

