import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { routes, type Transaction, type TxEditField } from "@mbm/shared";
import { call } from "../lib/api";
import { partyName, shownParty, shownPurpose } from "../lib/format";
import { useAction } from "../lib/queries";
import { Button } from "../components/common";
import { Ic } from "../components/icons";

const ORIGIN: Record<Transaction["source"], string> = { bank: "Abruf von der Bank", import: "CSV-Import", manual: "von Hand erfasst" };

/** Sets the texts this booking shows; the bank's values stay untouched. */
export function TxTextEditor({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
    const action = useAction();
    const [party, setParty] = useState(shownParty(tx));
    const [purpose, setPurpose] = useState(shownPurpose(tx));
    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        const changes: [TxEditField, string][] = [];
        if (party.trim() !== shownParty(tx)) changes.push(["counterparty", party.trim()]);
        if (purpose.trim() !== shownPurpose(tx)) changes.push(["remittance", purpose.trim()]);
        const done = await action.run(
            async () => {
                // An emptied field goes back to the bank's value
                for (const [field, value] of changes) await call(routes.setTransactionEdit, { params: { id: tx.id, field }, body: { value: value || null } });
                return true;
            },
            { topics: ["transactions"] },
        );
        if (done) onClose();
    };
    return (
        <form className="tx-edit" onSubmit={save}>
            <label>
                <span>Gegenseite</span>
                <input className="inp inp-sm" maxLength={140} value={party} autoFocus onChange={(e) => setParty(e.target.value)} />
            </label>
            <label>
                <span>Verwendungszweck</span>
                <textarea className="inp inp-sm" rows={3} maxLength={400} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
            </label>
            <div className="row">
                <Button className="btn-primary btn-sm" type="submit" busy={action.pending}>Speichern</Button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Abbrechen</button>
            </div>
        </form>
    );
}

/** The booking as it came in, shown when a text differs from it or was decided by hand. */
export function TxOriginal({ tx }: { tx: Transaction }) {
    const [open, setOpen] = useState(false);
    const action = useAction();
    const differs = shownParty(tx) !== partyName(tx) || shownPurpose(tx) !== tx.remittance;
    const decided = tx.edits.counterparty?.source === "manual" || tx.edits.remittance?.source === "manual";
    if (!differs && !decided) return null;
    const showBank = (field: TxEditField) => void action.run(() => call(routes.setTransactionEdit, { params: { id: tx.id, field }, body: { value: null } }), { topics: ["transactions"] });
    const automatic = (field: TxEditField) => void action.run(() => call(routes.clearTransactionEdit, { params: { id: tx.id, field } }), { topics: ["transactions"] });
    const tools = (field: TxEditField, changed: boolean) => (
        <>
            {changed && <button type="button" className="link" onClick={() => showBank(field)}>Verwenden</button>}
            {tx.edits[field]?.source === "manual" && <button type="button" className="link" onClick={() => automatic(field)}>Wieder automatisch</button>}
        </>
    );
    const partyChanged = shownParty(tx) !== partyName(tx);
    return (
        <section className="tx-orig">
            <button type="button" className="tx-orig-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                <Ic icon={open ? ChevronDown : ChevronRight} size={14} />
                Originaldaten{open && ` · ${ORIGIN[tx.source]}`}
            </button>
            {open && (
                <dl className="d-list">
                    {tx.ultimateParty && (
                        <div>
                            <dt>Händler</dt>
                            <dd>{tx.ultimateParty}{tools("counterparty", partyChanged)}</dd>
                        </div>
                    )}
                    {tx.counterpartyName && (
                        <div>
                            <dt>Kontoinhaber</dt>
                            <dd>{tx.counterpartyName}{!tx.ultimateParty && tools("counterparty", partyChanged)}</dd>
                        </div>
                    )}
                    {!tx.ultimateParty && !tx.counterpartyName && (tx.edits.counterparty !== null) && (
                        <div>
                            <dt>Gegenseite</dt>
                            <dd><span className="faint">leer</span>{tools("counterparty", partyChanged)}</dd>
                        </div>
                    )}
                    {(tx.remittance || tx.edits.remittance !== null) && (
                        <div>
                            <dt>Verwendungszweck</dt>
                            <dd>{tx.remittance || <span className="faint">leer</span>}{tools("remittance", shownPurpose(tx) !== tx.remittance)}</dd>
                        </div>
                    )}
                </dl>
            )}
        </section>
    );
}
