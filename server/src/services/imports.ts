import { duplicateKey, guessColumns, IMPORT_FIELDS, mapRows, readCsv, ROTATING_COLORS, sameCounterparty, type ColumnMap, type ImportPreview, type ImportRecord, type ImportRow } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { badRequest, notFound } from "../http/errors.js";
import { requireAccount } from "./accounts.js";
import { createCategory } from "./categories.js";
import { activeRules, firstMatch } from "./rules.js";
import { queryTargets } from "./querytarget.js";
import { markNew } from "./unread.js";

interface Planned extends ImportRow {
    state: "new" | "duplicate" | "invalid";
    categoryId: number | null;
    categorySource: "rule" | "auto" | null;
    ruleId: number | null;
    missing: MissingCategory | null;
    /** Duplicate: the booking already stored, its category and how the file's category compares. */
    storedId: number | null;
    storedCategoryId: number | null;
    categoryState: "same" | "differs" | "split" | null;
}

const NO_CATEGORY = { categoryId: null, categorySource: null, ruleId: null, missing: null, storedId: null, storedCategoryId: null, categoryState: null } as const;

/** A category the file names that does not exist yet, with the path leading to it. */
interface MissingCategory {
    key: string;
    label: string;
    path: string[];
}

type CategoryRef = { id: number; parentId: number | null; name: string };

const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

// A hyphen only separates with spaces around it, so "Kfz-Versicherung" stays one name
const PATH_SEPARATOR = /\s*(?:\\|\/|›|>|:|\|)\s*|\s+[-–]\s+/;

/**
 * Splits a category path from a file ("Wohnen\Miete", "Lebensmittel › Bäckerei",
 * "Alle - Wohnen - Miete"). The root "Alle" of MoneyMoney exports is dropped.
 */
export function splitCategoryPath(text: string): string[] {
    const parts = text.split(PATH_SEPARATOR).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && fold(parts[0]!) === "alle") parts.shift();
    return parts;
}

/**
 * Finds a category by the text of a file's category column. The whole text as a name wins,
 * then the last part of the path; among equal names the one whose ancestors match more of
 * the path wins.
 */
export function categoryByName(categories: CategoryRef[], text: string): number | null {
    const whole = fold(text);
    const exact = categories.find((c) => fold(c.name) === whole);
    if (exact) return exact.id;
    const parts = splitCategoryPath(text).map(fold);
    if (!parts.length) return null;
    const byId = new Map(categories.map((c) => [c.id, c]));
    // How many parts above the leaf match the category's ancestors, from the bottom up
    const score = (c: CategoryRef): number => {
        let n = 0;
        let up = c.parentId !== null ? byId.get(c.parentId) : undefined;
        for (let i = parts.length - 2; i >= 0 && up && fold(up.name) === parts[i]; i--) {
            n++;
            up = up.parentId !== null ? byId.get(up.parentId) : undefined;
        }
        return n;
    };
    let best: { id: number; score: number } | null = null;
    for (const c of categories) {
        if (fold(c.name) !== parts[parts.length - 1]) continue;
        const s = score(c);
        if (!best || s > best.score) best = { id: c.id, score: s };
    }
    return best?.id ?? null;
}

/** The category to create for a path that names no existing one. */
function missingCategory(text: string): MissingCategory | null {
    const path = splitCategoryPath(text);
    if (!path.length) return null;
    return { key: path.map(fold).join("|"), label: path.join(" › "), path };
}

function plan(db: Db, accountId: number, content: string, columns?: ColumnMap): { header: string[]; columns: ColumnMap; rows: Planned[] } {
    requireAccount(db, accountId);
    const table = readCsv(content);
    if (!table.header.length) throw badRequest("In der Datei steht keine Tabelle.", "empty_file");
    const map = columns ?? guessColumns(table.header);
    for (const f of IMPORT_FIELDS) {
        const at = map[f];
        if (at !== null && at >= table.header.length) throw badRequest("Die Spaltenzuordnung passt nicht zur Datei.");
    }
    const parsed = mapRows(table, map);
    const dates = parsed.map((r) => r.date).filter((d): d is string => !!d).sort();
    // Stored bookings by day and amount, with their counterparty
    const existing = new Map<string, { id: number; iban: string | null; name: string }[]>();
    if (dates.length) {
        const rows = db
            .prepare("SELECT id, booking_date, amount, counterparty_name, counterparty_iban FROM transactions WHERE account_id = ? AND booking_date BETWEEN ? AND ?")
            .all(accountId, dates[0], dates[dates.length - 1]) as { id: number; booking_date: string; amount: number; counterparty_name: string; counterparty_iban: string | null }[];
        for (const r of rows) {
            const key = duplicateKey(r.booking_date, r.amount);
            const list = existing.get(key) ?? [];
            list.push({ id: r.id, iban: r.counterparty_iban, name: r.counterparty_name });
            existing.set(key, list);
        }
    }
    const categories = db.prepare("SELECT id, parent_id AS parentId, name FROM categories").all() as CategoryRef[];
    const rules = activeRules(db);
    const target = queryTargets(db);
    const storedCategories = db.prepare("SELECT category_id FROM transaction_categories WHERE transaction_id = ?").pluck();
    const rows = parsed.map((r): Planned => {
        if (r.error || !r.date || r.amount === null) return { ...r, state: "invalid", ...NO_CATEGORY };
        // Each booking already stored covers one equal row of the file, no more
        const stored = existing.get(duplicateKey(r.date, r.amount)) ?? [];
        const at = stored.findIndex((c) => sameCounterparty(c, r));
        if (at >= 0) {
            const [match] = stored.splice(at, 1);
            return duplicate(r, match!.id, storedCategories.all(match!.id) as number[], categories);
        }
        const fromFile = r.category ? categoryByName(categories, r.category) : null;
        if (fromFile) return { ...r, state: "new", ...NO_CATEGORY, categoryId: fromFile, categorySource: "auto" };
        // Unless missing categories get created, the rules decide
        const missing = r.category ? missingCategory(r.category) : null;
        const rule = firstMatch(
            rules,
            target({ account_id: accountId, booking_date: r.date, amount: r.amount, counterparty_name: r.name, ultimate_party: "", counterparty_iban: r.iban, remittance: r.purpose, category_id: null }),
        );
        return { ...r, state: "new", ...NO_CATEGORY, categoryId: rule?.categoryId ?? null, categorySource: rule ? "rule" : null, ruleId: rule?.id ?? null, missing };
    });
    return { header: table.header, columns: map, rows };
}

/**
 * A row of the file that is stored already, compared by the category the file names. Only the
 * file counts here, no rules. A split booking is never overwritten, so its missing category is
 * not offered for creation either.
 */
function duplicate(r: ImportRow, storedId: number, stored: number[], categories: CategoryRef[]): Planned {
    const base: Planned = { ...r, state: "duplicate", ...NO_CATEGORY, storedId, storedCategoryId: stored.length === 1 ? stored[0]! : null };
    if (!r.category) return base;
    const fromFile = categoryByName(categories, r.category);
    const missing = fromFile ? null : missingCategory(r.category);
    if (!fromFile && !missing) return base;
    if (stored.length > 1) return { ...base, categoryId: fromFile, categoryState: "split" };
    if (fromFile !== null && fromFile === base.storedCategoryId) return { ...base, categoryId: fromFile, categoryState: "same" };
    return { ...base, categoryId: fromFile, categorySource: "auto", missing, categoryState: "differs" };
}

function uniqueMissing(rows: Planned[]): Map<string, MissingCategory> {
    const out = new Map<string, MissingCategory>();
    for (const r of rows) if (r.missing && !out.has(r.missing.key)) out.set(r.missing.key, r.missing);
    return out;
}

/**
 * An arbitrary colour for a new category: one none of its siblings shows yet while there is
 * such a colour, else any.
 */
function arbitraryColor(db: Db, parentId: number | null): string {
    const used = new Set((db.prepare("SELECT DISTINCT color FROM categories WHERE parent_id IS ?").all(parentId) as { color: string | null }[]).map((r) => r.color));
    const free = ROTATING_COLORS.filter((c) => !used.has(c));
    const pool = free.length ? free : ROTATING_COLORS;
    return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Creates the missing categories once each; returns the id per key and how many were made.
 * A path starts at a top-level category of its first name, else at any category of that name,
 * else at a new top-level category, and goes down from there, creating what is missing.
 * Every new category takes an arbitrary colour of its own.
 */
function createMissing(db: Db, missing: Map<string, MissingCategory>): { ids: Map<string, number>; created: number } {
    const usable = db.prepare("SELECT id, parent_id AS parentId, name FROM categories ORDER BY position, id").all() as CategoryRef[];
    const child = new Map<string, number>();
    const childKey = (parentId: number | null, name: string): string => `${parentId ?? ""}|${fold(name)}`;
    for (const r of usable) if (!child.has(childKey(r.parentId, r.name))) child.set(childKey(r.parentId, r.name), r.id);
    const anywhere = new Map<string, number>();
    for (const r of usable) if (!anywhere.has(fold(r.name))) anywhere.set(fold(r.name), r.id);
    const ids = new Map<string, number>();
    let created = 0;
    const find = (parentId: number | null, name: string): number => {
        const key = childKey(parentId, name);
        const known = child.get(key) ?? (parentId === null ? anywhere.get(fold(name)) : undefined);
        if (known !== undefined) return known;
        created++;
        const id = createCategory(db, { parentId, name, color: arbitraryColor(db, parentId) }).id;
        child.set(key, id);
        if (!anywhere.has(fold(name))) anywhere.set(fold(name), id);
        return id;
    };
    for (const m of missing.values()) {
        let parentId: number | null = null;
        for (const name of m.path) parentId = find(parentId, name);
        ids.set(m.key, parentId!);
    }
    return { ids, created };
}

export function previewImport(db: Db, accountId: number, content: string, columns?: ColumnMap): ImportPreview {
    const p = plan(db, accountId, content, columns);
    const counts = { new: 0, duplicate: 0, invalid: 0, differs: 0 };
    for (const r of p.rows) {
        counts[r.state]++;
        if (r.categoryState === "differs") counts.differs++;
    }
    return {
        header: p.header,
        columns: p.columns,
        counts,
        newCategories: [...uniqueMissing(p.rows).values()].map((m) => m.label),
        rows: p.rows.map((r) => ({
            line: r.line,
            date: r.date,
            amount: r.amount,
            name: r.name,
            iban: r.iban,
            purpose: r.purpose,
            pending: r.pending,
            categoryId: r.categoryId,
            newCategory: r.missing?.label ?? null,
            state: r.state,
            storedCategoryId: r.storedCategoryId,
            categoryState: r.categoryState,
            error: r.error,
        })),
    };
}

export function commitImport(
    db: Db,
    accountId: number,
    fileName: string,
    content: string,
    columns: ColumnMap | undefined,
    userId: number | null,
    createCategories = false,
    overwriteCategories = false,
): { importId: number; imported: number; skipped: number; invalid: number; createdCategories: number; recategorized: number } {
    const p = plan(db, accountId, content, columns);
    const fresh = p.rows.filter((r) => r.state === "new");
    const differing = overwriteCategories ? p.rows.filter((r) => r.categoryState === "differs") : [];
    let createdCategories = 0;
    if (createCategories) {
        // The file decides over the rules for the categories it names
        const { ids, created } = createMissing(db, uniqueMissing([...fresh, ...differing]));
        createdCategories = created;
        for (const r of [...fresh, ...differing]) {
            if (!r.missing) continue;
            r.categoryId = ids.get(r.missing.key) ?? null;
            r.categorySource = "auto";
            r.ruleId = null;
        }
    }
    const skipped = p.rows.filter((r) => r.state === "duplicate").length;
    const invalid = p.rows.filter((r) => r.state === "invalid").length;
    const now = nowIso();
    const importId = Number(
        db.prepare("INSERT INTO imports (account_id, file_name, imported_at, user_id, rows, imported, skipped, column_map) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
            accountId,
            fileName,
            now,
            userId,
            p.rows.length,
            fresh.length,
            skipped,
            JSON.stringify(p.columns),
        ).lastInsertRowid,
    );
    const insertTx = db.prepare(
        `INSERT INTO transactions (account_id, booking_date, value_date, amount, counterparty_name, counterparty_iban, remittance, status, first_seen_at, source, import_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`,
    );
    const insertCat = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, ?, ?)");
    const ids: number[] = [];
    for (const r of fresh) {
        const id = Number(insertTx.run(accountId, r.date, r.valueDate ?? r.date, r.amount, r.name, r.iban, r.purpose, r.pending ? "pending" : "booked", now, importId, userId).lastInsertRowid);
        if (r.categoryId) insertCat.run(id, r.categoryId, r.amount, r.categorySource ?? "auto", r.ruleId);
        ids.push(id);
    }
    // New for the others; the importing user saw them in the preview
    markNew(db, ids, userId);
    // Bookings already stored take the file's category as if assigned by hand
    const clear = db.prepare("DELETE FROM transaction_categories WHERE transaction_id = ?");
    let recategorized = 0;
    for (const r of differing) {
        if (r.categoryId === null || r.storedId === null) continue;
        clear.run(r.storedId);
        insertCat.run(r.storedId, r.categoryId, r.amount, "manual", null);
        recategorized++;
    }
    return { importId, imported: fresh.length, skipped, invalid, createdCategories, recategorized };
}

export function listImports(db: Db): ImportRecord[] {
    return db
        .prepare(
            `SELECT i.id, i.account_id AS accountId, i.file_name AS fileName, i.imported_at AS importedAt, u.name AS userName,
                    i.rows, i.imported, i.skipped,
                    (SELECT count(*) FROM transactions t WHERE t.import_id = i.id) AS remaining
             FROM imports i LEFT JOIN users u ON u.id = i.user_id ORDER BY i.id DESC`,
        )
        .all() as ImportRecord[];
}

/** Deletes an import: the bookings it brought in that still exist, then its record. */
export function undoImport(db: Db, id: number): { accountId: number; fileName: string; removed: number } {
    const row = db.prepare("SELECT account_id, file_name FROM imports WHERE id = ?").get(id) as { account_id: number; file_name: string } | undefined;
    if (!row) throw notFound("Import");
    // Counter bookings made from imported bookings go too
    db.prepare("DELETE FROM transactions WHERE source = 'manual' AND counter_transaction_id IN (SELECT id FROM transactions WHERE import_id = ?)").run(id);
    const removed = db.prepare("DELETE FROM transactions WHERE import_id = ?").run(id).changes;
    db.prepare("DELETE FROM imports WHERE id = ?").run(id);
    return { accountId: row.account_id, fileName: row.file_name, removed };
}
