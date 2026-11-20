import Database from "better-sqlite3-multiple-ciphers";
import { Umzug, type UmzugStorage } from "umzug";
import { applyMigration, migrations } from "./migrations/index.js";

export type Db = Database.Database;

/**
 * Opens (or creates) the database, encrypted as a whole with the data key: SQLCipher-compatible
 * AES-256 with HMAC, WAL and journal included. A wrong key fails on the first read.
 */
export function openDatabase(file: string, dataKey: Buffer): Db {
    const db = new Database(file);
    try {
        db.pragma("cipher = 'sqlcipher'");
        db.pragma("legacy = 4");
        db.pragma(`key = "x'${dataKey.toString("hex")}'"`);
        db.prepare("SELECT count(*) FROM sqlite_master").get();
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        db.pragma("busy_timeout = 5000");
        db.pragma("secure_delete = ON");
        return db;
    } catch (err) {
        db.close();
        throw err;
    }
}

function storage(db: Db): UmzugStorage<Db> {
    db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    return {
        async executed() {
            return (db.prepare("SELECT name FROM migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
        },
        async logMigration({ name }) {
            db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
        },
        async unlogMigration({ name }) {
            db.prepare("DELETE FROM migrations WHERE name = ?").run(name);
        },
    };
}

export async function migrate(db: Db): Promise<void> {
    const umzug = new Umzug<Db>({
        migrations: migrations.map((m) => ({
            name: m.name,
            up: async ({ context }) => {
                applyMigration(context, m);
            },
        })),
        context: db,
        storage: storage(db),
        logger: undefined,
    });
    await umzug.up();
}

export const nowIso = (): string => new Date().toISOString();
