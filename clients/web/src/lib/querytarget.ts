// A booking as the search syntax sees it, built in the client (same as the server's querytarget.ts).

import { matchTxQuery, parseTxQuery, toTxQueryTarget, type Account, type AccountGroup, type Rule, type Transaction, type TxQueryTarget } from "@mbm/shared";

/** The booking as rules see it: without a category. */
export function ruleTarget(tx: Transaction, accounts: Account[], groups: AccountGroup[]): TxQueryTarget {
    const account = accounts.find((a) => a.id === tx.accountId);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const path: string[] = account ? [account.name] : [];
    for (let g = account?.groupId != null ? byId.get(account.groupId) : undefined; g && path.length < 100; g = g.parentId != null ? byId.get(g.parentId) : undefined) path.push(g.name);
    return toTxQueryTarget({
        counterparty: tx.counterpartyName,
        remittance: tx.remittance,
        iban: tx.counterpartyIban,
        amount: tx.amount,
        category: "",
        categoryPath: [],
        uncategorized: true,
        accountPath: path,
        accountIban: account?.iban ?? null,
        bookingDate: tx.bookingDate,
    });
}

/** Does an active rule match the booking? */
export function ruleCovers(rules: Rule[], target: TxQueryTarget): boolean {
    return rules.some((r) => {
        if (!r.active) return false;
        const parsed = parseTxQuery(r.query, { mode: "rule" });
        return parsed.ok && !!parsed.query && matchTxQuery(parsed.query, target);
    });
}
