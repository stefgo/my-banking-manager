import {
    CARD_CONFIGS,
    CARD_SIZES,
    clampCardSize,
    DEFAULT_CARDS,
    DEFAULT_SETTINGS,
    type ProfileDefaults,
    SETTINGS,
    SETTING_KEYS,
    type Card,
    type CardType,
    type ClientKind,
    type SettingKey,
    type Settings,
} from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { badRequest, notFound } from "../http/errors.js";

/**
 * Settings of a user as one device class sees them: its own per-class values, the shared ones,
 * and for everything not set yet the start values of the configuration or the fallback defaults.
 */
export function readSettings(db: Db, userId: number, client: ClientKind, defaults?: ProfileDefaults): Settings {
    const rows = db.prepare("SELECT scope, key, value FROM user_settings WHERE user_id = ? AND scope IN ('all', ?)").all(userId, client) as {
        scope: string;
        key: string;
        value: string;
    }[];
    const settings = { ...DEFAULT_SETTINGS, ...defaults } as Record<string, unknown>;
    for (const key of SETTING_KEYS) {
        const scope = SETTINGS[key].perClient ? client : "all";
        const row = rows.find((r) => r.key === key && r.scope === scope);
        if (!row) continue;
        const parsed = SETTINGS[key].schema.safeParse(JSON.parse(row.value));
        if (parsed.success) settings[key] = parsed.data;
    }
    return settings as Settings;
}

export function writeSetting(db: Db, userId: number, client: ClientKind, key: SettingKey, value: unknown): void {
    const parsed = SETTINGS[key].schema.safeParse(value);
    if (!parsed.success) throw badRequest(`Ungültiger Wert für „${key}“: ${parsed.error.issues[0]?.message ?? ""}`);
    const scope = SETTINGS[key].perClient ? client : "all";
    db.prepare(
        `INSERT INTO user_settings (user_id, scope, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(userId, scope, key, JSON.stringify(parsed.data), nowIso());
}

// ---------- Cards ----------

interface CardRow {
    id: number;
    position: number;
    type: CardType;
    width: number;
    height: number | null;
    title: string | null;
    config: string;
}

/** Checks a card's settings against the schema of its type and fills in the defaults. */
export function parseCardConfig(type: CardType, config: unknown): Record<string, unknown> {
    const parsed = CARD_CONFIGS[type].safeParse(config ?? {});
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw badRequest(`Ungültige Einstellung der Karte${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}`);
    }
    return parsed.data as Record<string, unknown>;
}

const toCard = (r: CardRow): Card => {
    // A stored config that no longer fits its type falls back to the defaults instead of failing
    let config: Record<string, unknown>;
    try {
        config = parseCardConfig(r.type, JSON.parse(r.config));
    } catch {
        config = parseCardConfig(r.type, {});
    }
    return { id: r.id, position: r.position, type: r.type, width: r.width, height: r.height, title: r.title, config };
};

export function listCards(db: Db, userId: number): Card[] {
    return (db.prepare("SELECT * FROM dashboard_cards WHERE user_id = ? ORDER BY position, id").all(userId) as CardRow[]).map(toCard);
}

function getCard(db: Db, userId: number, id: number): CardRow {
    const row = db.prepare("SELECT * FROM dashboard_cards WHERE id = ? AND user_id = ?").get(id, userId) as CardRow | undefined;
    if (!row) throw notFound("Karte");
    return row;
}

interface CardInput {
    width?: number;
    height?: number | null;
    title?: string | null;
    config?: unknown;
}

// A size below the type's minimum is raised to it rather than refused, so an older client can't break a card
export function createCard(db: Db, userId: number, input: CardInput & { type: CardType }): Card {
    const config = parseCardConfig(input.type, input.config);
    const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM dashboard_cards WHERE user_id = ?").get(userId) as { p: number }).p;
    const { width, height } = clampCardSize(input.type, input.width ?? CARD_SIZES[input.type].width, input.height ?? null);
    const id = Number(
        db.prepare("INSERT INTO dashboard_cards (user_id, position, type, width, height, title, config) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            userId,
            pos,
            input.type,
            width,
            height,
            input.title || null,
            JSON.stringify(config),
        ).lastInsertRowid,
    );
    return toCard(getCard(db, userId, id));
}

export function updateCard(db: Db, userId: number, id: number, input: CardInput): Card {
    const row = getCard(db, userId, id);
    const config = input.config !== undefined ? parseCardConfig(row.type, { ...JSON.parse(row.config), ...(input.config as object) }) : JSON.parse(row.config);
    const { width, height } = clampCardSize(row.type, input.width ?? row.width, input.height === undefined ? row.height : input.height);
    db.prepare("UPDATE dashboard_cards SET width = ?, height = ?, title = ?, config = ? WHERE id = ?").run(
        width,
        height,
        input.title === undefined ? row.title : input.title || null,
        JSON.stringify(config),
        id,
    );
    return toCard(getCard(db, userId, id));
}

export function deleteCard(db: Db, userId: number, id: number): void {
    getCard(db, userId, id);
    db.prepare("DELETE FROM dashboard_cards WHERE id = ?").run(id);
}

export function orderCards(db: Db, userId: number, ids: number[]): void {
    const own = new Set((db.prepare("SELECT id FROM dashboard_cards WHERE user_id = ?").all(userId) as { id: number }[]).map((r) => r.id));
    if (ids.length !== own.size || ids.some((id) => !own.has(id))) throw badRequest("Die Reihenfolge muss alle Karten genau einmal nennen.");
    const stmt = db.prepare("UPDATE dashboard_cards SET position = ? WHERE id = ?");
    ids.forEach((id, i) => stmt.run(i, id));
}

export function resetCards(db: Db, userId: number): Card[] {
    db.prepare("DELETE FROM dashboard_cards WHERE user_id = ?").run(userId);
    for (const c of DEFAULT_CARDS) createCard(db, userId, { type: c.type, width: c.width });
    return listCards(db, userId);
}

/** A new user starts with the default overview. */
export function ensureCards(db: Db, userId: number): void {
    const n = (db.prepare("SELECT count(*) AS n FROM dashboard_cards WHERE user_id = ?").get(userId) as { n: number }).n;
    if (n === 0) resetCards(db, userId);
}
