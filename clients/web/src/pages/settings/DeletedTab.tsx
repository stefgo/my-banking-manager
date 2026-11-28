import { useMemo } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import type { Account, Transaction } from "@mbm/shared";
import { useAccounts, useAction, useGroups, useTransactions } from "../../lib/queries";
import { dateText, dateTime, plural, shownParty, shownPurpose } from "../../lib/format";
import { canPurge, confirmPurge, restoreTx } from "../../lib/purge";
import { accountsInTreeOrder } from "../../lib/tree";
import { ui } from "../../lib/ui";
import { Amt, Empty } from "../../components/common";
import { SkeletonRows } from "../../components/Skeleton";
import { Ic, Tile } from "../../components/icons";

/**
 * The bookings the user deleted, per account in the order of the sidebar. They are left out of the
 * list and all figures; here they can be looked at and brought back.
 */
export function DeletedTab() {
    const list = useTransactions({ range: "all", deleted: "true", limit: 20000 });
    const accounts = accountsInTreeOrder(useGroups().data ?? [], useAccounts().data ?? []);
    const byAccount = useMemo(() => groupByAccount(list.data?.items ?? [], accounts), [list.data, accounts]);

    if (list.isPending) {
        return (
            <section className="panel">
                <SkeletonRows rows={4} plain />
            </section>
        );
    }
    if (!byAccount.length) {
        return (
            <section className="panel">
                <Empty icon={Trash2} title="Keine gelöschten Umsätze" text="Löschst du einen Umsatz in seinen Details, verschwindet er aus Liste und Auswertungen und steht dann hier. Von hier holst du ihn zurück." />
            </section>
        );
    }
    return (
        <>
            {byAccount.map(({ account, items }) => (
                <DeletedPanel key={account?.id ?? items[0]!.accountId} account={account} items={items} />
            ))}
        </>
    );
}

function DeletedPanel({ account, items }: { account: Account | undefined; items: Transaction[] }) {
    const action = useAction();
    const name = account?.name ?? "Unbekanntes Konto";
    return (
        <section className="panel" aria-label={`Gelöschte Umsätze in „${name}“`}>
            <div className="panel-head">
                <h3 className="del-head">
                    {account && <Tile icon={account.icon} color={account.color} size={13} className="ti-s" />}
                    {name}
                </h3>
                <span className="muted small">{plural(items.length, "gelöschter Umsatz", "gelöschte Umsätze")}</span>
            </div>
            <div className="row-list">
                {items.map((tx) => (
                    <div className="row-item" key={tx.id}>
                        <button className="cc-link del-main" onClick={() => ui.openTx(tx.id)}>
                            <b>{shownParty(tx) || shownPurpose(tx) || "Umsatz"}</b>
                            <small>
                                {dateText(tx.bookingDate)}
                                {tx.deletedAt ? ` · gelöscht am ${dateTime(tx.deletedAt)}` : ""}
                            </small>
                        </button>
                        <span className="row-actions del-actions">
                            <Amt cents={tx.amount} signed />
                            <button
                                className="btn btn-sm btn-ghost"
                                disabled={action.pending}
                                onClick={() => void restoreTx(tx, action)}
                            >
                                <Ic icon={RotateCcw} size={14} />
                                Wiederherstellen
                            </button>
                            {canPurge(tx) && (
                                <button
                                    className="btn btn-sm btn-ghost btn-danger"
                                    disabled={action.pending}
                                    aria-label="Endgültig löschen"
                                    title="Endgültig löschen"
                                    onClick={() => confirmPurge(tx, action)}
                                >
                                    <Ic icon={Trash2} size={14} />
                                </button>
                            )}
                        </span>
                    </div>
                ))}
            </div>
        </section>
    );
}

/** Deleted bookings per account, accounts in the order of the sidebar; newest booking first within each. */
function groupByAccount(items: Transaction[], accounts: Account[]): { account: Account | undefined; items: Transaction[] }[] {
    const per = new Map<number, Transaction[]>();
    for (const tx of items) per.set(tx.accountId, [...(per.get(tx.accountId) ?? []), tx]);
    const order = [...accounts.map((a) => a.id).filter((id) => per.has(id)), ...[...per.keys()].filter((id) => !accounts.some((a) => a.id === id))];
    return order.map((id) => ({
        account: accounts.find((a) => a.id === id),
        items: per.get(id)!.sort((a, b) => b.bookingDate.localeCompare(a.bookingDate) || b.id - a.id),
    }));
}
