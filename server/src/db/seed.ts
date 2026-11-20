import { DEFAULT_ACCOUNT_GROUPS, DEFAULT_CATEGORIES } from "@mbm/shared";
import type { Db } from "./database.js";

export interface SeedOptions {
    categories: boolean;
    accountGroups: boolean;
}

/** Fills a new database with the start trees the set-up asked for: categories, account groups. */
export function seedDefaults(db: Db, options: SeedOptions): void {
    const hasCategories = (db.prepare("SELECT count(*) AS n FROM categories").get() as { n: number }).n > 0;
    const hasGroups = (db.prepare("SELECT count(*) AS n FROM account_groups").get() as { n: number }).n > 0;
    db.transaction(() => {
        if (options.categories && !hasCategories) {
            const insert = db.prepare(
                "INSERT INTO categories (parent_id, name, icon, color, position, excluded_from_stats, counter_default) VALUES (?, ?, ?, ?, ?, ?, ?)",
            );
            DEFAULT_CATEGORIES.forEach((c, i) => {
                const id = Number(insert.run(null, c.name, c.icon, c.color ?? "neutral", i, c.excludedFromStats ? 1 : 0, c.counterDefault ? 1 : 0).lastInsertRowid);
                c.children?.forEach((child, j) => insert.run(id, child.name, child.icon, null, j, 0, 0));
            });
        }
        if (options.accountGroups && !hasGroups) {
            const insert = db.prepare("INSERT INTO account_groups (parent_id, name, icon, color, position) VALUES (?, ?, ?, ?, ?)");
            DEFAULT_ACCOUNT_GROUPS.forEach((g, i) => {
                const id = Number(insert.run(null, g.name, g.icon, g.color, i).lastInsertRowid);
                g.children?.forEach((child, j) => insert.run(id, child.name, child.icon, child.color, j));
            });
        }
    })();
}
