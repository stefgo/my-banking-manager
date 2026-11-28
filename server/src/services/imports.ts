import { columnsFromFormat, duplicateKey, evaluateRules, formatFromColumns, guessColumns, IMPORT_FIELDS, isReturnText, mapFormatRows, matchFormat, missingColumns, readCsv, readWithFormat, REFERENCE_KINDS, referenceMatch, ROTATING_COLORS, sameCounterparty, sameReference, type ColumnMap, type ImportFillField, type ImportFormatDefinition, type ImportPreview, type ImportRecord, type ImportRow } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { badRequest, notFound } from "../http/errors.js";
import { keepBankBalance, requireAccount } from "./accounts.js";
import { createCategory } from "./categories.js";
import { formatCandidates } from "./importFormats.js";
import { activeRules, ruleBookings, writeRuleCategories, writeRuleTexts, type StoredResult } from "./rules.js";
import { inheritReturnCategories, linkReturns } from "./returns.js";
import { markNew } from "./unread.js";

interface Planned extends ImportRow {
    state: "new" | "duplicate" | "invalid";
    categoryId: number | null;
    categorySource: "rule" | "auto" | null;
    ruleId: number | null;
    /** New row: what the rules make of it; written after the returns are linked. */
    ruleResult: StoredResult | null;
    missing: MissingCategory | null;
    /** Duplicate: the booking already stored, its category and how the file's category compares. */
    storedId: number | null;
    storedCategoryId: number | null;
    categoryState: "same" | "differs" | "empty" | "split" | null;
    /** Duplicate without a kind of booking that takes the one of the file. */
    fillsBookingText: boolean;
    /** Duplicate with an empty detail (reference, mandate, creditor id, BIC, account number, bank code) the file has. */
    fillsDetails: boolean;
    /** Duplicate: the fields that are empty in the stored booking and that the file has. */
    fills: readonly ImportFillField[];
}

/** How to read a file: a format, a plain column assignment, or neither (chosen by the header). */
export interface ImportSelection {
    columns?: ColumnMap | undefined;
    format?: ImportFormatDefinition | undefined;
}

const NO_CATEGORY = { categoryId: null, categorySource: null, ruleId: null, ruleResult: null, missing: null, storedId: null, storedCategoryId: null, categoryState: null, fillsBookingText: false, fillsDetails: false, fills: [] } as const;

/** A category the file names that does not exist yet, with the path leading to it. */
interface MissingCategory {
    key: string;
    label: string;
    path: string[];
}

/** Details a file can add to a booking already stored, besides its references and its account. */
const DETAILS = ["mandateId", "creditorId", "counterpartyBic"] as const;
const FILLABLE = ["bookingText", ...DETAILS] as const;

/**
 * The account number and bank code of a row that fill empty ones of a booking already stored. As
 * from the bank, they stand only for a booking without an IBAN, and a bank code only along with
 * the account number it belongs to.
 */
function accountFills(r: ImportRow, stored: StoredBooking): ImportFillField[] {
    if (stored.iban || !r.counterpartyAccount) return [];
    const fills: ImportFillField[] = [];
    if (!stored.counterpartyAccount) fills.push("counterpartyAccount");
    const sameAccount = !stored.counterpartyAccount || stored.counterpartyAccount === r.counterpartyAccount;
    if (r.counterpartyBankCode && !stored.counterpartyBankCode && sameAccount) fills.push("counterpartyBankCode");
    return fills;
}

/**
 * The references of a row that fill an empty one of a booking already stored: not those the
 * kinds of reference searched for them hold already.
 */
function referenceFills(r: ImportRow, stored: StoredBooking, format: ImportFormatDefinition): ImportFillField[] {
    return REFERENCE_KINDS.filter((kind) => !!r[kind] && !stored[kind] && !referenceMatch(format, kind).some((k) => sameReference(stored[k], r[kind])));
}

interface StoredBooking {
    id: number;
    iban: string | null;
    counterpartyAccount: string;
    counterpartyBankCode: string;
    name: string;
    purpose: string;
    bookingText: string;
    reference: string;
    customerReference: string;
    bankReference: string;
    mandateId: string;
    creditorId: string;
    counterpartyBic: string;
}

type CategoryRef = { id: number; parentId: number | null; name: string };

const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

// A hyphen only separates with spaces around it, so "Kfz-Versicherung" stays one name
const PATH_SEPARATOR = /\s*(?:\\|\/|›|>|:|\|)\s*|\s+[-–]\s+/;

/**
 * Splits a category path from a file ("Wohnen\Miete", "Lebensmittel › Bäckerei",
 * "Alle - Wohnen - Miete"). The root "Alle" of MoneyMoney exports is dropped.
 */
export function splitCategoryPath(text: string, separator = "auto"): string[] {
    const parts = text.split(separator === "auto" ? PATH_SEPARATOR : separator).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && fold(parts[0]!) === "alle") parts.shift();
    return parts;
}

/**
 * Finds a category by the text of a file's category column. The whole text as a name wins,
 * then the last part of the path; among equal names the one whose ancestors match more of
 * the path wins.
 */
export function categoryByName(categories: CategoryRef[], text: string, separator = "auto"): number | null {
    const whole = fold(text);
    const exact = categories.find((c) => fold(c.name) === whole);
    if (exact) return exact.id;
    const parts = splitCategoryPath(text, separator).map(fold);
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
function missingCategory(text: string, separator = "auto"): MissingCategory | null {
    const path = splitCategoryPath(text, separator);
    if (!path.length) return null;
    return { key: path.map(fold).join("|"), label: path.join(" › "), path };
}

/** The format to read a file with: the one given, the column assignment, or the best match. */
function chooseFormat(db: Db, content: string, selection: ImportSelection): { format: ImportFormatDefinition; formatKey: string | null } {
    if (selection.format) return { format: selection.format, formatKey: null };
    const header = readCsv(content).header;
    if (!header.length) throw badRequest("In der Datei steht keine Tabelle.", "empty_file");
    if (selection.columns) {
        for (const f of IMPORT_FIELDS) {
            const at = selection.columns[f];
            if (at !== null && at >= header.length) throw badRequest("Die Spaltenzuordnung passt nicht zur Datei.");
        }
        return { format: formatFromColumns(selection.columns, header), formatKey: null };
    }
    const match = matchFormat(content, formatCandidates(db));
    if (match) return { format: match.definition, formatKey: match.key };
    return { format: formatFromColumns(guessColumns(header), header), formatKey: null };
}

/** The format for a file by its header, before an account is chosen. */
export const detectImportFormat = (db: Db, content: string): { format: ImportFormatDefinition; formatKey: string | null } => chooseFormat(db, content, {});

function plan(db: Db, accountId: number, content: string, selection: ImportSelection): { header: string[]; columns: ColumnMap; format: ImportFormatDefinition; formatKey: string | null; rows: Planned[] } {
    const isBankAccount = requireAccount(db, accountId).connection_id !== null;
    const { format, formatKey } = chooseFormat(db, content, selection);
    const table = readWithFormat(content, format);
    if (!table.header.length) throw badRequest("In der Datei steht keine Tabelle.", "empty_file");
    const absent = missingColumns(format, table.header);
    if (absent.length) throw badRequest(`Das Format passt nicht zur Datei. Es fehlt: ${absent.join(", ")}.`, "format_mismatch");
    const separator = format.values.categorySeparator;
    const parsed = mapFormatRows(table, format);
    const dates = parsed.map((r) => r.date).filter((d): d is string => !!d).sort();
    // Stored bookings by day and amount, with their counterparty. Day and amount as the bank or the
    // file gave them, whatever the user changed; deleted ones too, so that they do not come back.
    const existing = new Map<string, StoredBooking[]>();
    if (dates.length) {
        const rows = db
            .prepare(
                `SELECT id, COALESCE(original_booking_date, booking_date) AS booking_date, COALESCE(original_amount, amount) AS amount, counterparty_name, counterparty_iban, counterparty_account, counterparty_bank_code, remittance, booking_text, reference, customer_reference, bank_reference, mandate_id, creditor_id, counterparty_bic
                 FROM transactions WHERE account_id = ? AND COALESCE(original_booking_date, booking_date) BETWEEN ? AND ?`,
            )
            .all(accountId, dates[0], dates[dates.length - 1]) as {
            id: number;
            booking_date: string;
            amount: number;
            counterparty_name: string;
            counterparty_iban: string | null;
            counterparty_account: string;
            counterparty_bank_code: string;
            remittance: string;
            booking_text: string;
            reference: string;
            customer_reference: string;
            bank_reference: string;
            mandate_id: string;
            creditor_id: string;
            counterparty_bic: string;
        }[];
        for (const r of rows) {
            const key = duplicateKey(r.booking_date, r.amount);
            const list = existing.get(key) ?? [];
            list.push({ id: r.id, iban: r.counterparty_iban, counterpartyAccount: r.counterparty_account, counterpartyBankCode: r.counterparty_bank_code, name: r.counterparty_name, purpose: r.remittance, bookingText: r.booking_text, reference: r.reference, customerReference: r.customer_reference, bankReference: r.bank_reference, mandateId: r.mandate_id, creditorId: r.creditor_id, counterpartyBic: r.counterparty_bic });
            existing.set(key, list);
        }
    }
    const categories = db.prepare("SELECT id, parent_id AS parentId, name FROM categories").all() as CategoryRef[];
    const rules = activeRules(db);
    const book = ruleBookings(db);
    const storedCategories = db.prepare("SELECT category_id FROM transaction_categories WHERE transaction_id = ?").pluck();
    const rows = parsed.map((r): Planned => {
        if (r.error || !r.date || r.amount === null) return { ...r, state: "invalid", ...NO_CATEGORY };
        // Each booking already stored covers one equal row of the file, no more
        const stored = existing.get(duplicateKey(r.date, r.amount)) ?? [];
        const at = stored.findIndex((c) => sameCounterparty(c, r));
        if (at >= 0) {
            const [match] = stored.splice(at, 1);
            const planned = duplicate(r, match!.id, storedCategories.all(match!.id) as number[], categories, separator);
            const fills = [...FILLABLE.filter((f) => !!r[f] && !match![f]), ...accountFills(r, match!), ...referenceFills(r, match!, format)];
            return { ...planned, fills, fillsBookingText: fills.includes("bookingText"), fillsDetails: fills.some((f) => f !== "bookingText") };
        }
        // The bank delivers pending bookings itself and replaces them; one from a file would stay
        if (r.pending && isBankAccount) return { ...r, state: "invalid", ...NO_CATEGORY, error: "Vorgemerkte Umsätze kommen bei Bankkonten vom Abruf." };
        // The rules also run on a row with a category of its own, for its texts
        const ruleResult = evaluateRules(
            rules,
            book({
                account_id: accountId,
                booking_date: r.date,
                amount: r.amount,
                counterparty_name: r.name,
                ultimate_party: "",
                counterparty_iban: r.iban,
                remittance: r.purpose,
                booking_text: r.bookingText,
                reference: r.reference,
                mandate_id: r.mandateId,
                creditor_id: r.creditorId,
                category_id: null,
            }),
        );
        const fromFile = r.category ? categoryByName(categories, r.category, separator) : null;
        if (fromFile) return { ...r, state: "new", ...NO_CATEGORY, categoryId: fromFile, categorySource: "auto", ruleResult };
        // Unless missing categories get created, the rules decide
        const missing = r.category ? missingCategory(r.category, separator) : null;
        const ruleCategory = ruleResult?.categoryId ?? null;
        return { ...r, state: "new", ...NO_CATEGORY, categoryId: ruleCategory, categorySource: ruleCategory !== null ? "rule" : null, ruleId: ruleCategory !== null ? ruleResult!.rule.id : null, ruleResult, missing };
    });
    return { header: table.header, columns: columnsFromFormat(format, table.header), format, formatKey, rows };
}

/**
 * A row of the file that is stored already, compared by the category the file names. Only the
 * file counts here, no rules. A split booking is never overwritten, so its missing category is
 * not offered for creation either.
 */
function duplicate(r: ImportRow, storedId: number, stored: number[], categories: CategoryRef[], separator: string): Planned {
    const base: Planned = { ...r, state: "duplicate", ...NO_CATEGORY, storedId, storedCategoryId: stored.length === 1 ? stored[0]! : null };
    if (!r.category) return base;
    const fromFile = categoryByName(categories, r.category, separator);
    const missing = fromFile ? null : missingCategory(r.category, separator);
    if (!fromFile && !missing) return base;
    if (stored.length > 1) return { ...base, categoryId: fromFile, categoryState: "split" };
    if (!stored.length) return { ...base, categoryId: fromFile, categorySource: "auto", missing, categoryState: "empty" };
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

export function previewImport(db: Db, accountId: number, content: string, selection: ImportSelection = {}): ImportPreview {
    const p = plan(db, accountId, content, selection);
    const counts = { new: 0, duplicate: 0, invalid: 0, differs: 0, filled: 0 };
    for (const r of p.rows) {
        counts[r.state]++;
        if (r.categoryState === "differs") counts.differs++;
        if (r.fillsBookingText || r.fillsDetails || r.categoryState === "empty") counts.filled++;
    }
    return {
        header: p.header,
        columns: p.columns,
        format: p.format,
        formatKey: p.formatKey,
        counts,
        newCategories: [...uniqueMissing(p.rows).values()].map((m) => m.label),
        rows: p.rows.map((r) => ({
            line: r.line,
            date: r.date,
            amount: r.amount,
            name: r.name,
            iban: r.iban,
            counterpartyAccount: r.counterpartyAccount,
            counterpartyBankCode: r.counterpartyBankCode,
            purpose: r.purpose,
            shownName: r.ruleResult?.counterparty ?? null,
            shownPurpose: r.ruleResult?.remittance ?? null,
            bookingText: r.bookingText,
            fillsBookingText: r.fillsBookingText,
            reference: r.reference,
            customerReference: r.customerReference,
            bankReference: r.bankReference,
            mandateId: r.mandateId,
            creditorId: r.creditorId,
            counterpartyBic: r.counterpartyBic,
            fillsDetails: r.fillsDetails,
            fills: [...r.fills],
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
    selection: ImportSelection,
    userId: number | null,
    createCategories = false,
    replaceCategoryLines: readonly number[] = [],
    excludeLines: readonly number[] = [],
): { importId: number; imported: number; skipped: number; invalid: number; createdCategories: number; recategorized: number; categoriesFilled: number; bookingTextsFilled: number; detailsFilled: number; filled: number; excluded: number } {
    // Left out only after the plan: each stored booking still covers its one equal row of the file
    const p = plan(db, accountId, content, selection);
    const left = new Set(excludeLines);
    const replace = new Set(replaceCategoryLines);
    const kept = p.rows.filter((r) => !left.has(r.line));
    const fillsCategory = (r: Planned): boolean => r.categoryState === "empty" && (r.categoryId !== null || (createCategories && !!r.missing));
    const excluded = p.rows.filter((r) => left.has(r.line) && (r.state === "new" || r.fillsBookingText || r.fillsDetails || fillsCategory(r))).length;
    const fresh = kept.filter((r) => r.state === "new");
    const empty = kept.filter((r) => r.categoryState === "empty");
    // Replacing a category is its own choice, so it does not depend on the row being left out
    const differing = p.rows.filter((r) => r.categoryState === "differs" && replace.has(r.line));
    let createdCategories = 0;
    if (createCategories) {
        // The file decides over the rules for the categories it names
        const { ids, created } = createMissing(db, uniqueMissing([...fresh, ...empty, ...differing]));
        createdCategories = created;
        for (const r of [...fresh, ...empty, ...differing]) {
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
            JSON.stringify(p.format),
        ).lastInsertRowid,
    );
    const insertTx = db.prepare(
        `INSERT INTO transactions (account_id, booking_date, value_date, amount, counterparty_name, counterparty_iban, counterparty_account, counterparty_bank_code, remittance, booking_text, reference, customer_reference, bank_reference, mandate_id, creditor_id, counterparty_bic, is_return, status, first_seen_at, source, import_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`,
    );
    const insertCat = db.prepare("INSERT INTO transaction_categories (transaction_id, category_id, amount, source, rule_id) VALUES (?, ?, ?, ?, ?)");
    const ids: number[] = [];
    const ruleResults = new Map<number, StoredResult>();
    for (const r of fresh) {
        const id = Number(insertTx.run(accountId, r.date, r.valueDate ?? r.date, r.amount, r.name, r.iban, r.counterpartyAccount, r.counterpartyBankCode, r.purpose, r.bookingText, r.reference, r.customerReference, r.bankReference, r.mandateId, r.creditorId, r.counterpartyBic, isReturnText(r.bookingText) ? 1 : 0, r.pending ? "pending" : "booked", now, importId, userId).lastInsertRowid);
        // The category of a rule follows once the returns are linked; the one of the file stays
        if (r.categoryId && r.categorySource !== "rule") insertCat.run(id, r.categoryId, r.amount, r.categorySource ?? "auto", r.ruleId);
        if (r.ruleResult) ruleResults.set(id, r.ruleResult);
        ids.push(id);
    }
    // New for the others; the importing user saw them in the preview
    markNew(db, ids, userId);
    // A replaced category counts as assigned by hand
    const clear = db.prepare("DELETE FROM transaction_categories WHERE transaction_id = ?");
    let recategorized = 0;
    for (const r of differing) {
        if (r.categoryId === null || r.storedId === null) continue;
        clear.run(r.storedId);
        insertCat.run(r.storedId, r.categoryId, r.amount, "manual", null);
        recategorized++;
    }
    // A booking without a category takes the file's like a new one
    let categoriesFilled = 0;
    for (const r of empty) {
        if (r.categoryId === null || r.storedId === null) continue;
        insertCat.run(r.storedId, r.categoryId, r.amount, "auto", null);
        categoriesFilled++;
    }
    // Only an empty kind of booking is filled in, one already stored stays
    const fillBookingText = db.prepare("UPDATE transactions SET booking_text = ? WHERE id = ? AND booking_text = ''");
    const markReturn = db.prepare("UPDATE transactions SET is_return = 1 WHERE id = ?");
    let bookingTextsFilled = 0;
    for (const r of kept) {
        if (!r.fillsBookingText || r.storedId === null) continue;
        const { changes } = fillBookingText.run(r.bookingText, r.storedId);
        bookingTextsFilled += changes;
        if (changes && isReturnText(r.bookingText)) markReturn.run(r.storedId);
    }
    // The same for the details; a value from a file never becomes the end-to-end ID of a transfer.
    // A reference, account number or bank code the plan does not fill in goes as "", so it stays as it is.
    const fillDetails = db.prepare(
        `UPDATE transactions SET
            reference = CASE WHEN reference = '' THEN ? ELSE reference END,
            customer_reference = CASE WHEN customer_reference = '' THEN ? ELSE customer_reference END,
            bank_reference = CASE WHEN bank_reference = '' THEN ? ELSE bank_reference END,
            mandate_id = CASE WHEN mandate_id = '' THEN ? ELSE mandate_id END,
            creditor_id = CASE WHEN creditor_id = '' THEN ? ELSE creditor_id END,
            counterparty_bic = CASE WHEN counterparty_bic = '' THEN ? ELSE counterparty_bic END,
            counterparty_account = CASE WHEN counterparty_account = '' THEN ? ELSE counterparty_account END,
            counterparty_bank_code = CASE WHEN counterparty_bank_code = '' THEN ? ELSE counterparty_bank_code END
         WHERE id = ?`,
    );
    let detailsFilled = 0;
    for (const r of kept) {
        if (!r.fillsDetails || r.storedId === null) continue;
        const [reference, customerReference, bankReference] = REFERENCE_KINDS.map((k) => (r.fills.includes(k) ? r[k] : ""));
        const fill = (f: "counterpartyAccount" | "counterpartyBankCode"): string => (r.fills.includes(f) ? r[f] : "");
        detailsFilled += fillDetails.run(reference, customerReference, bankReference, r.mandateId, r.creditorId, r.counterpartyBic, fill("counterpartyAccount"), fill("counterpartyBankCode"), r.storedId).changes;
    }
    const filled = kept.filter((r) => r.storedId !== null && (r.fillsBookingText || r.fillsDetails || (r.categoryState === "empty" && r.categoryId !== null))).length;
    keepBankBalance(db, accountId, fresh.reduce((sum, r) => sum + (r.amount ?? 0), 0));
    const linkedReturns = linkReturns(db, accountId);
    writeRuleCategories(db, ruleResults, new Set(linkedReturns));
    inheritReturnCategories(db, linkedReturns);
    writeRuleTexts(db, ruleResults);
    return { importId, imported: fresh.length, skipped, invalid, createdCategories, recategorized, categoriesFilled, bookingTextsFilled, detailsFilled, filled, excluded };
}

export function listImports(db: Db): ImportRecord[] {
    return db
        .prepare(
            `SELECT i.id, i.account_id AS accountId, i.file_name AS fileName, i.imported_at AS importedAt, u.name AS userName,
                    i.rows, i.imported, i.skipped,
                    (SELECT count(*) FROM transactions t WHERE t.import_id = i.id AND t.deleted_at IS NULL) AS remaining,
                    (SELECT count(*) FROM transactions t WHERE t.import_id = i.id AND t.deleted_at IS NOT NULL) AS deleted
             FROM imports i LEFT JOIN users u ON u.id = i.user_id ORDER BY i.id DESC`,
        )
        .all() as ImportRecord[];
}

/** Deletes an import: the bookings it brought in that still exist, then its record. */
export function undoImport(db: Db, id: number): { accountId: number; fileName: string; removed: number } {
    const row = db.prepare("SELECT account_id, file_name FROM imports WHERE id = ?").get(id) as { account_id: number; file_name: string } | undefined;
    if (!row) throw notFound("Import");
    // Deleted bookings no longer count in the balance
    const { sum } = db.prepare("SELECT COALESCE(SUM(amount), 0) AS sum FROM transactions WHERE import_id = ? AND deleted_at IS NULL").get(id) as { sum: number };
    // Counter bookings made from imported bookings go too
    db.prepare("DELETE FROM transactions WHERE source = 'manual' AND counter_transaction_id IN (SELECT id FROM transactions WHERE import_id = ?)").run(id);
    const removed = db.prepare("DELETE FROM transactions WHERE import_id = ?").run(id).changes;
    db.prepare("DELETE FROM imports WHERE id = ?").run(id);
    keepBankBalance(db, row.account_id, -sum);
    return { accountId: row.account_id, fileName: row.file_name, removed };
}
