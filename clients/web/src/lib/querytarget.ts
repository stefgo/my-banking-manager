// A booking as the rules see it, built in the client (same as the server's querytarget.ts).

import { compileRules, evaluateRules, toTxQueryTarget, type Account, type AccountGroup, type Rule, type RuleBooking, type RuleResult, type Transaction } from "@mbm/shared";

/** The bank's values of a booking: no stored category and no adjusted text. */
export function ruleBooking(tx: Transaction, accounts: Account[], groups: AccountGroup[]): RuleBooking {
    const account = accounts.find((a) => a.id === tx.accountId);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const path: string[] = account ? [account.name] : [];
    for (let g = account?.groupId != null ? byId.get(account.groupId) : undefined; g && path.length < 100; g = g.parentId != null ? byId.get(g.parentId) : undefined) path.push(g.name);
    return {
        accountId: tx.accountId,
        counterpartyName: tx.counterpartyName,
        ultimateParty: tx.ultimateParty,
        remittance: tx.remittance,
        bookingText: tx.bookingText,
        reference: tx.reference,
        mandateId: tx.mandateId,
        creditorId: tx.creditorId,
        target: toTxQueryTarget({
            counterparty: tx.counterpartyName,
            ultimateParty: tx.ultimateParty,
            remittance: tx.remittance,
            iban: tx.counterpartyIban,
            amount: tx.amount,
            category: "",
            categoryPath: [],
            uncategorized: true,
            accountPath: path,
            accountIban: account?.iban ?? null,
            bookingDate: tx.bookingDate,
        }),
    };
}

/** The first active rule that hits the booking, as a run would find it. */
export const firstRuleFor = (rules: Rule[], tx: Transaction, accounts: Account[], groups: AccountGroup[]): RuleResult<Rule> | null =>
    evaluateRules(compileRules(rules.filter((r) => r.active)), ruleBooking(tx, accounts, groups));
