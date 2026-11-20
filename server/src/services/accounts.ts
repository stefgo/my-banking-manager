import type { Account, AccountGroup, AccountScope, Info } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { nowIso } from "../db/database.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { infoValues, readInfo, type InfoColumns } from "./info.js";

// ---------- Groups ----------

interface GroupRow extends InfoColumns {
    id: number;
    parent_id: number | null;
    name: string;
    icon: string;
    color: string;
    position: number;
}

const toGroup = (r: GroupRow): AccountGroup => ({
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    icon: r.icon,
    color: r.color,
    position: r.position,
    info: readInfo(r),
});

export const listGroups = (db: Db): AccountGroup[] => (db.prepare("SELECT * FROM account_groups ORDER BY position, id").all() as GroupRow[]).map(toGroup);

export function requireGroup(db: Db, id: number): GroupRow {
    const row = db.prepare("SELECT * FROM account_groups WHERE id = ?").get(id) as GroupRow | undefined;
    if (!row) throw notFound("Kontogruppe");
    return row;
}

/** Groups and accounts directly below `parentId`, in their shared order. */
function siblings(db: Db, parentId: number | null): { kind: "group" | "account"; id: number }[] {
    const groups = db.prepare("SELECT id, position FROM account_groups WHERE parent_id IS ?").all(parentId) as { id: number; position: number }[];
    const accounts = db.prepare("SELECT id, position FROM accounts WHERE group_id IS ?").all(parentId) as { id: number; position: number }[];
    return [
        ...groups.map((g) => ({ kind: "group" as const, id: g.id, position: g.position })),
        ...accounts.map((a) => ({ kind: "account" as const, id: a.id, position: a.position })),
    ]
        .sort((a, b) => a.position - b.position || (a.kind === b.kind ? a.id - b.id : a.kind === "group" ? -1 : 1))
        .map(({ kind, id }) => ({ kind, id }));
}

function renumber(db: Db, parentId: number | null, order: { kind: "group" | "account"; id: number }[]): void {
    const g = db.prepare("UPDATE account_groups SET parent_id = ?, position = ? WHERE id = ?");
    const a = db.prepare("UPDATE accounts SET group_id = ?, position = ? WHERE id = ?");
    order.forEach((n, i) => (n.kind === "group" ? g : a).run(parentId, i, n.id));
}

export const nextPosition = (db: Db, parentId: number | null): number => siblings(db, parentId).length;

function groupDepth(db: Db, id: number | null): number {
    let depth = 0;
    let cur = id;
    while (cur !== null) {
        depth++;
        cur = (db.prepare("SELECT parent_id FROM account_groups WHERE id = ?").get(cur) as { parent_id: number | null } | undefined)?.parent_id ?? null;
    }
    return depth;
}

/** Ids of a group and every group below it. */
export function groupSubtree(db: Db, id: number): number[] {
    const all = db.prepare("SELECT id, parent_id FROM account_groups").all() as { id: number; parent_id: number | null }[];
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const g of all) if (g.parent_id === out[i]) out.push(g.id);
    return out;
}

const MAX_GROUP_DEPTH = 4;

export function createGroup(db: Db, input: { parentId: number | null; name: string; icon: string; color: string }): AccountGroup {
    if (input.parentId !== null) requireGroup(db, input.parentId);
    if (groupDepth(db, input.parentId) >= MAX_GROUP_DEPTH) throw badRequest(`Gruppen lassen sich höchstens ${MAX_GROUP_DEPTH} Ebenen tief schachteln.`);
    const id = Number(
        db.prepare("INSERT INTO account_groups (parent_id, name, icon, color, position) VALUES (?, ?, ?, ?, ?)").run(
            input.parentId,
            input.name,
            input.icon,
            input.color,
            nextPosition(db, input.parentId),
        ).lastInsertRowid,
    );
    return toGroup(requireGroup(db, id));
}

export function updateGroup(db: Db, id: number, input: { name?: string; icon?: string; color?: string; info?: Info }): AccountGroup {
    const row = requireGroup(db, id);
    db.prepare("UPDATE account_groups SET name = ?, icon = ?, color = ?, info_attributes = ?, info_notes = ? WHERE id = ?").run(
        input.name ?? row.name,
        input.icon ?? row.icon,
        input.color ?? row.color,
        ...infoValues(row, input.info),
        id,
    );
    return toGroup(requireGroup(db, id));
}

/** Dissolves a group: what it holds takes its place in the parent. */
export function deleteGroup(db: Db, id: number): void {
    const row = requireGroup(db, id);
    const parentOrder = siblings(db, row.parent_id);
    const at = parentOrder.findIndex((n) => n.kind === "group" && n.id === id);
    const content = siblings(db, id);
    parentOrder.splice(at, 1, ...content);
    renumber(db, row.parent_id, parentOrder);
    db.prepare("DELETE FROM account_groups WHERE id = ?").run(id);
}

export function moveTreeNode(db: Db, input: { kind: "group" | "account"; id: number; parentId: number | null; index: number }): void {
    if (input.kind === "group") requireGroup(db, input.id);
    else requireAccount(db, input.id);
    if (input.parentId !== null) {
        requireGroup(db, input.parentId);
        if (input.kind === "group" && groupSubtree(db, input.id).includes(input.parentId)) throw badRequest("Eine Gruppe kann nicht in sich selbst liegen.");
    }
    if (input.kind === "group") {
        const height = subtreeHeight(db, input.id);
        if (groupDepth(db, input.parentId) + height > MAX_GROUP_DEPTH) throw badRequest(`Gruppen lassen sich höchstens ${MAX_GROUP_DEPTH} Ebenen tief schachteln.`);
    }
    const current = input.kind === "group"
        ? (db.prepare("SELECT parent_id AS p FROM account_groups WHERE id = ?").get(input.id) as { p: number | null }).p
        : (db.prepare("SELECT group_id AS p FROM accounts WHERE id = ?").get(input.id) as { p: number | null }).p;
    const node = { kind: input.kind, id: input.id };
    const same = (n: { kind: string; id: number }) => n.kind === node.kind && n.id === node.id;
    if (current !== input.parentId) renumber(db, current, siblings(db, current).filter((n) => !same(n)));
    const order = siblings(db, input.parentId).filter((n) => !same(n));
    order.splice(Math.min(input.index, order.length), 0, node);
    renumber(db, input.parentId, order);
}

function subtreeHeight(db: Db, id: number): number {
    const kids = db.prepare("SELECT id FROM account_groups WHERE parent_id = ?").all(id) as { id: number }[];
    return 1 + Math.max(0, ...kids.map((k) => subtreeHeight(db, k.id)));
}

// ---------- Accounts ----------

interface AccountRow extends InfoColumns {
    id: number;
    kind: Account["kind"];
    connection_id: number | null;
    external_id: string | null;
    name: string;
    icon: string;
    color: string;
    group_id: number | null;
    position: number;
    hidden: number;
    iban: string | null;
    card_number: string | null;
    opening_balance: number | null;
    created_at: string;
}

export function requireAccount(db: Db, id: number): AccountRow {
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    if (!row) throw notFound("Konto");
    return row;
}

export function requireOffline(db: Db, id: number): AccountRow {
    const row = requireAccount(db, id);
    if (row.kind !== "offline") throw badRequest("Das geht nur bei Offline-Konten.", "not_offline");
    return row;
}

const ACCOUNT_SELECT = `
    SELECT a.*,
        COALESCE(a.opening_balance, 0) + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id), 0) AS balance,
        COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id AND t.status = 'pending'), 0) AS pending_sum,
        (SELECT count(*) FROM transactions t WHERE t.account_id = a.id AND t.status = 'pending') AS pending_count,
        (SELECT count(*) FROM transactions t WHERE t.account_id = a.id) AS tx_count
    FROM accounts a`;

const toAccount = (r: AccountRow & { balance: number; pending_sum: number; pending_count: number; tx_count: number }): Account => ({
    id: r.id,
    kind: r.kind,
    connectionId: r.connection_id,
    name: r.name,
    icon: r.icon,
    color: r.color,
    groupId: r.group_id,
    position: r.position,
    hidden: r.hidden === 1,
    iban: r.iban,
    cardNumber: r.card_number,
    currency: "EUR",
    openingBalance: r.opening_balance,
    balance: r.balance,
    pendingSum: r.pending_sum,
    pendingCount: r.pending_count,
    transactionCount: r.tx_count,
    createdAt: r.created_at,
    info: readInfo(r),
});

export const listAccounts = (db: Db): Account[] => (db.prepare(`${ACCOUNT_SELECT} ORDER BY a.position, a.id`).all() as Parameters<typeof toAccount>[0][]).map(toAccount);

export function getAccount(db: Db, id: number): Account {
    const row = db.prepare(`${ACCOUNT_SELECT} WHERE a.id = ?`).get(id) as Parameters<typeof toAccount>[0] | undefined;
    if (!row) throw notFound("Konto");
    return toAccount(row);
}

export function createOfflineAccount(
    db: Db,
    input: { name: string; icon: string; color: string; groupId: number | null; openingBalance: number },
): Account {
    if (input.groupId !== null) requireGroup(db, input.groupId);
    const id = Number(
        db.prepare(
            `INSERT INTO accounts (kind, name, currency, icon, color, group_id, position, opening_balance, created_at)
             VALUES ('offline', ?, 'EUR', ?, ?, ?, ?, ?, ?)`,
        ).run(input.name, input.icon, input.color, input.groupId, nextPosition(db, input.groupId), input.openingBalance, nowIso()).lastInsertRowid,
    );
    return getAccount(db, id);
}

export function updateAccount(
    db: Db,
    id: number,
    input: { name?: string; icon?: string; color?: string; hidden?: boolean; openingBalance?: number; info?: Info },
): Account {
    const row = requireAccount(db, id);
    if (input.openingBalance !== undefined && row.kind !== "offline") {
        throw badRequest("Den Anfangssaldo gibt es nur bei Offline-Konten.");
    }
    db.prepare("UPDATE accounts SET name = ?, icon = ?, color = ?, hidden = ?, opening_balance = ?, info_attributes = ?, info_notes = ? WHERE id = ?").run(
        input.name ?? row.name,
        input.icon ?? row.icon,
        input.color ?? row.color,
        input.hidden === undefined ? row.hidden : input.hidden ? 1 : 0,
        input.openingBalance ?? row.opening_balance,
        ...infoValues(row, input.info),
        id,
    );
    return getAccount(db, id);
}

export function deleteAccount(db: Db, id: number): AccountRow {
    const row = requireAccount(db, id);
    if (row.kind !== "offline") throw conflict("Bankkonten verschwinden mit ihrem Bankzugang.", "not_offline");
    // Counter bookings in other accounts lose their partner; their category stays as it is
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    const rest = siblings(db, row.group_id);
    renumber(db, row.group_id, rest);
    return row;
}

/** Account ids a scope ("all", "group:<id>", "account:<id>") stands for. */
export function accountsInScope(db: Db, scope: AccountScope): number[] {
    if (scope === "all") return (db.prepare("SELECT id FROM accounts").all() as { id: number }[]).map((r) => r.id);
    const [kind, raw] = scope.split(":") as ["group" | "account", string];
    const id = Number(raw);
    if (kind === "account") return db.prepare("SELECT id FROM accounts WHERE id = ?").get(id) ? [id] : [];
    const groups = groupSubtree(db, id);
    return (db.prepare(`SELECT id FROM accounts WHERE group_id IN (${groups.map(() => "?").join(",")})`).all(...groups) as { id: number }[]).map((r) => r.id);
}

/** Balance of an account at the end of `date`. */
export function balanceAt(db: Db, accountId: number, date: string): number {
    const after = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND booking_date > ?").get(accountId, date) as { s: number }).s;
    return getAccount(db, accountId).balance - after;
}
