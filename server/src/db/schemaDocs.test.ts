// docs/datenbankmodell.md describes every table and column; this keeps it in step with the
// migrations. A new migration fails here until the page (and, for a new table, the overview
// diagram from scripts/diagrams) knows its tables and columns.

import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import { applyMigration, migrations } from "./migrations/index.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PAGE = path.join(ROOT, "docs/datenbankmodell.md");
const OVERVIEW = path.join(ROOT, "docs/assets/diagrams/datenbank-tabellen.svg");

/** The schema after all migrations: table → columns in their order. */
function schema(): Map<string, string[]> {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"); // as database.ts
    for (const m of migrations) applyMigration(db, m);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const result = new Map(tables.map((t) => [t, (db.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name)]));
    db.close();
    return result;
}

/** The page: each "#### `table`" heading with the first cells of the column table below it. */
function documented(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    let current: string[] | null = null;
    for (const line of readFileSync(PAGE, "utf8").split("\n")) {
        const heading = /^#### `([a-z_]+)`\s*$/.exec(line);
        if (heading) {
            current = [];
            result.set(heading[1]!, current);
            continue;
        }
        if (/^#{1,3} /.test(line)) {
            current = null;
            continue;
        }
        const row = /^\| `([a-z_]+)` \|/.exec(line);
        if (row && current) current.push(row[1]!);
    }
    return result;
}

describe("docs/datenbankmodell.md", () => {
    const db = schema();
    const docs = documented();

    it("describes every table and no other", () => {
        expect([...docs.keys()].sort()).toEqual([...db.keys()].sort());
    });

    it("lists the columns of each table in the order of the database", () => {
        for (const [table, columns] of db) expect({ table, columns: docs.get(table) }).toEqual({ table, columns });
    });

    it("has every table in the overview diagram", () => {
        const svg = readFileSync(OVERVIEW, "utf8");
        const missing = [...db.keys()].filter((t) => !svg.includes(`>${t}</text>`));
        expect(missing).toEqual([]);
    });
});
