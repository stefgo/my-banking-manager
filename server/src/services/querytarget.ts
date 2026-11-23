// Turns bookings into targets of the search syntax (`shared/src/txquery.ts`). Category and account
// paths are loaded once per operation, not once per booking.

import { toTxQueryTarget, type TxQueryTarget } from "@mbm/shared";
import type { Db } from "../db/database.js";
import { getSlot } from "./categories.js";

export interface QueryRow {
    account_id: number;
    booking_date: string;
    amount: number;
    counterparty_name: string;
    ultimate_party: string;
    counterparty_iban: string | null;
    remittance: string;
    category_id: number | null;
    /** Texts shown instead of the bank's; the search finds both. Rules never pass them. */
    edit_counterparty?: string | null;
    edit_remittance?: string | null;
    /** 1 when new for the user searching. */
    unread?: number;
}

interface Node {
    name: string;
    parent: number | null;
}

/** Names of a node and all its parents; guards against cycles. */
function pathOf(nodes: Map<number, Node>, id: number | null, cache: Map<number | null, string[]>): string[] {
    const known = cache.get(id);
    if (known) return known;
    const names: string[] = [];
    for (let n = id === null ? undefined : nodes.get(id); n && names.length < 100; n = n.parent === null ? undefined : nodes.get(n.parent)) names.push(n.name);
    cache.set(id, names);
    return names;
}

export function queryTargets(db: Db): (row: QueryRow) => TxQueryTarget {
    const cats = new Map(
        (db.prepare("SELECT id, name, parent_id FROM categories").all() as { id: number; name: string; parent_id: number | null }[]).map((c) => [c.id, { name: c.name, parent: c.parent_id }]),
    );
    const groups = new Map(
        (db.prepare("SELECT id, name, parent_id FROM account_groups").all() as { id: number; name: string; parent_id: number | null }[]).map((g) => [g.id, { name: g.name, parent: g.parent_id }]),
    );
    const accounts = new Map(
        (db.prepare("SELECT id, name, iban, group_id FROM accounts").all() as { id: number; name: string; iban: string | null; group_id: number | null }[]).map((a) => [a.id, a]),
    );
    const catPaths = new Map<number | null, string[]>();
    const groupPaths = new Map<number | null, string[]>();
    const accountPaths = new Map<number, string[]>();
    // "Ohne Kategorie" below a category belongs to it like a subcategory
    const slotParent = getSlot(db).parentId;
    const accountPath = (id: number): string[] => {
        let p = accountPaths.get(id);
        if (!p) {
            const a = accounts.get(id);
            p = a ? [a.name, ...pathOf(groups, a.group_id, groupPaths)] : [];
            accountPaths.set(id, p);
        }
        return p;
    };
    return (r) =>
        toTxQueryTarget({
            counterparty: r.counterparty_name,
            ultimateParty: r.ultimate_party,
            counterpartyEdited: r.edit_counterparty ?? null,
            remittance: r.remittance,
            remittanceEdited: r.edit_remittance ?? null,
            iban: r.counterparty_iban,
            amount: r.amount,
            category: r.category_id ? (cats.get(r.category_id)?.name ?? "") : "",
            categoryPath: pathOf(cats, r.category_id ?? slotParent, catPaths),
            uncategorized: r.category_id === null,
            accountPath: accountPath(r.account_id),
            accountIban: accounts.get(r.account_id)?.iban ?? null,
            bookingDate: r.booking_date,
            unread: r.unread === 1,
        });
}
