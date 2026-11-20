import { Dialog as RDialog } from "radix-ui";
import { useNavigate } from "@tanstack/react-router";
import { Copy, List, Send, X } from "lucide-react";
import { groupIban } from "@mbm/shared";
import { copyText } from "../lib/clipboard";
import { dateTime, fmt } from "../lib/format";
import { INSPECTOR_QUERY, useMedia } from "../lib/media";
import { useAccounts, useTransfers } from "../lib/queries";
import { STATUS_LABEL, useStartTransfer, VOP_VIEW } from "../lib/transfer";
import { ui, useUi } from "../lib/ui";
import { Button } from "../components/common";
import { Ic } from "../components/icons";

/** Details of a transfer of the history: a panel beside the list on wide screens, else an overlay. */
export function TransferDrawer() {
    const id = useUi((s) => s.drawerTransfer);
    const panel = useMedia(INSPECTOR_QUERY);
    if (id === null) return null;
    return <Drawer key={panel ? "panel" : id} id={id} panel={panel} />;
}

function Drawer({ id, panel }: { id: number; panel: boolean }) {
    const t = (useTransfers().data ?? []).find((x) => x.id === id);
    const accounts = useAccounts().data ?? [];
    const start = useStartTransfer();
    const navigate = useNavigate();
    const close = () => ui.openTransfer(null);
    if (!t) return null;
    const account = accounts.find((a) => a.id === t.accountId);
    const vop = t.vop ? VOP_VIEW[t.vop.result] : null;
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
                        <span className="label">{t.instant ? "Echtzeitüberweisung" : "Überweisung"}</span>
                        <RDialog.Close className="icon-btn" aria-label="Schließen">
                            <Ic icon={X} />
                        </RDialog.Close>
                    </div>
                    <div className="d-hero">
                        <RDialog.Title asChild>
                            <h2>{t.payeeName}</h2>
                        </RDialog.Title>
                        <div className="d-amount amt">{fmt(-t.amount)}</div>
                        <span className="muted">{STATUS_LABEL[t.status]}</span>
                    </div>
                    <dl className="d-list">
                        {t.remittance && row("Verwendungszweck", t.remittance)}
                        {row("Von Konto", account?.name ?? "")}
                        {row(
                            "IBAN",
                            <>
                                <span className="mono">{groupIban(t.payeeIban)}</span>
                                <button className="copy" aria-label="IBAN kopieren" onClick={() => copyText(t.payeeIban)}>
                                    <Ic icon={Copy} size={14} />
                                </button>
                            </>,
                        )}
                        {t.payeeBic && row("BIC", <span className="mono">{t.payeeBic}</span>)}
                        {row("Empfängerprüfung", vop ? `${vop.title}${t.vop?.payeeName ? ` (Bank kennt „${t.vop.payeeName}“)` : ""}` : "keine")}
                        {t.bankMessage && row("Meldung", t.bankMessage)}
                        {t.bankReference && row("Referenz", <span className="mono">{t.bankReference}</span>)}
                        {row("End-to-End-ID", <span className="mono">{t.endToEndId}</span>)}
                        {row("Gestartet", `${dateTime(t.createdAt)} von ${t.createdBy}`)}
                        {t.finishedAt && row("Abgeschlossen", dateTime(t.finishedAt))}
                        {row("Buchung", t.transactionId ? "angekommen" : t.status === "executed" || t.status === "unknown" ? "noch nicht abgerufen" : "keine")}
                    </dl>
                    <div className="d-actions">
                        <Button
                            icon={Send}
                            onClick={() => start({ accountId: t.accountId, payeeName: t.payeeName, payeeIban: t.payeeIban, payeeBic: t.payeeBic, amount: t.amount, remittance: t.remittance, instant: t.instant })}
                        >
                            Erneut überweisen
                        </Button>
                        {t.transactionId && (
                            <Button
                                icon={List}
                                onClick={() => {
                                    close();
                                    void navigate({ to: "/transactions", search: { scope: `account:${t.accountId}` } }).then(() => ui.openTx(t.transactionId));
                                }}
                            >
                                Buchung zeigen
                            </Button>
                        )}
                    </div>
                </RDialog.Content>
            </RDialog.Portal>
        </RDialog.Root>
    );
}
