import { useEffect, useRef, useState } from "react";
import { Dialog as RDialog } from "radix-ui";
import { CheckCheck, CircleDot, Copy, Link2, Pencil, PenLine, Send, Tag, Trash2, Unlink, Wand2, X } from "lucide-react";
import { groupIban, quoteTxQueryValue, returnReasonText, routes, type RuleEdit } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex, useGroups, useRules, useTransferAccounts, useTxById } from "../lib/queries";
import { useStartTransfer } from "../lib/transfer";
import { firstRuleFor } from "../lib/querytarget";
import { categoryColor, categoryPath } from "../lib/tree";
import { dateText, fmtSigned, partyName, shownParty, shownPurpose } from "../lib/format";
import { openRuleForm, openRunRules } from "../lib/rules";
import { copyText } from "../lib/clipboard";
import { markTxs } from "../lib/unread";
import { ui, useUi } from "../lib/ui";
import { INSPECTOR_QUERY, useMedia } from "../lib/media";
import { CatTile, Ic, Sym } from "../components/icons";
import { Picker, PickerButton } from "../components/pickers";
import { useCategoryItems } from "../components/pickItems";
import { TxOriginal, TxTextEditor } from "./TxOriginal";

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

/** A shown text as a template: its braces stay plain text. */
const escapeTemplate = (s: string): string => s.replace(/[\\{}]/g, "\\$&");

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
    // A first rule without a category keeps a new rule from ever winning, so it is named instead
    const [blockedFor, setBlockedFor] = useState<{ tx: number; rule: number; name: string } | null>(null);
    const blocked = blockedFor?.tx === id ? blockedFor : null;
    const [editingFor, setEditingFor] = useState<number | null>(null);

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
    // Rules and offers read the bank's name; everything shown here is the adjusted one
    const bankParty = partyName(tx);
    const party = shownParty(tx);
    const purpose = shownPurpose(tx);
    const name = party || purpose || "Umsatz";
    const by = tx.categorySource === "auto" ? "automatisch erkannt" : tx.categorySource === "manual" ? "von Hand zugeordnet" : "";
    const makeRule = () => {
        const edits: RuleEdit[] = [];
        if (tx.edits.counterparty?.value) edits.push({ op: "set", field: "counterparty", value: escapeTemplate(tx.edits.counterparty.value) });
        if (tx.edits.remittance?.value) edits.push({ op: "set", field: "remittance", value: escapeTemplate(tx.edits.remittance.value) });
        ui.openTx(null);
        openRuleForm({ kind: "draft", draft: { query: `gegenseite:${quoteTxQueryValue(bankParty)}`.slice(0, 200), categoryId: tx.categoryId, edits } });
    };

    const assign = async (v: string) => {
        const categoryId = v === "none" ? null : Number(v);
        const r = await action.run(() => call(routes.assignCategory, { body: { ids: [tx.id], categoryId } }), { topics: ["transactions", "categories"] });
        setBlockedFor(null);
        setOffer(null);
        if (!r || categoryId === null || !bankParty) return;
        // Only the first rule that hits counts: a new one at the end would never win behind it
        const first = firstRuleFor(rules, tx, accounts, groups);
        if (!first) setOffer(categoryId);
        else if (first.rule.categoryId === null) setBlockedFor({ tx: tx.id, rule: first.rule.id, name: first.rule.name || first.rule.query });
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
                        {purpose && party && row("Verwendungszweck", purpose)}
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
                    <TxOriginal key={tx.id} tx={tx} />
                    {editingFor === tx.id && <TxTextEditor tx={tx} onClose={() => setEditingFor(null)} />}
                    {blocked && (
                        <div className="offer">
                            <span>
                                <Ic icon={Wand2} size={15} /> Regel <b>„{blocked.name}“</b> erfasst diesen Umsatz, vergibt aber keine Kategorie.
                            </span>
                            <div className="row">
                                <button
                                    className="btn btn-sm btn-primary"
                                    onClick={() => {
                                        ui.openTx(null);
                                        openRuleForm({ kind: "edit", ruleId: blocked.rule });
                                    }}
                                >
                                    Regel bearbeiten
                                </button>
                                <button className="btn btn-sm btn-ghost" onClick={() => setBlockedFor(null)}>Schließen</button>
                            </div>
                        </div>
                    )}
                    {offer !== null && (
                        <div className="offer">
                            <span>
                                <Ic icon={Wand2} size={15} /> Für alle Umsätze von <b>„{bankParty}“</b> merken? Neue Umsätze bekommen dann automatisch <b>{categoryPath(index, offer)}</b>.
                            </span>
                            <div className="row">
                                <button
                                    className="btn btn-sm btn-primary"
                                    onClick={async () => {
                                        const r = await action.run(() => call(routes.createRule, { body: { name: "", query: `gegenseite:${quoteTxQueryValue(bankParty)}`, categoryId: offer, accountIds: null, extracts: [], edits: [] } }), { topics: ["rules"] });
                                        setOffer(null);
                                        if (r) {
                                            ui.openTx(null);
                                            openRunRules(r.id);
                                        }
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
                        <button className="btn" onClick={() => setEditingFor(editingFor === tx.id ? null : tx.id)}>
                            <Ic icon={PenLine} size={16} />
                            Anzeige ändern
                        </button>
                        {!!bankParty && (
                            <button className="btn" onClick={makeRule}>
                                <Ic icon={Wand2} size={16} />
                                Daraus eine Regel machen
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
                        <button className="btn" onClick={() => copyText(`${dateText(tx.bookingDate)}; ${name}; ${purpose}; ${fmtSigned(tx.amount)}`)}>
                            <Ic icon={Copy} size={16} />
                            Kopieren
                        </button>
                    </div>
                </RDialog.Content>
            </RDialog.Portal>
        </RDialog.Root>
    );
}
