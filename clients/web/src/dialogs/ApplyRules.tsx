import { useMemo, useState } from "react";
import { Wand2 } from "lucide-react";
import { routes, type RulePreview } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex } from "../lib/queries";
import { categoryPath } from "../lib/tree";
import { dateText, plural } from "../lib/format";
import { ui } from "../lib/ui";
import { Amt, Hint, Modal, Button } from "../components/common";
import { CatTile } from "../components/icons";

/** Shows the bookings the rules would categorize; only the ticked ones get their category. */
export function ApplyRulesDialog({ ruleId, created, preview }: { ruleId?: number; created?: boolean; preview: RulePreview }) {
    const { index } = useCategoryIndex();
    const accounts = useAccounts().data;
    const action = useAction();
    const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set(preview.items.map((m) => m.transactionId)));
    const accountName = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.name])), [accounts]);

    const single = ruleId !== undefined;
    const target = single ? preview.items[0]?.categoryId : undefined;
    const all = picked.size === preview.items.length;

    const toggle = (id: number) =>
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!picked.size) return;
        const r = await action.run(() => call(routes.applyRules, { body: { ids: [...picked], ruleId } }), {
            topics: ["transactions", "categories"],
            ok: (res) => (res.changed ? `${plural(res.changed, "Umsatz", "Umsätze")} zugeordnet` : "Keine Umsätze zugeordnet"),
        });
        if (r) ui.close();
    };

    return (
        <Modal title={single ? "Regel anwenden?" : "Regeln anwenden?"} onClose={() => ui.close()} wide>
            <form className="form-grid" style={{ maxWidth: "none", gap: 14 }} onSubmit={submit} noValidate>
                <p className="muted">
                    {created && "Die Regel ist angelegt. "}
                    {plural(preview.total, "Umsatz", "Umsätze")} ohne Kategorie {preview.total === 1 ? "passt" : "passen"}
                    {target !== undefined && (
                        <>
                            {" "}und {preview.total === 1 ? "bekommt" : "bekommen"}{" "}
                            <span className="cchip">
                                <CatTile idx={index} id={target} size={11} className="ti-s" />
                                <b>{categoryPath(index, target)}</b>
                            </span>
                        </>
                    )}
                    . Nur die ausgewählten werden zugeordnet.
                </p>
                <div className="ap-tools">
                    <span className="muted small">{picked.size} von {preview.items.length} ausgewählt</span>
                    <button type="button" className="link" onClick={() => setPicked(all ? new Set() : new Set(preview.items.map((m) => m.transactionId)))}>
                        {all ? "Keine auswählen" : "Alle auswählen"}
                    </button>
                </div>
                <div className="imp-prev">
                    {preview.items.map((m) => (
                        <label key={m.transactionId} className={`ap-row ${picked.has(m.transactionId) ? "" : "off"}`}>
                            <input type="checkbox" checked={picked.has(m.transactionId)} onChange={() => toggle(m.transactionId)} />
                            <span>{dateText(m.bookingDate)}</span>
                            <span>
                                {m.counterpartyName || "—"}
                                <small>
                                    {accountName.get(m.accountId) ?? "Konto"}
                                    {m.remittance && ` · ${m.remittance}`}
                                </small>
                            </span>
                            {!single && (
                                <span className="cchip">
                                    <CatTile idx={index} id={m.categoryId} size={11} className="ti-s" />
                                    {categoryPath(index, m.categoryId)}
                                </span>
                            )}
                            <Amt cents={m.amount} signed />
                        </label>
                    ))}
                </div>
                {preview.total > preview.items.length && (
                    <Hint>Gezeigt werden die neuesten {preview.items.length} Umsätze. Die übrigen kannst du danach erneut anwenden.</Hint>
                )}
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Nicht zuordnen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} disabled={!picked.size} icon={Wand2}>
                        {picked.size ? `${plural(picked.size, "Umsatz", "Umsätze")} zuordnen` : "Zuordnen"}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
