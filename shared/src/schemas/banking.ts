import { z } from "zod";
import { Cents, ColorKeySchema as ColorKey, IconKeySchema as IconKey, Id, IsoDate, Name, Timestamp } from "./common.js";
import { AccountScope, TxRange } from "./profile.js";
import { IMPORT_FIELDS } from "../csv.js";
import { FORMAT_FIELDS, FORMAT_MAX_STEPS, formatIssues } from "../importFormat.js";
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
    /** SEPA mandate of a direct debit; "" if none. */
    mandateId: z.string(),
    /** SEPA creditor identifier of a direct debit; "" if none. */
    creditorId: z.string(),
    counterpartyBic: z.string().describe("BIC of the counterparty; \"\" if none"),
    status: TxStatus,
    source: TxSource,
    importId: Id.nullable(),
    counterTransactionId: Id.nullable(),
    categoryId: Id.nullable(),
    categorySource: CategorySource.nullable(),
    createdAt: Timestamp,
    unread: z.boolean().describe("New: not looked at yet by the signed-in user"),
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

export const ManualTransactionRequest = z.object({
    bookingDate: IsoDate,
    valueDate: IsoDate.nullable().optional(),
    amount: Cents.refine((v) => v !== 0, "Betrag darf nicht 0 sein"),
    counterpartyName: z.string().trim().max(140).default(""),
    counterpartyIban: z.string().trim().max(40).nullable().optional(),
    remittance: z.string().trim().max(400).default(""),
    status: TxStatus.default("booked"),
    /** Missing: the rules decide; null: no category. */
    categoryId: Id.nullable().optional(),
});
export const UpdateManualTransactionRequest = ManualTransactionRequest.partial();

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

export const Rule = z.object({
    id: Id,
    query: z.string().describe("Search syntax of the transaction list"),
    categoryId: Id,
    position: z.number().int(),
    active: z.boolean(),
    hits: z.number().int().describe("Bookings the rule matches"),
});
export type Rule = z.infer<typeof Rule>;

export const CreateRuleRequest = z.object({
    query: RuleQuery,
    categoryId: Id,
});
export const UpdateRuleRequest = z.object({
    query: RuleQuery.optional(),
    categoryId: Id.optional(),
    active: z.boolean().optional(),
});
export const OrderRulesRequest = z.object({ ids: z.array(Id) });
export const RulePreviewQuery = z.object({
    ruleId: z.coerce.number().int().positive().optional().describe("Only this rule, whatever its position. Missing: the first matching active rule"),
});
export const RuleMatch = z.object({
    transactionId: Id,
    accountId: Id,
    bookingDate: IsoDate,
    amount: Cents,
    counterpartyName: z.string(),
    ultimateParty: z.string(),
    remittance: z.string(),
    categoryId: Id,
    ruleId: Id,
});
export type RuleMatch = z.infer<typeof RuleMatch>;
export const RULE_PREVIEW_LIMIT = 5000;
export const RulePreview = z.object({
    items: z.array(RuleMatch).describe(`Bookings without category a rule would categorize, newest first; at most ${RULE_PREVIEW_LIMIT}`),
    total: z.number().int(),
});
export type RulePreview = z.infer<typeof RulePreview>;
export const ApplyRulesRequest = z.object({
    ids: z.array(Id).min(1).max(RULE_PREVIEW_LIMIT).describe("The confirmed bookings from the preview"),
    ruleId: Id.optional().describe("Only this rule, as in the preview"),
});
export const ApplyRulesResponse = z.object({ changed: z.number().int() });

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
    overwriteCategories: z.boolean().optional().describe("Give bookings already stored the category the file names where it differs; split bookings stay as they are"),
    excludeLines: z.array(z.number().int().min(1)).max(1_000_000).optional().describe("Rows of the file (`line` of the preview) that change nothing; only for the import itself"),
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
        .enum(["same", "differs", "split"])
        .nullable()
        .describe("Duplicate whose file names a category: same as the stored booking, differs from it, or the stored booking is split (never overwritten)"),
    error: z.string().nullable(),
});

export const ImportPreview = z.object({
    header: z.array(z.string()),
    columns: ColumnMapSchema.describe("Columns assigned directly; a field fed by a step has none"),
    format: ImportFormatDefinition.describe("The format the preview was made with"),
    formatKey: z.string().nullable().describe("The stored format chosen by the header; null for the automatic column assignment or a format sent with the request"),
    rows: z.array(ImportPreviewRow),
    newCategories: z.array(z.string()).describe("Missing categories named by the new rows and the duplicates with a differing category"),
    counts: z.object({
        new: z.number().int(),
        duplicate: z.number().int(),
        invalid: z.number().int(),
        differs: z.number().int().describe("Duplicates with a differing category"),
        filled: z.number().int().describe("Duplicates with an empty kind of booking or detail the file fills in"),
    }),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportResult = z.object({
    importId: Id,
    imported: z.number().int(),
    skipped: z.number().int(),
    invalid: z.number().int(),
    createdCategories: z.number().int(),
    recategorized: z.number().int().describe("Bookings already stored that got the category of the file"),
    bookingTextsFilled: z.number().int().describe("Bookings already stored whose empty kind of booking came from the file"),
    detailsFilled: z.number().int().describe("Bookings already stored with an empty reference, mandate, creditor id or BIC that came from the file"),
    filled: z.number().int().describe("Bookings already stored that got a kind of booking, a detail or both"),
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
