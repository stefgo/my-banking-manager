import { CalendarDays, RefreshCw } from "lucide-react";
import type { AccountScope, Order } from "@mbm/shared";
import { isActive, startSync, useConnections, useSyncRuns } from "../lib/bank";
import { dateTime, plural } from "../lib/format";
import { useLocalSetting, writeLocalSetting } from "../lib/localSettings";
import { orderKey, orderRhythm } from "../lib/orders";
import { useAccounts, useOrders } from "../lib/queries";
import { ui, useUi } from "../lib/ui";
import { Button, Empty, NoBankAccess } from "../components/common";
import { Ic } from "../components/icons";
import { OrderRow } from "../components/OrderRow";
import { Picker, PickerButton } from "../components/pickers";
import { scopeLabel, useScopeItems } from "../components/pickItems";
import { SkeletonRows } from "../components/Skeleton";

/** Standing orders and scheduled transfers as last fetched from the banks; the bank is the source. */
export function OrdersPage() {
    const saved = useLocalSetting("ordersScope");
    const scopeItems = useScopeItems();
    // A saved account or group that no longer exists falls back to all accounts
    const scope: AccountScope = scopeItems.some((i) => i.value === saved) ? saved : "all";
    const list = useOrders(scope);
    const accounts = useAccounts().data ?? [];
    const open = useUi((s) => s.drawerOrder);
    const connections = useConnections();
    const hasLogin = (connections.data ?? []).some((c) => c.myLogin !== null);
    const fetching = (useSyncRuns().data ?? []).some((r) => r.ordersOnly && isActive(r));

    const data = list.data;
    const orders = data?.orders ?? [];
    const standing = orders.filter((o) => o.kind === "standing");
    const scheduled = orders.filter((o) => o.kind === "scheduled");
    const reachable = data?.accounts ?? [];
    const fetched = reachable.map((a) => a.fetchedAt).filter((f): f is string => f !== null).sort();
    const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "";
    const several = new Set(orders.map((o) => o.accountId)).size > 1;

    const fetch = () => {
        if (fetching) return;
        void startSync(scope.startsWith("account:") ? { accountId: Number(scope.slice(8)) } : {}, undefined, true);
    };
    const fetchButton = (primary = false) => (
        <Button icon={RefreshCw} iconSize={primary ? 15 : 14} className={primary ? "btn-primary" : "btn-sm"} busy={fetching} onClick={fetch}>
            Abrufen
        </Button>
    );

    // Oldest fetch of the accounts in scope, so the stamp never claims more than is true
    const never = reachable.length - fetched.length;
    const status =
        reachable.length === 0 ? null : fetched.length === 0 ? "Noch nicht abgerufen" : `Stand ${dateTime(fetched[0]!)}${never > 0 ? ` · ${plural(never, "Konto", "Konten")} offen` : ""}`;

    const section = (title: string, items: Order[]) =>
        items.length > 0 && (
            <section className="orders-section" aria-label={title}>
                <div className="day">
                    <span>{title}</span>
                    <span>{items.length}</span>
                </div>
                <div className="up-list flat">
                    {items.map((o) => (
                        <OrderRow
                            key={orderKey(o)}
                            date={o.nextDate}
                            name={o.payeeName}
                            detail={[orderRhythm(o), o.remittance, several ? accountName(o.accountId) : ""].filter(Boolean).join(" · ")}
                            amount={o.amount}
                            internal={o.payeeAccountId !== null}
                            selected={open === orderKey(o)}
                            onClick={() => ui.openOrder(open === orderKey(o) ? null : orderKey(o))}
                        />
                    ))}
                </div>
            </section>
        );

    return (
        <>
            <section className="hero ctx">
                <div className="ctx-top">
                    <span className="ctx-ic">
                        <Ic icon={CalendarDays} size={22} />
                    </span>
                    <div className="ctx-title">
                        <span className="label">Dauer- und Terminaufträge</span>
                        <h1>Aufträge</h1>
                        {status && <p className="bank-line">{status}</p>}
                    </div>
                </div>
                {reachable.length > 0 && <div className="ctx-actions">{fetchButton()}</div>}
                {reachable.some((a) => a.needsApproval) && (
                    <p className="muted small note">Deine Bank verlangt für Aufträge jedes Mal eine Freigabe. Sie kommen deshalb nicht mit dem Abruf der Umsätze, sondern nur über „Abrufen“.</p>
                )}
            </section>
            <div className="filters" role="group" aria-label="Filter">
                <Picker
                    items={scopeItems}
                    value={scope}
                    onPick={(v) => {
                        ui.openOrder(null);
                        writeLocalSetting("ordersScope", v);
                    }}
                    placeholder="Konto oder Gruppe suchen …"
                    trigger={
                        <PickerButton set={scope !== "all"} aria-label="Konten wählen">
                            {scopeLabel(scope, scopeItems)}
                        </PickerButton>
                    }
                />
            </div>
            <section className="panel list-panel" aria-label="Aufträge">
                {!data || connections.isPending ? (
                    <SkeletonRows rows={5} />
                ) : orders.length === 0 ? (
                    reachable.length === 0 ? (
                        !hasLogin ? (
                            <NoBankAccess reason="Aufträge liest MBM bei deiner Bank." />
                        ) : (
                            <Empty
                                icon={CalendarDays}
                                title="Keine Aufträge"
                                text={scope === "all" ? "Deine Bank bietet Daueraufträge und Terminüberweisungen nicht über FinTS an." : "Für diese Auswahl bietet keine Bank Aufträge an, oder es fehlt die eigene Anmeldung."}
                            />
                        )
                    ) : fetched.length === 0 ? (
                        <Empty icon={CalendarDays} title="Noch nicht abgerufen" text="MBM holt deine Dauer- und Terminaufträge bei der Bank ab und zeigt, was wann abgeht." action={fetchButton(true)} />
                    ) : (
                        <Empty icon={CalendarDays} title="Keine Aufträge bei der Bank" text="Bei der Bank sind weder Daueraufträge noch Terminüberweisungen hinterlegt." />
                    )
                ) : (
                    <>
                        {section("Daueraufträge", standing)}
                        {section("Terminüberweisungen", scheduled)}
                    </>
                )}
            </section>
        </>
    );
}
