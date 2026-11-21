import { BUILTIN_IMPORT_FORMATS, ImportFormatDefinition, type ImportFormat } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { conflict, notFound } from "../http/errors.js";

interface FormatRow {
    id: number;
    name: string;
    definition: string;
}

const builtins = (): ImportFormat[] => BUILTIN_IMPORT_FORMATS.map((f) => ({ key: f.key, id: null, name: f.name, builtin: true, definition: f.definition }));

/** A stored format that no longer parses is left out instead of breaking every import. */
function toFormat(r: FormatRow): ImportFormat | null {
    try {
        const parsed = ImportFormatDefinition.safeParse(JSON.parse(r.definition));
        return parsed.success ? { key: `custom:${r.id}`, id: r.id, name: r.name, builtin: false, definition: parsed.data } : null;
    } catch {
        return null;
    }
}

const ownFormats = (db: Db): ImportFormat[] =>
    (db.prepare("SELECT id, name, definition FROM import_formats ORDER BY name COLLATE NOCASE, id").all() as FormatRow[]).flatMap((r) => toFormat(r) ?? []);

/** The formats of the app first, then the own ones by name. */
export const listImportFormats = (db: Db): ImportFormat[] => [...builtins(), ...ownFormats(db)];

/** Candidates for a file: own formats win over those of the app. */
export const formatCandidates = (db: Db): ImportFormat[] => [...ownFormats(db), ...builtins()];

function getImportFormat(db: Db, id: number): ImportFormat {
    const row = db.prepare("SELECT id, name, definition FROM import_formats WHERE id = ?").get(id) as FormatRow | undefined;
    const format = row && toFormat(row);
    if (!format) throw notFound("Importformat");
    return format;
}

function assertNameFree(db: Db, name: string, ownId: number | null): void {
    const taken = BUILTIN_IMPORT_FORMATS.some((f) => f.name.toLowerCase() === name.toLowerCase()) || !!db.prepare("SELECT 1 FROM import_formats WHERE name = ? AND id IS NOT ?").get(name, ownId);
    if (taken) throw conflict(`Ein Format „${name}“ gibt es schon.`, "format_name_taken");
}

export function createImportFormat(db: Db, input: { name: string; definition: ImportFormatDefinition }): ImportFormat {
    assertNameFree(db, input.name, null);
    const now = nowIso();
    const id = Number(db.prepare("INSERT INTO import_formats (name, definition, created_at, updated_at) VALUES (?, ?, ?, ?)").run(input.name, JSON.stringify(input.definition), now, now).lastInsertRowid);
    return getImportFormat(db, id);
}

export function updateImportFormat(db: Db, id: number, input: { name?: string | undefined; definition?: ImportFormatDefinition | undefined }): ImportFormat {
    const current = getImportFormat(db, id);
    const name = input.name ?? current.name;
    assertNameFree(db, name, id);
    db.prepare("UPDATE import_formats SET name = ?, definition = ?, updated_at = ? WHERE id = ?").run(name, JSON.stringify(input.definition ?? current.definition), nowIso(), id);
    return getImportFormat(db, id);
}

export function deleteImportFormat(db: Db, id: number): void {
    if (!db.prepare("DELETE FROM import_formats WHERE id = ?").run(id).changes) throw notFound("Importformat");
}
