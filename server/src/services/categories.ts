import { ROTATING_COLORS, type Category, type CategoryList, type Info, type UncategorizedSlot } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { badRequest, notFound } from "../http/errors.js";
import { infoValues, readInfo, type InfoColumns } from "./info.js";

interface CategoryRow extends InfoColumns {
    id: number;
    parent_id: number | null;
    name: string;
    icon: string;
    color: string | null;
    position: number;
    excluded_from_stats: number;
    counter_default: number;
    count: number;
}

const toCategory = (r: CategoryRow): Category => ({
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    icon: r.icon,
    color: r.color,
    position: r.position,
    excludedFromStats: r.excluded_from_stats === 1,
    counterDefault: r.counter_default === 1,
    count: r.count,
    info: readInfo(r),
});

const SELECT = `SELECT c.*, (SELECT count(*) FROM transaction_categories tc WHERE tc.category_id = c.id) AS count FROM categories c`;

export function listCategories(db: Db): CategoryList {
    const items = (db.prepare(`${SELECT} ORDER BY c.position, c.id`).all() as CategoryRow[]).map(toCategory);
    const uncategorized = (db.prepare("SELECT count(*) AS n FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM transaction_categories c WHERE c.transaction_id = t.id)").get() as { n: number }).n;
    return { items, uncategorized, none: getSlot(db) };
}

export function getCategory(db: Db, id: number): Category {
    const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as CategoryRow | undefined;
    if (!row) throw notFound("Kategorie");
    return toCategory(row);
}

/** Ids of a category and all its descendants, the category first. */
export function descendantIds(db: Db, id: number): number[] {
    const rows = db
        .prepare(
            `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id)
             SELECT id FROM sub`,
        )
        .all(id) as { id: number }[];
    return rows.map((r) => r.id);
}

/** The colour a category shows: its own, else that of the nearest ancestor with one. */
function effectiveColor(db: Db, id: number): string | null {
    const row = db
        .prepare(
            `WITH RECURSIVE up(id, parent_id, color, depth) AS (
                 SELECT id, parent_id, color, 0 FROM categories WHERE id = ?
                 UNION ALL SELECT c.id, c.parent_id, c.color, up.depth + 1 FROM categories c JOIN up ON c.id = up.parent_id
             )
             SELECT color FROM up WHERE color IS NOT NULL ORDER BY depth LIMIT 1`,
        )
        .get(id) as { color: string } | undefined;
    return row?.color ?? null;
}

// ---------- "Ohne Kategorie" in the tree ----------

/** Where "Ohne Kategorie" sits; no row means top level, last. */
export function getSlot(db: Db): UncategorizedSlot {
    const row = db.prepare("SELECT parent_id AS parentId, position FROM uncategorized_slot WHERE id = 1").get() as UncategorizedSlot | undefined;
    return row ?? { parentId: null, position: null };
}

function setSlot(db: Db, parentId: number | null, position: number | null): void {
    db.prepare(
        `INSERT INTO uncategorized_slot (id, parent_id, position) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, position = excluded.position`,
    ).run(parentId, position);
}

/** A row below a parent: a category id, or "none" for "Ohne Kategorie". */
type Sibling = number | "none";

/** Children of a parent in display order, "Ohne Kategorie" included when it sits there. */
function siblingOrder(db: Db, parentId: number | null): Sibling[] {
    const rows = db.prepare("SELECT id, position FROM categories WHERE parent_id IS ? ORDER BY position, id").all(parentId) as { id: number; position: number }[];
    const out: Sibling[] = rows.map((r) => r.id);
    const slot = getSlot(db);
    if (slot.parentId === parentId) {
        const at = slot.position === null ? -1 : rows.findIndex((r) => r.position >= slot.position!);
        out.splice(at < 0 ? out.length : at, 0, "none");
    }
    return out;
}

/** Stores the order of a parent's children; "Ohne Kategorie" at the end stays last for later additions. */
function renumber(db: Db, parentId: number | null, order: Sibling[]): void {
    const stmt = db.prepare("UPDATE categories SET parent_id = ?, position = ? WHERE id = ?");
    order.forEach((item, i) => {
        if (item === "none") setSlot(db, parentId, i === order.length - 1 ? null : i);
        else stmt.run(parentId, i, item);
    });
}

/**
 * Puts `item` at `index` of the parent's children, taking it from where it was. An index past the
 * end appends a category like a new one: before "Ohne Kategorie" when that stays last.
 */
function place(db: Db, item: Sibling, from: number | null, to: number | null, index: number): void {
    if (from !== to) renumber(db, from, siblingOrder(db, from).filter((x) => x !== item));
    const order = siblingOrder(db, to).filter((x) => x !== item);
    const slot = getSlot(db);
    const keepLast = item !== "none" && index > order.length && slot.parentId === to && slot.position === null;
    order.splice(keepLast ? order.length - 1 : Math.min(index, order.length), 0, item);
    renumber(db, to, order);
}

export function moveUncategorized(db: Db, input: { parentId: number | null; index: number }): void {
    if (input.parentId !== null) getCategory(db, input.parentId);
    place(db, "none", getSlot(db).parentId, input.parentId, input.index);
}

export function createCategory(db: Db, input: { parentId: number | null; name: string; icon?: string; color?: string | null }): Category {
    let icon = input.icon;
    let color = input.color;
    if (input.parentId !== null) {
        const parent = getCategory(db, input.parentId);
        icon ??= parent.icon;
        color ??= null;
    } else {
        icon ??= "tag";
        // A new top-level category takes the next colour in turn
        const n = (db.prepare("SELECT count(*) AS n FROM categories WHERE parent_id IS NULL").get() as { n: number }).n;
        color ??= ROTATING_COLORS[n % ROTATING_COLORS.length]!;
    }
    const pos = siblingOrder(db, input.parentId).length;
    const id = Number(
        db.prepare("INSERT INTO categories (parent_id, name, icon, color, position, excluded_from_stats) VALUES (?, ?, ?, ?, ?, 0)").run(
            input.parentId,
            input.name,
            icon,
            color,
            pos,
        ).lastInsertRowid,
    );
    return getCategory(db, id);
}

export function updateCategory(db: Db, id: number, input: { name?: string; icon?: string; color?: string | null; excludedFromStats?: boolean; counterDefault?: boolean; info?: Info },
): Category {
    const row = db.prepare("SELECT info_attributes, info_notes FROM categories WHERE id = ?").get(id) as InfoColumns | undefined;
    if (!row) throw notFound("Kategorie");
    const cat = getCategory(db, id);
    if (input.color === null && cat.parentId === null) throw badRequest("Eine Hauptkategorie braucht eine Farbe.");
    db.prepare("UPDATE categories SET name = ?, icon = ?, color = ?, excluded_from_stats = ?, info_attributes = ?, info_notes = ? WHERE id = ?").run(
        input.name ?? cat.name,
        input.icon ?? cat.icon,
        input.color === undefined ? cat.color : input.color,
        input.excludedFromStats === undefined ? (cat.excludedFromStats ? 1 : 0) : input.excludedFromStats ? 1 : 0,
        ...infoValues(row, input.info),
        id,
    );
    if (input.counterDefault !== undefined) {
        // Only one category is the preset of counter bookings
        if (input.counterDefault) db.prepare("UPDATE categories SET counter_default = 0 WHERE counter_default = 1 AND id <> ?").run(id);
        db.prepare("UPDATE categories SET counter_default = ? WHERE id = ?").run(input.counterDefault ? 1 : 0, id);
    }
    return getCategory(db, id);
}

/** Deletes a category and all its descendants. Their bookings move to `moveTo` or lose their category. */
export function deleteCategory(db: Db, id: number, moveTo?: number): Category {
    const cat = getCategory(db, id);
    const ids = descendantIds(db, id);
    if (moveTo !== undefined) {
        if (ids.includes(moveTo)) throw badRequest("Die Umsätze können nicht in eine Kategorie wandern, die mit gelöscht wird.");
        getCategory(db, moveTo);
        const marks = ids.map(() => "?").join(",");
        // Shares of a booking that meet in `moveTo` become one share, their amounts added up
        db.prepare(
            `INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id)
             SELECT transaction_id, ?, SUM(amount), 'manual', NULL FROM transaction_categories WHERE category_id IN (${marks}) GROUP BY transaction_id
             ON CONFLICT (transaction_id, category_id) DO UPDATE SET amount = amount + excluded.amount, source = 'manual', rule_id = NULL`,
        ).run(moveTo, ...ids);
        db.prepare(`DELETE FROM transaction_categories WHERE category_id IN (${marks})`).run(...ids);
        db.prepare(`UPDATE rules SET category_id = ? WHERE category_id IN (${marks})`).run(moveTo, ...ids);
    }
    // "Ohne Kategorie" below the deleted ones takes the deleted category's place
    const order = siblingOrder(db, cat.parentId);
    const slot = getSlot(db);
    const keep = slot.parentId !== null && ids.includes(slot.parentId);
    db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    // A rule only loses this action; one with nothing left to do goes
    db.prepare("DELETE FROM rules WHERE category_id IS NULL AND edits = '[]'").run();
    renumber(db, cat.parentId, keep ? order.map((x) => (x === id ? "none" : x)) : order.filter((x) => x !== id));
    return cat;
}

export function moveCategory(db: Db, input: { id: number; parentId: number | null; index: number }): void {
    const cat = getCategory(db, input.id);
    if (input.parentId !== null) {
        if (descendantIds(db, input.id).includes(input.parentId)) throw badRequest("Eine Kategorie kann nicht in sich selbst oder eine ihrer Unterkategorien wandern.");
        getCategory(db, input.parentId);
    }
    if (cat.parentId !== input.parentId) {
        // Becoming a top-level category needs an own colour: keep the one it showed so far
        if (input.parentId === null && !cat.color) {
            db.prepare("UPDATE categories SET color = ? WHERE id = ?").run(effectiveColor(db, input.id) ?? "neutral", input.id);
        }
    }
    place(db, input.id, cat.parentId, input.parentId, input.index);
}
