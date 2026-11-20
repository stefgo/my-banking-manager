import { Dialog as RDialog } from "radix-ui";
import { Copy, X } from "lucide-react";
import { addDaysIso, groupIban, standingOrderDates, todayIso, type AccountScope } from "@mbm/shared";
import { copyText } from "../lib/clipboard";
import { dateText, dateTime, fmt } from "../lib/format";
import { useLocalSetting } from "../lib/localSettings";
import { INSPECTOR_QUERY, useMedia } from "../lib/media";
import { orderKey, orderRhythm } from "../lib/orders";
import { useAccounts, useOrders } from "../lib/queries";
import { ui, useUi } from "../lib/ui";
import { Ic } from "../components/icons";

/** How many coming runs of a standing order the details list. */
const NEXT_RUNS = 6;

/**
 * Details of an order. On wide screens a panel beside the list, narrower an overlay (from below
 * on phones), like the details of a booking.
 */
export function OrderDrawer() {
    const key = useUi((s) => s.drawerOrder);
    const panel = useMedia(INSPECTOR_QUERY);
    if (key === null) return null;
    return <Drawer key={panel ? "panel" : key} orderKeyOpen={key} panel={panel} />;
}

function Drawer({ orderKeyOpen, panel }: { orderKeyOpen: string; panel: boolean }) {
    // The same list the page shows, so the details follow a fetch
    const scope = useLocalSetting("ordersScope") as AccountScope;
    const inScope = useOrders(scope).data?.orders.find((o) => orderKey(o) === orderKeyOpen);
    // Opened from elsewhere (the overview), the order may lie outside the page's selection
    const all = useOrders("all").data?.orders.find((o) => orderKey(o) === orderKeyOpen);
    const order = inScope ?? all;
    const accounts = useAccounts().data ?? [];
    const close = () => ui.openOrder(null);
    if (!order) return null;

    const account = accounts.find((a) => a.id === order.accountId);
    const payeeAccount = order.payeeAccountId !== null ? accounts.find((a) => a.id === order.payeeAccountId) : undefined;
    const today = todayIso();
    const runs = order.kind === "standing" ? standingOrderDates({ unit: order.unit, every: order.every, executionDay: order.executionDay, firstDate: order.firstDate, lastDate: order.lastDate }, today, addDaysIso(today, 800)).slice(0, NEXT_RUNS) : [];
    const row = (k: string, v: React.ReactNode) => (
        <div>
            <dt>{k}</dt>
            <dd>{v}</dd>
        </div>
    );

    return (
        <RDialog.Root open modal={!panel} onOpenChange={(o) => !o && close()}>
            <RDialog.Portal>
                {!panel && <RDialog.Overlay className="scrim" />}
                <RDialog.Content
                    className={`drawer ${panel ? "panel" : ""}`}
                    aria-describedby={undefined}
                    onOpenAutoFocus={panel ? (e) => e.preventDefault() : undefined}
                    onInteractOutside={panel ? (e) => e.preventDefault() : undefined}
                >
                    <div className="d-top">
                        <span className="label">{order.kind === "standing" ? "Dauerauftrag" : "Terminüberweisung"}</span>
                        <RDialog.Close className="icon-btn" aria-label="Schließen">
                            <Ic icon={X} />
                        </RDialog.Close>
                    </div>
                    <div className="d-hero">
                        <RDialog.Title asChild>
                            <h2>
                                {order.payeeName || "Auftrag"}
                                {order.nextDate === null && <span className="pill">beendet</span>}
                            </h2>
                        </RDialog.Title>
                        <div className="d-amount amt">{fmt(-order.amount)}</div>
                        <span className="muted">{orderRhythm(order)}</span>
                    </div>
                    <dl className="d-list">
                        {order.remittance && row("Verwendungszweck", order.remittance)}
                        {row("Von Konto", account?.name ?? "")}
                        {payeeAccount && row("An eigenes Konto", payeeAccount.name)}
                        {order.payeeIban &&
                            row(
                                "IBAN",
                                <>
                                    <span className="mono">{groupIban(order.payeeIban)}</span>
                                    <button className="copy" aria-label="IBAN kopieren" onClick={() => copyText(order.payeeIban)}>
                                        <Ic icon={Copy} size={14} />
                                    </button>
                                </>,
                            )}
                        {order.payeeBic && row("BIC", <span className="mono">{order.payeeBic}</span>)}
                        {row("Nächste Ausführung", order.nextDate ? dateText(order.nextDate) : "keine mehr")}
                        {order.kind === "standing" && row("Erste Ausführung", dateText(order.firstDate))}
                        {order.kind === "standing" && row("Letzte Ausführung", order.lastDate ? dateText(order.lastDate) : "unbefristet")}
                        {order.kind === "scheduled" && order.nextDate !== null && order.nextDate !== order.executionDate && row("Eingereicht für", dateText(order.executionDate))}
                        {runs.length > 1 && row("Nächste Termine", <span className="runs">{runs.map((d) => <span key={d}>{dateText(d)}</span>)}</span>)}
                        {row("Stand", `abgerufen am ${dateTime(order.fetchedAt)}`)}
                    </dl>
                    <p className="muted small">Termine berechnet MBM aus dem Turnus; fällt einer auf ein Wochenende oder einen Feiertag, rückt er auf den nächsten Bankarbeitstag. Die Bank kann im Einzelfall abweichen.</p>
                </RDialog.Content>
            </RDialog.Portal>
        </RDialog.Root>
    );
}
