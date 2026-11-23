import { useEffect, useRef, useState } from "react";
import { Dialog as RDialog } from "radix-ui";
import { CheckCheck, CircleDot, Copy, Link2, Pencil, Send, Tag, Trash2, Unlink, Wand2, X } from "lucide-react";
import { groupIban, quoteTxQueryValue, returnReasonText, routes, type Rule } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex, useGroups, useRules, useTransferAccounts, useTxById } from "../lib/queries";
import { useStartTransfer } from "../lib/transfer";
import { ruleCovers, ruleTarget } from "../lib/querytarget";
import { categoryColor, categoryPath } from "../lib/tree";
import { dateText, fmtSigned, partyName } from "../lib/format";
import { reviewRules } from "../lib/rules";
import { copyText } from "../lib/clipboard";
import { markTxs } from "../lib/unread";
import { ui, useUi } from "../lib/ui";
import { INSPECTOR_QUERY, useMedia } from "../lib/media";
import { CatTile, Ic, Sym } from "../components/icons";
import { Picker, PickerButton } from "../components/pickers";
import { useCategoryItems } from "../components/pickItems";

/**
 * Details of a booking. On wide screens a panel beside the list: the list stays usable and J/K
 * switch the booking. Narrower, an overlay (from below on phones).
 */
export function TxDrawer() {
    const id = useUi((s) => s.drawerTx);
    const panel = useMedia(INSPECTOR_QUERY);
    if (id === null) return null;
    // The panel stays mounted while the booking changes; the overlay opens anew for each
    return <Drawer key={panel ? "panel" : id} id={id} panel={panel} />;
}

function Drawer({ id, panel }: { id: number; panel: boolean }) {
    const tx = useTxById(id);
    const accounts = useAccounts().data ?? [];
    const groups = useGroups().data ?? [];
    const { index } = useCategoryIndex();
    const rules = useRules().data ?? [];
    const catItems = useCategoryItems({ none: true });
    const action = useAction();
    const partner = useTxById(tx?.counterTransactionId ?? null);
    const returnLink = tx?.returnOfId ?? tx?.returnedById ?? null;
    const returnPartner = useTxById(returnLink);
    const canTransfer = (useTransferAccounts().data ?? []).length > 0;
    const startTransfer = useStartTransfer();
    // The rule offer belongs to the booking it was made for
    const [offerFor, setOfferFor] = useState<{ tx: number; category: number } | null>(null);
    const offer = offerFor?.tx === id ? offerFor.category : null;
    const setOffer = (category: number | null) => setOfferFor(category === null ? null : { tx: id, category });

    // Opening a booking reads it, once: marked as new again here, it stays new
    const readFor = useRef<number | null>(null);
    useEffect(() => {
        if (!tx || readFor.current === tx.id) return;
        readFor.current = tx.id;
        if (tx.unread) void markTxs([tx], false, true);
    }, [tx]);

    const close = () => ui.openTx(null);
    if (!tx) return null;
    const account = accounts.find((a) => a.id === tx.accountId);
    const offline = accounts.filter((a) => a.kind === "offline" && a.id !== tx.accountId);
    const c = tx.categoryId !== null ? index.byId.get(tx.categoryId) : undefined;
    const party = partyName(tx);
    const name = party || tx.remittance || "Umsatz";
    const rule: Rule | undefined = tx.categorySource === "rule" ? rules.find((r) => r.categoryId === tx.categoryId && r.active) : undefined;
    const by = tx.categorySource === "rule" ? `über Regel${rule ? ` „${rule.query}“` : ""}` : tx.categorySource === "auto" ? "automatisch erkannt" : tx.categorySource === "manual" ? "von Hand zugeordnet" : "";

    const assign = async (v: string) => {
        const categoryId = v === "none" ? null : Number(v);
        const r = await action.run(() => call(routes.assignCategory, { body: { ids: [tx.id], categoryId } }), { topics: ["transactions", "categories"] });
        // Offer a rule when no active rule covers this booking yet
        if (r && categoryId !== null && party && !ruleCovers(rules, ruleTarget(tx, accounts, groups))) {
            setOffer(categoryId);
        }
    };

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
                    // As a panel: the focus stays in the list, and clicks beside it do not close it
                    onOpenAutoFocus={panel ? (e) => e.preventDefault() : undefined}
                    onInteractOutside={panel ? (e) => e.preventDefault() : undefined}
                >
                    <div className="d-top">
                        <span className="label">Umsatz</span>
                        <RDialog.Close className="icon-btn" aria-label="Schließen">
                            <Ic icon={X} />
                        </RDialog.Close>
                    </div>
                    <div className="d-hero">
                        <Picker
                            items={catItems}
                            value={tx.categoryId === null ? "none" : String(tx.categoryId)}
                            onPick={(v) => void assign(v)}
                            placeholder="Kategorie suchen …"
                            trigger={
                                <button
                                    className={`av av-l ${c ? `k-${categoryColor(index, c.id)}` : "none"}`}
                                    aria-label="Kategorie wählen"
                                    title="Kategorie wählen"
                                    style={c ? ({ "--c": `var(--p-${categoryColor(index, c.id)})` } as React.CSSProperties) : undefined}
                                >
                                    {c ? <Sym name={c.icon} size={26} /> : "?"}
                                </button>
                            }
                        />
                        <RDialog.Title asChild>
                            <h2>
                                {name}
                                {tx.status === "pending" && <span className="pill">vorgemerkt</span>}
                            </h2>
                        </RDialog.Title>
                        <div className={`d-amount amt ${tx.amount > 0 ? "pos" : ""}`}>{fmtSigned(tx.amount)}</div>
                    </div>
                    <dl className="d-list">
                        {row(
                            "Kategorie",
                            <>
                                <Picker
                                    items={catItems}
                                    value={tx.categoryId === null ? "none" : String(tx.categoryId)}
                                    onPick={(v) => void assign(v)}
                                    placeholder="Kategorie suchen …"
                                    trigger={
                                        <PickerButton set={!!c} icon={c ? <CatTile idx={index} id={c.id} size={12} className="ti-s" /> : <Ic icon={Tag} size={14} />}>
                                            {c ? categoryPath(index, c.id) : "Kategorie wählen"}
                                        </PickerButton>
                                    }
                                />
                                {by && <span className="faint small">{by}</span>}
                            </>,
                        )}
                        {tx.remittance && party && row("Verwendungszweck", tx.remittance)}
                        {tx.bookingText && row("Umsatzart", tx.bookingText)}
                        {tx.returnReason && row("Rückgabegrund", returnReasonText(tx.returnReason))}
                        {returnLink !== null &&
                            row(
                                tx.returnOfId !== null ? "Rückgabe von" : "Zurückgegeben durch",
                                <button className="link" onClick={() => ui.openTx(returnLink)}>
                                    {returnPartner ? (
                                        <>
                                            {dateText(returnPartner.bookingDate)} · <span className="amt">{fmtSigned(returnPartner.amount)}</span>
                                        </>
                                    ) : (
                                        "Umsatz öffnen"
                                    )}
                                </button>,
                            )}
                        {tx.reference && row("Referenz", <span className="mono">{tx.reference}</span>)}
                        {tx.mandateId && row("Mandat", <span className="mono">{tx.mandateId}</span>)}
                        {tx.creditorId && row("Gläubiger-ID", <span className="mono">{tx.creditorId}</span>)}
                        {row("Buchungstag", tx.status === "pending" ? `${dateText(tx.bookingDate)} · noch nicht gebucht` : dateText(tx.bookingDate))}
                        {tx.valueDate && tx.valueDate !== tx.bookingDate && row("Wertstellung", dateText(tx.valueDate))}
                        {row("Konto", account?.name ?? "")}
                        {tx.ultimateParty && tx.counterpartyName && row("Kontoinhaber", tx.counterpartyName)}
                        {tx.counterpartyIban &&
                            row(
                                "IBAN",
                                <>
                                    <span className="mono">{groupIban(tx.counterpartyIban)}</span>
                                    <button className="copy" aria-label="IBAN kopieren" onClick={() => copyText(tx.counterpartyIban!)}>
                                        <Ic icon={Copy} size={14} />
                                    </button>
                                </>,
                            )}
                        {tx.counterpartyAccount && row("Kontonummer", <span className="mono">{tx.counterpartyAccount}</span>)}
                        {tx.counterpartyBankCode && row("BLZ", <span className="mono">{tx.counterpartyBankCode}</span>)}
                        {tx.counterpartyBic && row("BIC", <span className="mono">{tx.counterpartyBic}</span>)}
                        {row("Herkunft", tx.source === "manual" ? "von Hand erfasst" : tx.source === "import" ? "CSV-Import" : "Abruf von der Bank")}
                        {tx.counterTransactionId &&
                            row(
                                "Gegenbuchung",
                                <>
                                    <button className="link" onClick={() => ui.openTx(tx.counterTransactionId)}>
                                        {accounts.find((a) => a.id === partner?.accountId)?.name ?? "anderes Konto"}
                                        {partner && <> · <span className="amt">{fmtSigned(partner.amount)}</span></>}
                                    </button>
                                    <button
                                        className="link"
                                        style={{ marginLeft: 10 }}
                                        onClick={() => void action.run(() => call(routes.deleteCounterBooking, { params: { id: tx.id } }), { topics: ["accounts", "transactions", "categories"], ok: "Gegenbuchung entfernt" })}
                                    >
                                        <Ic icon={Unlink} size={13} />
                                        lösen
                                    </button>
                                </>,
                            )}
                    </dl>
                    {offer !== null && (
                        <div className="offer">
                            <span>
                                <Ic icon={Wand2} size={15} /> Für alle Umsätze von <b>„{party}“</b> merken? Neue Umsätze bekommen dann automatisch <b>{categoryPath(index, offer)}</b>.
                            </span>
                            <div className="row">
                                <button
                                    className="btn btn-sm btn-primary"
                                    onClick={async () => {
                                        const r = await action.run(() => call(routes.createRule, { body: { query: `gegenseite:${quoteTxQueryValue(party)}`, categoryId: offer } }), { topics: ["rules"] });
                                        setOffer(null);
                                        if (r) await reviewRules({ ruleId: r.id, created: true });
                                    }}
                                >
                                    Regel anlegen
                                </button>
                                <button className="btn btn-sm btn-ghost" onClick={() => setOffer(null)}>Nur dieser Umsatz</button>
                            </div>
                        </div>
                    )}
                    <div className="d-actions">
                        {canTransfer && tx.counterpartyIban && (
                            <button
                                className="btn"
                                onClick={() => {
                                    ui.openTx(null);
                                    startTransfer({ payeeName: tx.counterpartyName, payeeIban: tx.counterpartyIban!, ...(tx.amount < 0 ? { amount: -tx.amount, remittance: tx.remittance.slice(0, 140) } : {}) });
                                }}
                            >
                                <Ic icon={Send} size={16} />
                                Überweisen an …
                            </button>
                        )}
                        {tx.source === "manual" && (
                            <button className="btn" onClick={() => ui.open({ kind: "booking", txId: tx.id })}>
                                <Ic icon={Pencil} size={16} />
                                Bearbeiten
                            </button>
                        )}
                        {!tx.counterTransactionId && offline.length > 0 && tx.status !== "pending" && (
                            <button className="btn" onClick={() => ui.open({ kind: "counterBooking", txId: tx.id })}>
                                <Ic icon={Link2} size={16} />
                                Gegenbuchung in Offline-Konto …
                            </button>
                        )}
                        {tx.source === "manual" && (
                            <button
                                className="btn btn-ghost btn-danger"
                                onClick={() =>
                                    ui.confirm({
                                        title: `Buchung „${name}“ löschen?`,
                                        text: `Die Buchung über ${fmtSigned(tx.amount)} wird gelöscht.${tx.counterTransactionId ? " Die Verknüpfung zur Gegenbuchung wird gelöst." : ""} Das lässt sich nicht rückgängig machen.`,
                                        confirm: "Löschen",
                                        danger: true,
                                        onConfirm: async () => {
                                            const ok = await action.succeeds(() => call(routes.deleteTransaction, { params: { id: tx.id } }), { topics: ["accounts", "transactions", "categories"], ok: "Buchung gelöscht" });
                                            if (ok) close();
                                            return ok;
                                        },
                                    })
                                }
                            >
                                <Ic icon={Trash2} size={16} />
                                Löschen
                            </button>
                        )}
                        <button className="btn" onClick={() => void markTxs([tx], !tx.unread)}>
                            <Ic icon={tx.unread ? CheckCheck : CircleDot} size={16} />
                            {tx.unread ? "Als gelesen markieren" : "Als neu markieren"}
                        </button>
                        <button className="btn" onClick={() => copyText(`${dateText(tx.bookingDate)}; ${name}; ${tx.remittance}; ${fmtSigned(tx.amount)}`)}>
                            <Ic icon={Copy} size={16} />
                            Kopieren
                        </button>
                    </div>
                </RDialog.Content>
            </RDialog.Portal>
        </RDialog.Root>
    );
}
