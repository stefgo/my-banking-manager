import { z } from "zod";
import { Id } from "./common.js";

// ---------- Settings of the user profile ----------

export const ClientKind = z.enum(["web", "macos"]);
export type ClientKind = z.infer<typeof ClientKind>;

/** Device classes as the UI names them. */
export const CLIENT_LABELS: Record<ClientKind, string> = { web: "Browser", macos: "macOS" };

export const TxRange = z.enum(["month", "last", "30", "90", "365", "all"]);
export type TxRange = z.infer<typeof TxRange>;

export const Theme = z.enum(["system", "dark", "light"]);
export type Theme = z.infer<typeof Theme>;

/**
 * Every setting the server keeps in the profile: its type, its fallback default and whether it is
 * kept per device class (`perClient`) or for all clients of the user. A new setting is one more
 * entry here; the database needs no change. View state a client keeps for itself (in the web
 * client: sidebar width, folded tree nodes, balance chart, filters per account) is not part of it.
 */
export const SETTINGS = {
    theme: { perClient: true, schema: Theme, default: "dark" as const },
    hideAmountsOnStart: { perClient: true, schema: z.boolean(), default: false },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTINGS)[K]["schema"]> };

export const SettingsSchema = z.object(
    Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].schema])) as { [K in SettingKey]: (typeof SETTINGS)[K]["schema"] },
);

export const DEFAULT_SETTINGS = Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default])) as Settings;

/** Start values per device class that the server's configuration sets, until a user changes them. */
export const ProfileDefaults = z.object({
    theme: Theme.default(SETTINGS.theme.default),
    hideAmountsOnStart: z.boolean().default(SETTINGS.hideAmountsOnStart.default),
});
export type ProfileDefaults = z.infer<typeof ProfileDefaults>;

export const SetSettingRequest = z.object({ value: z.unknown() });
export const SettingParams = z.object({ key: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]) });
export const ClientQuery = z.object({ client: ClientKind.default("web") });

// ---------- Cards of the overview ----------

/** "all", "group:<id>" or "account:<id>". */
export const AccountScope = z.string().regex(/^(all|group:\d+|account:\d+)$/, "Konto, Gruppe oder alle");
export type AccountScope = z.infer<typeof AccountScope>;

export const CARD_TYPES = ["balance", "recent", "groups", "cashflow", "upcoming", "category"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_LABELS: Record<CardType, string> = {
    balance: "Saldo mit Verlauf",
    recent: "Letzte Umsätze",
    groups: "Kontogruppen",
    cashflow: "Eingänge und Ausgaben",
    upcoming: "Demnächst",
    category: "Kategorie im Monat",
};

export const CardPeriod = z.enum(["month", "lastMonth", "30", "90"]);

export const CARD_CONFIGS = {
    balance: z.object({
        scope: AccountScope.default("all"),
        days: z.union([z.literal(30), z.literal(90)]).default(30),
        forecast: z.boolean().default(true),
    }),
    recent: z.object({
        scope: AccountScope.default("all"),
        categoryId: Id.nullable().default(null),
        pendingOnly: z.boolean().default(false),
        count: z.number().int().min(3).max(25).default(8),
    }),
    groups: z.object({
        rootGroupId: Id.nullable().default(null),
        depth: z.number().int().min(1).max(4).default(3),
    }),
    cashflow: z.object({
        scope: AccountScope.default("all"),
        period: CardPeriod.default("month"),
    }),
    upcoming: z.object({
        scope: AccountScope.default("all"),
        count: z.number().int().min(1).max(20).default(5),
        days: z.number().int().min(7).max(90).default(30),
    }),
    category: z.object({
        categoryId: Id.nullable().default(null),
        scope: AccountScope.default("all"),
        period: CardPeriod.default("month"),
    }),
} as const;

/** Overview grid: 12 columns, rows of a fixed height (see the web client's `.card-grid`). */
export const GRID_COLUMNS = 12;
export const GRID_MAX_ROWS = 12;

/** Width in grid columns (1–12). */
export const CardWidth = z.number().int().min(1).max(GRID_COLUMNS);
/** Height in grid rows (2–12); `null` follows the content. */
export const CardHeight = z.number().int().min(2).max(GRID_MAX_ROWS).nullable();

/** Default width and the smallest size a card's content still fits in, per type. */
export const CARD_SIZES: Record<CardType, { width: number; minWidth: number; minHeight: number }> = {
    balance: { width: 8, minWidth: 4, minHeight: 5 },
    recent: { width: 8, minWidth: 4, minHeight: 3 },
    groups: { width: 4, minWidth: 3, minHeight: 3 },
    cashflow: { width: 4, minWidth: 3, minHeight: 2 },
    upcoming: { width: 4, minWidth: 3, minHeight: 2 },
    category: { width: 4, minWidth: 3, minHeight: 3 },
};

/** Raises a size below the type's minimum to that minimum. */
export function clampCardSize(type: CardType, width: number, height: number | null): { width: number; height: number | null } {
    const min = CARD_SIZES[type];
    return {
        width: Math.min(GRID_COLUMNS, Math.max(min.minWidth, width)),
        height: height === null ? null : Math.min(GRID_MAX_ROWS, Math.max(min.minHeight, height)),
    };
}

export const Card = z.object({
    id: Id,
    position: z.number().int(),
    type: z.enum(CARD_TYPES),
    width: CardWidth,
    height: CardHeight,
    title: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
});
export type Card = z.infer<typeof Card>;

export const CreateCardRequest = z.object({
    type: z.enum(CARD_TYPES),
    width: CardWidth.optional(),
    height: CardHeight.optional(),
    title: z.string().trim().max(60).nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
});
export const UpdateCardRequest = z.object({
    width: CardWidth.optional(),
    height: CardHeight.optional(),
    title: z.string().trim().max(60).nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
});
export const OrderCardsRequest = z.object({ ids: z.array(Id) });

/** The overview a new user starts with (the click dummy's overview). */
export const DEFAULT_CARDS: { type: CardType; width: number }[] = [
    { type: "balance", width: 8 },
    { type: "groups", width: 4 },
    { type: "recent", width: 8 },
    { type: "cashflow", width: 4 },
    { type: "upcoming", width: 4 },
];

export const Profile = z.object({
    settings: SettingsSchema,
    cards: z.array(Card),
});
export type Profile = z.infer<typeof Profile>;
