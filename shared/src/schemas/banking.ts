import { z } from "zod";
import { Cents, ColorKeySchema as ColorKey, IconKeySchema as IconKey, Id, IsoDate, Name, Timestamp } from "./common.js";
import { AccountScope, TxRange } from "./profile.js";
import { IMPORT_FIELDS } from "../csv.js";
import { FORMAT_FIELDS, FORMAT_MAX_STEPS, formatIssues } from "../importFormat.js";
import { RULE_MAX_EDITS, RULE_MAX_EXTRACTS, ruleIssues } from "../ruleEngine.js";
import { parseTxQuery } from "../txquery.js";

// ---------- Own information on accounts, groups and categories ----------

export const INFO_LIMITS = { key: 60, value: 500, attributes: 50, notes: 10000 } as const;

export const InfoAttribute = z.object({
    key: z.string().trim().min(1, "Bitte eine Bezeichnung eingeben").max(INFO_LIMITS.key, `Bezeichnung: höchstens ${INFO_LIMITS.key} Zeichen`),
    value: z.string().trim().max(INFO_LIMITS.value, `Wert: höchstens ${INFO_LIMITS.value} Zeichen`),
});
export type InfoAttribute = z.infer<typeof InfoAttribute>;

export const Info = z.object({
    attributes: z
        .array(InfoAttribute)
        .max(INFO_LIMITS.attributes, `Höchstens ${INFO_LIMITS.attributes} Merkmale`)
        .superRefine((list, ctx) => {
            const seen = new Set<string>();
            for (const a of list) {
                const k = a.key.toLocaleLowerCase("de");
                if (seen.has(k)) ctx.addIssue({ code: "custom", message: `Die Bezeichnung „${a.key}“ kommt doppelt vor` });
                seen.add(k);
            }
        })
        .describe("Pairs of label and value in the user's order; a label occurs once (case ignored)"),
    notes: z.string().max(INFO_LIMITS.notes, `Notiz: höchstens ${INFO_LIMITS.notes} Zeichen`).describe("Free text, line breaks kept"),
});
export type Info = z.infer<typeof Info>;

// ---------- Account groups and accounts ----------

export const AccountGroup = z.object({
    id: Id,
    parentId: Id.nullable(),
    name: z.string(),
    icon: IconKey,
    color: ColorKey,
    position: z.number().int(),
    info: Info,
});
export type AccountGroup = z.infer<typeof AccountGroup>;

export const CreateGroupRequest = z.object({
    parentId: Id.nullable().default(null),
    name: Name,
    icon: IconKey.default("folder"),
    color: ColorKey.default("neutral"),
});
export const UpdateGroupRequest = z.object({
    name: Name.optional(),
    icon: IconKey.optional(),
    color: ColorKey.optional(),
    info: Info.optional().describe("Replaces the own information as a whole"),
});

/** Moves a group or an account to `parentId` (a group, or null for the top) at `index`. */
export const MoveTreeNodeRequest = z.object({
    kind: z.enum(["group", "account"]),
    id: Id,
    parentId: Id.nullable(),
    index: z.number().int().min(0),
});

export const AccountKind = z.enum(["giro", "savings", "credit_card", "loan", "offline"]);
export type AccountKind = z.infer<typeof AccountKind>;

export const Account = z.object({
    id: Id,
    kind: AccountKind,
    connectionId: Id.nullable(),
    name: z.string(),
    icon: IconKey,
    color: ColorKey,
    groupId: Id.nullable(),
    position: z.number().int(),
    hidden: z.boolean(),
    iban: z.string().nullable(),
    cardNumber: z.string().nullable().describe("Card number of a credit card"),
    currency: z.literal("EUR"),
    openingBalance: Cents.nullable().describe("Balance before the first booking (offline accounts)"),
    balance: Cents.describe("Current balance, pending bookings included"),
    pendingSum: Cents,
    pendingCount: z.number().int(),
    transactionCount: z.number().int(),
    createdAt: Timestamp,
    info: Info,
});
export type Account = z.infer<typeof Account>;

export const CreateOfflineAccountRequest = z.object({
    name: Name,
    icon: IconKey.default("banknote"),
    color: ColorKey.default("green"),
    groupId: Id.nullable().default(null),
    openingBalance: Cents.default(0),
});
export const UpdateAccountRequest = z.object({
    name: Name.optional(),
    icon: IconKey.optional(),
    color: ColorKey.optional(),
    hidden: z.boolean().optional(),
    openingBalance: Cents.optional(),
    info: Info.optional().describe("Replaces the own information as a whole"),
});

export const ReconcileRequest = z.object({
    date: IsoDate,
    balance: Cents.describe("Counted balance at the end of `date`"),
});
export const ReconcileResponse = z.object({
    difference: Cents,
    transactionId: Id.nullable(),
});

// ---------- Transactions ----------

export const TxStatus = z.enum(["booked", "pending"]);
export const TxSource = z.enum(["bank", "manual", "import"]);
export const CategorySource = z.enum(["rule", "manual", "auto"]);

export const TxEditField = z.enum(["counterparty", "remittance"]);
export type TxEditField = z.infer<typeof TxEditField>;
export const TxEdit = z.object({
    value: z.string().nullable().describe("The text to show; null: the bank's value, chosen on purpose"),
    source: z.enum(["rule", "manual"]),
});
export type TxEdit = z.infer<typeof TxEdit>;

export const Transaction = z.object({
    id: Id,
    accountId: Id,
    bookingDate: IsoDate,
    valueDate: IsoDate.nullable(),
    amount: Cents,
    currency: z.literal("EUR"),
    /** Holder of the counterparty's account (for a card payment often the processing bank). */
    counterpartyName: z.string(),
    /**
     * Ultimate creditor of a debit or ultimate debtor of a credit as the bank reports it (e.g. the
     * shop of a card payment); "" if none. Lists show it instead of the name.
     */
    ultimateParty: z.string(),
    counterpartyIban: z.string().nullable(),
    remittance: z.string(),
    /** Booking text of the bank, e.g. "Kartenzahlung", "Lastschrift"; "" if none. */
    bookingText: z.string(),
    /** End-to-end reference of the booking; "" if none. Never used to link a transfer. */
    reference: z.string(),
    customerReference: z.string().describe("Customer reference (KREF) the payer gave the order; \"\" if none"),
    bankReference: z.string().describe("The bank's own reference of the booking; \"\" if none"),
    /** SEPA mandate of a direct debit; "" if none. */
    mandateId: z.string(),
    /** SEPA creditor identifier of a direct debit; "" if none. */
    creditorId: z.string(),
    counterpartyBic: z.string().describe("BIC of the counterparty; \"\" if none"),
    counterpartyAccount: z.string().describe("Account of the counterparty when the bank names no IBAN; \"\" if none"),
    counterpartyBankCode: z.string().describe("National bank code that goes with counterpartyAccount; \"\" if none"),
    status: TxStatus,
    source: TxSource,
    importId: Id.nullable(),
    counterTransactionId: Id.nullable(),
    isReturn: z.boolean().describe("Gives back an earlier booking (return debit, cancellation)"),
    returnReason: z.string().describe("Reason code of the return as the bank sends it; \"\" if none"),
    returnOfId: Id.nullable().describe("The booking this return gives back"),
    returnedById: Id.nullable().describe("The return that gave this booking back"),
    categoryId: Id.nullable(),
    categorySource: CategorySource.nullable(),
    createdAt: Timestamp,
    unread: z.boolean().describe("New: not looked at yet by the signed-in user"),
    edits: z
        .object({ counterparty: TxEdit.nullable(), remittance: TxEdit.nullable() })
        .describe("Values shown instead of the bank's. All other fields keep the bank's values"),
});
export type Transaction = z.infer<typeof Transaction>;

export const TransactionQuery = z.object({
    scope: AccountScope.default("all"),
    range: TxRange.optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    q: z
        .string()
        .trim()
        .max(200)
        .superRefine((v, ctx) => {
            const r = parseTxQuery(v);
            if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
        })
        .optional()
        .describe(
            "Search: words (space = AND), \"phrases\", wildcards * and ?, UND/ODER/NICHT (or AND/OR/NOT, -word), parentheses, " +
                "fields gegenseite: zweck: iban: konto: kategorie: betrag: datum: (or counterparty: purpose: account: category: amount: date:), " +
                "comparisons > >= < <= = for amounts and dates, ist:neu (or is:new) for new bookings",
        ),
    category: z.string().regex(/^(all|(none|\d+)(,(none|\d+)){0,99})$/).default("all").describe("all, or a comma-separated list of category ids and none"),
    dir: z.enum(["all", "in", "out"]).default("all"),
    pending: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    limit: z.coerce.number().int().min(1).max(20000).default(5000),
});
export type TransactionQuery = z.input<typeof TransactionQuery>;

export const TransactionList = z.object({
    items: z.array(Transaction),
    total: Cents.describe("Sum of all matching bookings"),
    count: z.number().int(),
    truncated: z.boolean(),
});
export type TransactionList = z.infer<typeof TransactionList>;

const ManualTransactionFields = {
    bookingDate: IsoDate,
    valueDate: IsoDate.nullable().optional(),
    amount: Cents.refine((v) => v !== 0, "Betrag darf nicht 0 sein"),
    counterpartyName: z.string().trim().max(140),
    counterpartyIban: z.string().trim().max(40).nullable().optional(),
    remittance: z.string().trim().max(400),
    status: TxStatus,
    /** Missing or null: no category; rules never run on a booking by hand by themselves. */
    categoryId: Id.nullable().optional(),
};
export const ManualTransactionRequest = z.object({
    ...ManualTransactionFields,
    counterpartyName: ManualTransactionFields.counterpartyName.default(""),
    remittance: ManualTransactionFields.remittance.default(""),
    status: ManualTransactionFields.status.default("booked"),
});
// Without defaults: a field left out of a change stays as it is
export const UpdateManualTransactionRequest = z.object(ManualTransactionFields).partial();

export const AssignCategoryRequest = z.object({
    ids: z.array(Id).min(1).max(5000),
    categoryId: Id.nullable(),
});
export const AssignCategoryResponse = z.object({ changed: z.number().int() });

export const UnreadCounts = z.object({
    accounts: z.array(z.object({ accountId: Id, count: z.number().int() })).describe("Accounts with new bookings only"),
    total: z.number().int(),
});
export type UnreadCounts = z.infer<typeof UnreadCounts>;

export const MarkReadRequest = z
    .object({
        ids: z.array(Id).min(1).max(20000).optional(),
        scope: AccountScope.optional().describe("All bookings of these accounts; only for marking as read"),
        unread: z.boolean().default(false).describe("true marks as new again"),
    })
    .refine((v) => (v.ids === undefined) !== (v.scope === undefined), "Entweder Umsätze oder Konten angeben")
    .refine((v) => !(v.scope && v.unread), "Nur einzelne Umsätze lassen sich als neu markieren");
export const MarkReadResponse = z.object({ changed: z.number().int() });

export const CounterBookingRequest = z.object({
    accountId: Id,
    categoryId: Id.nullable().optional().describe("Category of both bookings. Missing: the preset category, if any. Null: none"),
});

export const Payee = z.object({ name: z.string(), iban: z.string().nullable(), uses: z.number().int() });
export const PayeeQuery = z.object({ accountId: z.coerce.number().int().positive().optional() });

// ---------- Balance history and figures ----------

export const SeriesQuery = z.object({
    scope: AccountScope.default("all"),
    days: z.coerce.number().int().min(7).max(730).default(30),
    /** Takes precedence over `days`: the days of this range ("all" starts at the first booking). */
    range: TxRange.optional(),
    from: IsoDate.optional().describe("Takes precedence over range and days; missing with to: the first booking"),
    to: IsoDate.optional().describe("Takes precedence over range and days; missing with from: today"),
    forecastDays: z.coerce.number().int().min(0).max(90).default(0).describe("Days after today to forecast from standing orders and scheduled transfers"),
});
export const SeriesPoint = z.object({ date: IsoDate, balance: Cents });
export const SeriesResponse = z.object({
    points: z.array(SeriesPoint),
    /** Balance of the days after today if only the known orders run; empty unless asked for, the series ends today and an order falls into the days. */
    forecast: z.array(SeriesPoint),
});

export const StatsQuery = z.object({
    scope: AccountScope.default("all"),
    from: IsoDate,
    to: IsoDate,
});
export const CashflowResponse = z.object({
    income: Cents,
    expenses: Cents.describe("Negative or zero"),
    count: z.number().int(),
});
export const CategorySumsResponse = z.object({
    sums: z.array(z.object({ categoryId: Id.nullable(), amount: Cents, count: z.number().int() })),
});

// ---------- Categories and rules ----------

export const Category = z.object({
    id: Id,
    parentId: Id.nullable(),
    name: z.string(),
    icon: IconKey,
    color: ColorKey.nullable().describe("Empty for a subcategory: it takes the colour of its nearest ancestor with one"),
    position: z.number().int(),
    excludedFromStats: z.boolean(),
    counterDefault: z.boolean().describe("Preset category of counter bookings; at most one category has it"),
    count: z.number().int().describe("Bookings in this category itself"),
    info: Info,
});
export type Category = z.infer<typeof Category>;

/** Where "Ohne Kategorie" sits in the tree; its bookings belong to `parentId` like a subcategory's. */
export const UncategorizedSlot = z.object({
    parentId: Id.nullable().describe("Parent category, null for the top level"),
    position: z.number().int().nullable().describe("Position among the parent's categories, null for last"),
});
export type UncategorizedSlot = z.infer<typeof UncategorizedSlot>;

export const CategoryList = z.object({
    items: z.array(Category),
    uncategorized: z.number().int(),
    none: UncategorizedSlot,
});
export type CategoryList = z.infer<typeof CategoryList>;

export const CreateCategoryRequest = z.object({
    parentId: Id.nullable().default(null),
    name: Name,
    icon: IconKey.optional(),
    color: ColorKey.nullable().optional(),
});
export const UpdateCategoryRequest = z.object({
    name: Name.optional(),
    icon: IconKey.optional(),
    color: ColorKey.nullable().optional(),
    excludedFromStats: z.boolean().optional(),
    counterDefault: z.boolean().optional().describe("True makes this the preset of counter bookings and takes it from any other category"),
    info: Info.optional().describe("Replaces the own information as a whole"),
});
export const MoveCategoryRequest = z.object({
    id: Id,
    parentId: Id.nullable(),
    index: z.number().int().min(0).describe("Index among the new siblings, \"Ohne Kategorie\" counted"),
});
export const MoveUncategorizedRequest = z.object({
    parentId: Id.nullable(),
    index: z.number().int().min(0).describe("Index among the new siblings"),
});
export const DeleteCategoryQuery = z.object({
    moveTo: z.coerce.number().int().positive().optional(),
});

const RuleQuery = z
    .string()
    .trim()
    .max(200)
    .superRefine((v, ctx) => {
        const r = parseTxQuery(v, { mode: "rule" });
        if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
    })
    .describe("Search syntax of the transaction list, without kategorie: and relative dates");

const RuleStepId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, "Kennung: Buchstaben, Ziffern, - und _");
const RulePartName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,23}$/, "Name: Buchstaben, Ziffern und _, beginnend mit einem Buchstaben");

export const RuleSourceField = z.enum(["party", "ultimateParty", "counterpartyName", "remittance", "bookingText", "reference", "mandateId", "creditorId"]);
export type RuleSourceField = z.infer<typeof RuleSourceField>;

const RuleExtractInput = z.union([z.strictObject({ field: RuleSourceField }), z.strictObject({ step: RuleStepId, part: RulePartName })]);

export const RuleExtract = z
    .discriminatedUnion("type", [
        z.strictObject({ id: RuleStepId, input: RuleExtractInput, type: z.literal("pattern"), pattern: z.string().min(1).max(200) }),
        z.strictObject({ id: RuleStepId, input: RuleExtractInput, type: z.literal("separator"), separator: z.string().min(1).max(40), parts: z.array(RulePartName).min(1).max(20) }),
        z.strictObject({
            id: RuleStepId,
            input: RuleExtractInput,
            type: z.literal("keywords"),
            prefix: z.string().max(20),
            suffix: z.string().max(20),
            keywords: z.array(z.strictObject({ text: z.string().min(1).max(60), part: RulePartName })).min(1).max(30),
        }),
    ])
    .meta({ id: "RuleExtract" });
export type RuleExtract = z.infer<typeof RuleExtract>;

export const RuleEdit = z
    .discriminatedUnion("op", [
        z.strictObject({ op: z.literal("set"), field: TxEditField, value: z.string().min(1).max(400).describe("Text with placeholders") }),
        z.strictObject({ op: z.literal("remove"), field: TxEditField, text: z.string().min(1).max(200) }),
        z.strictObject({ op: z.literal("replace"), field: TxEditField, text: z.string().min(1).max(200), with: z.string().max(400).describe("Text with placeholders") }),
    ])
    .meta({ id: "RuleEdit" });
export type RuleEdit = z.infer<typeof RuleEdit>;

const RuleName = z.string().trim().max(80, "Name: höchstens 80 Zeichen");
const RuleAccounts = z.array(Id).min(1, "Bitte mindestens ein Konto wählen").max(500).nullable();

export const Rule = z.object({
    id: Id,
    name: z.string(),
    query: z.string().describe("Search syntax of the transaction list"),
    categoryId: Id.nullable(),
    accountIds: z.array(Id).nullable().describe("null: all accounts. Empty only when every chosen account was deleted"),
    extracts: z.array(RuleExtract),
    edits: z.array(RuleEdit),
    position: z.number().int(),
    active: z.boolean(),
    hits: z.number().int().describe("Bookings the rule hits"),
    wins: z.number().int().describe("Bookings where it is the first active rule that hits"),
});
export type Rule = z.infer<typeof Rule>;

const checkRule = (v: { categoryId?: number | null; extracts?: RuleExtract[]; edits?: RuleEdit[] }, ctx: z.RefinementCtx) => {
    if (!v.extracts || !v.edits) return;
    for (const message of ruleIssues({ categoryId: v.categoryId, extracts: v.extracts, edits: v.edits })) ctx.addIssue({ code: "custom", message });
};

const RuleDraftFields = {
    name: RuleName.default(""),
    query: RuleQuery,
    categoryId: Id.nullable().default(null),
    accountIds: RuleAccounts.default(null),
    extracts: z.array(RuleExtract).max(RULE_MAX_EXTRACTS).default([]),
    edits: z.array(RuleEdit).max(RULE_MAX_EDITS).default([]),
};

export const CreateRuleRequest = z.object(RuleDraftFields).superRefine(checkRule);
/** Extracts and actions are sent together, since one reads the other. */
export const UpdateRuleRequest = z
    .object({
        name: RuleName.optional(),
        query: RuleQuery.optional(),
        categoryId: Id.nullable().optional(),
        accountIds: RuleAccounts.optional(),
        extracts: z.array(RuleExtract).max(RULE_MAX_EXTRACTS).optional(),
        edits: z.array(RuleEdit).max(RULE_MAX_EDITS).optional(),
        active: z.boolean().optional(),
    })
    .refine((v) => (v.extracts === undefined) === (v.edits === undefined), "Ausschnitte und Aktionen gehören zusammen");
export const OrderRulesRequest = z.object({ ids: z.array(Id) });

export const TestRuleRequest = z
    .object({ ...RuleDraftFields, ruleId: Id.optional().describe("The stored rule this draft replaces, for its place in the order") })
    // A draft may not have an action yet; what its condition hits still shows
    .superRefine((v, ctx) => checkRule({ ...v, categoryId: v.categoryId ?? 0 }, ctx));
export const RuleSample = z.object({
    transactionId: Id,
    bookingDate: IsoDate,
    amount: Cents,
    counterparty: z.string().describe("Bank's value"),
    remittance: z.string().describe("Bank's value"),
    values: z.record(z.string(), z.string()).describe("Extracted values"),
    newCounterparty: z.string().nullable(),
    newRemittance: z.string().nullable(),
    hit: z.boolean().describe("False: the condition fits, but a value the actions need is missing"),
    takenBy: Id.nullable().describe("The rule further up that takes this booking"),
});
export type RuleSample = z.infer<typeof RuleSample>;
export const RuleTestResult = z.object({
    matches: z.number().int().describe("Bookings that fit the accounts and the query"),
    hits: z.number().int().describe("Of those, bookings where every needed value was found"),
    missed: z.number().int().describe("Bookings that fit but lack a needed value"),
    wins: z.number().int().describe("Hits no rule further up takes"),
    takenBy: z.array(z.object({ ruleId: Id, count: z.number().int() })).describe("Rules further up and how many hits each takes"),
    samples: z.array(RuleSample).max(20),
});
export type RuleTestResult = z.infer<typeof RuleTestResult>;

export const RuleRunMode = z.enum(["empty", "all"]).describe("empty: only fields without a value. all: every field with a rule result");
export type RuleRunMode = z.infer<typeof RuleRunMode>;
export const RuleChangeField = z.enum(["counterparty", "remittance", "category"]);
export type RuleChangeField = z.infer<typeof RuleChangeField>;
export const RuleChangeKind = z.enum(["fill", "change", "replace", "reset"]).describe("fill: no value yet. change: from an earlier rule. replace: set by hand or otherwise. reset: back to the bank's value");
export type RuleChangeKind = z.infer<typeof RuleChangeKind>;

export const RuleFieldChange = z.object({
    field: RuleChangeField,
    kind: RuleChangeKind,
    before: z.string().nullable().describe("Text shown now; for a category its id as text"),
    after: z.string().nullable().describe("Text shown afterwards; for a category its id as text"),
    selected: z.boolean().describe("Chosen at first"),
});
export type RuleFieldChange = z.infer<typeof RuleFieldChange>;

export const RuleRunItem = z.object({
    key: z.string().describe("Stable across fetches: account and fingerprint for a pending booking of the bank, else the booking id"),
    transactionId: Id,
    accountId: Id,
    bookingDate: IsoDate,
    amount: Cents,
    counterparty: z.string().describe("Bank's value"),
    remittance: z.string().describe("Bank's value"),
    manual: z.boolean().describe("A booking made by hand; never chosen at first"),
    split: z.boolean().describe("A split booking; rules never replace its categories"),
    ruleId: Id.nullable().describe("The rule that wins; null when a reset has no rule"),
    changes: z.array(RuleFieldChange).min(1),
});
export type RuleRunItem = z.infer<typeof RuleRunItem>;

export const RulePreviewQuery = z.object({
    ruleId: z.coerce.number().int().positive().optional().describe("Only bookings this rule wins in a full run"),
    mode: RuleRunMode.default("empty"),
});
export const RulePreview = z.object({
    items: z.array(RuleRunItem).describe("Every change, newest first"),
    unchanged: z.number().int().describe("Bookings in scope that stay as they are"),
    planHash: z.string().describe("Sent back with applyRules; a different result is refused"),
});
export type RulePreview = z.infer<typeof RulePreview>;

export const ApplyRulesRequest = z.object({
    ruleId: Id.optional().describe("As in the preview"),
    mode: RuleRunMode,
    planHash: z.string().min(1).max(128),
    deviations: z
        .array(z.object({ key: z.string().max(100), field: RuleChangeField, selected: z.boolean() }))
        .max(1_000_000)
        .default([])
        .describe("Fields whose choice differs from the one the preview made"),
});
export const ApplyRulesResponse = z.object({ changed: z.number().int().describe("Bookings written") });

export const TxEditParams = z.object({ id: z.coerce.number().int().positive(), field: TxEditField });
export const SetTransactionEditRequest = z.object({
    value: z.string().trim().min(1, "Bitte einen Text eingeben").max(400).nullable().describe("The text to show; null: the bank's value"),
});

// ---------- CSV import ----------

export const ColumnMapSchema = z.object({
    ...(Object.fromEntries(IMPORT_FIELDS.map((f) => [f, z.number().int().min(0).nullable()])) as Record<(typeof IMPORT_FIELDS)[number], z.ZodNullable<z.ZodNumber>>),
    // Added later: column maps of existing API callers do not name them
    bookingText: z.number().int().min(0).nullable().default(null),
    reference: z.number().int().min(0).nullable().default(null),
    mandateId: z.number().int().min(0).nullable().default(null),
    creditorId: z.number().int().min(0).nullable().default(null),
    counterpartyBic: z.number().int().min(0).nullable().default(null),
});

const FormatId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, "Kennung: Buchstaben, Ziffern, - und _, beginnend mit einem Buchstaben");

/** Where a value comes from: a column by name or position, or a part of an earlier step. */
export const FormatValueRef = z.union([
    z.strictObject({ column: z.string().min(1).max(120) }),
    z.strictObject({ columnIndex: z.number().int().min(0).max(499) }),
    z.strictObject({ step: FormatId, part: FormatId }),
]).meta({ id: "ImportFormatValueRef" });
export type FormatValueRef = z.infer<typeof FormatValueRef>;

const FormatSeparatorStep = z.strictObject({
    id: FormatId,
    input: FormatValueRef,
    type: z.literal("separator"),
    separator: z.string().min(1).max(40).describe("Fixed text that splits the value"),
    parts: z.array(FormatId).min(1).max(20).describe("Names of the pieces, in order"),
});

const FormatKeywordsStep = z.strictObject({
    id: FormatId,
    input: FormatValueRef,
    type: z.literal("keywords"),
    prefix: z.string().max(20).describe("Fixed text before a keyword; not needed at the start of the value"),
    suffix: z.string().max(20).describe("Fixed text after a keyword"),
    keywords: z.array(z.strictObject({ text: z.string().min(1).max(60), part: FormatId })).min(1).max(30),
});

export const FormatStep = z.discriminatedUnion("type", [FormatSeparatorStep, FormatKeywordsStep]);
export type FormatStep = z.infer<typeof FormatStep>;

/** How a file is read and taken apart. Keys and fixed values are English; texts are as in the file. */
export const ImportFormatDefinition = z
    .strictObject({
        version: z.literal(1),
        file: z.strictObject({
            encoding: z.enum(["auto", "utf-8", "windows-1252"]),
            delimiter: z.string().min(1).max(10).describe("Column delimiter, or \"auto\""),
            quote: z.enum(["\"", "'"]).nullable(),
            headerLine: z.union([z.literal("auto"), z.literal("none"), z.number().int().min(1).max(1000)]).describe("Number of the header among the lines with content"),
        }),
        steps: z.array(FormatStep).max(FORMAT_MAX_STEPS),
        fields: z.strictObject(
            Object.fromEntries(FORMAT_FIELDS.map((f) => [f, z.array(FormatValueRef).min(1).max(8).optional()])) as Record<(typeof FORMAT_FIELDS)[number], z.ZodOptional<z.ZodArray<typeof FormatValueRef>>>,
        ),
        values: z.strictObject({
            dateOrder: z.enum(["auto", "dmy", "mdy", "ymd"]),
            decimalSeparator: z.enum(["auto", ",", "."]),
            categorySeparator: z.string().min(1).max(10).describe("Separator of category paths, or \"auto\""),
            pendingWords: z.array(z.string().min(1).max(40)).max(10).describe("Words in the status that mark a pending booking; empty for the usual ones"),
        }),
    })
    .superRefine((def, ctx) => {
        for (const message of formatIssues(def as ImportFormatDefinition)) ctx.addIssue({ code: "custom", message });
    })
    .meta({ id: "ImportFormatDefinition" });
export type ImportFormatDefinition = z.infer<typeof ImportFormatDefinition>;

export const ImportFormat = z.object({
    key: z.string().describe("builtin:… for a format of the app, custom:<id> for an own one"),
    id: Id.nullable().describe("Id of an own format; null for a format of the app"),
    name: z.string(),
    builtin: z.boolean(),
    definition: ImportFormatDefinition,
});
export type ImportFormat = z.infer<typeof ImportFormat>;

const FormatName = z.string().trim().min(1, "Bitte einen Namen eingeben").max(80, "Name: höchstens 80 Zeichen");
export const CreateImportFormatRequest = z.object({ name: FormatName, definition: ImportFormatDefinition });
export const UpdateImportFormatRequest = z.object({ name: FormatName.optional(), definition: ImportFormatDefinition.optional() });

export const ImportRequest = z.object({
    fileName: z.string().max(255),
    content: z.string().max(20_000_000),
    columns: ColumnMapSchema.optional().describe("Plain column assignment; ignored when `format` is given"),
    format: ImportFormatDefinition.optional().describe("How to read the file; without it and without `columns` the format is chosen by the header"),
    createCategories: z.boolean().optional().describe("Create the categories the file names but that do not exist yet"),
    replaceCategoryLines: z.array(z.number().int().min(1)).max(1_000_000).optional().describe("Rows of the file (`line` of the preview) whose differing category replaces the stored one; without them a stored category stays"),
    excludeLines: z.array(z.number().int().min(1)).max(1_000_000).optional().describe("Rows of the file (`line` of the preview) whose new booking or filled-in values are left out; does not affect `replaceCategoryLines`"),
});

export const DetectImportFormatRequest = z.object({ content: z.string().max(20_000_000) });
export const DetectedImportFormat = z.object({
    format: ImportFormatDefinition.describe("The format to read the file with"),
    formatKey: z.string().nullable().describe("The stored format chosen by the header; null for the automatic column assignment"),
});

export const ImportFillField = z.enum(["bookingText", "reference", "mandateId", "creditorId", "counterpartyBic"]);
export type ImportFillField = z.infer<typeof ImportFillField>;

export const ImportPreviewRow = z.object({
    line: z.number().int(),
    date: IsoDate.nullable(),
    amount: Cents.nullable(),
    name: z.string(),
    iban: z.string().nullable(),
    purpose: z.string(),
    shownName: z.string().nullable().describe("New row: the counterparty after the rules; null: as in the file"),
    shownPurpose: z.string().nullable().describe("New row: the purpose after the rules; null: as in the file"),
    bookingText: z.string().describe("Kind of booking the file names (\"Lastschrift\" …)"),
    fillsBookingText: z.boolean().describe("Duplicate without a kind of booking that takes the one of the file"),
    reference: z.string(),
    mandateId: z.string(),
    creditorId: z.string(),
    counterpartyBic: z.string(),
    fillsDetails: z.boolean().describe("Duplicate with an empty reference, mandate, creditor id or BIC that takes the one of the file"),
    fills: z.array(ImportFillField).describe("Duplicate: the fields empty in the stored booking that take the value of this row"),
    pending: z.boolean(),
    categoryId: Id.nullable().describe("Category the row gets; for a duplicate the category the file names"),
    newCategory: z.string().nullable().describe("Category named by the file that does not exist yet (\"Parent › Child › …\")"),
    state: z.enum(["new", "duplicate", "invalid"]),
    storedCategoryId: Id.nullable().describe("Duplicate: the category of the booking already stored"),
    categoryState: z
        .enum(["same", "differs", "empty", "split"])
        .nullable()
        .describe("Duplicate whose file names a category: same as the stored booking, differs from it, the stored booking has none, or it is split (never overwritten)"),
    error: z.string().nullable(),
});

export const ImportPreview = z.object({
    header: z.array(z.string()),
    columns: ColumnMapSchema.describe("Columns assigned directly; a field fed by a step has none"),
    format: ImportFormatDefinition.describe("The format the preview was made with"),
    formatKey: z.string().nullable().describe("The stored format chosen by the header; null for the automatic column assignment or a format sent with the request"),
    rows: z.array(ImportPreviewRow),
    newCategories: z.array(z.string()).describe("Missing categories named by the new rows and the duplicates with a differing or empty category"),
    counts: z.object({
        new: z.number().int(),
        duplicate: z.number().int(),
        invalid: z.number().int(),
        differs: z.number().int().describe("Duplicates whose stored category differs from the file's"),
        filled: z.number().int().describe("Duplicates with an empty kind of booking, detail or category the file fills in"),
    }),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportResult = z.object({
    importId: Id,
    imported: z.number().int(),
    skipped: z.number().int(),
    invalid: z.number().int(),
    createdCategories: z.number().int(),
    recategorized: z.number().int().describe("Bookings already stored whose category was replaced by the one of the file"),
    categoriesFilled: z.number().int().describe("Bookings already stored without a category that got the one of the file"),
    bookingTextsFilled: z.number().int().describe("Bookings already stored whose empty kind of booking came from the file"),
    detailsFilled: z.number().int().describe("Bookings already stored with an empty reference, mandate, creditor id or BIC that came from the file"),
    filled: z.number().int().describe("Bookings already stored that got a kind of booking, a detail, a category in place of none, or several of these"),
    excluded: z.number().int().describe("Rows that would have changed something but were left out"),
});

export const ImportRecord = z.object({
    id: Id,
    accountId: Id,
    fileName: z.string(),
    importedAt: Timestamp,
    userName: z.string().nullable(),
    rows: z.number().int(),
    imported: z.number().int(),
    skipped: z.number().int(),
    remaining: z.number().int().describe("Bookings of this import that still exist"),
});
export type ImportRecord = z.infer<typeof ImportRecord>;
