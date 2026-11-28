import { useMemo, useState } from "react";
import { Link2, Tag } from "lucide-react";
import { isOffline, routes } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex, useGroups, useTxById } from "../lib/queries";
import { accountsInTreeOrder, categoryPath } from "../lib/tree";
import { fmtSigned } from "../lib/format";
import { fieldProps, focusFirstError } from "../lib/fields";
import { ui } from "../lib/ui";
import { Modal, Button } from "../components/common";
import { CatTile, Ic, Tile } from "../components/icons";
import { Picker, PickerButton } from "../components/pickers";
import { Field } from "../components/form";
import { accountPickItems, useCategoryItems } from "../components/pickItems";

/** Books the opposite amount of a booking in an offline account, with the category of both. */
export function CounterBookingDialog({ txId }: { txId: number }) {
    const tx = useTxById(txId);
    const accountsData = useAccounts().data;
    const { index } = useCategoryIndex();
    const catItems = useCategoryItems({ none: true });
    const action = useAction();
    const [accountId, setAccountId] = useState<number | null>(null);
    // Undefined until the user picks: then the preset category applies, if there is one
    const [picked, setPicked] = useState<number | null | undefined>(undefined);
    const [targetError, setTargetError] = useState<string | undefined>();

    const groupsData = useGroups().data;
    // Same order as the account tree in the sidebar
    const offline = useMemo(() => accountsInTreeOrder(groupsData ?? [], accountsData ?? []).filter((a) => isOffline(a) && a.id !== tx?.accountId), [groupsData, accountsData, tx?.accountId]);
    const accountItems = useMemo(() => accountPickItems(offline), [offline]);
    if (!tx) return null;

    const preset = [...index.byId.values()].find((c) => c.counterDefault)?.id ?? null;
    const cat = picked === undefined ? preset : picked;
    const target = offline.find((a) => a.id === accountId) ?? (offline.length === 1 ? offline[0] : undefined);
    const catHint =
        cat === null
            ? "Ohne Kategorie behält dieser Umsatz seine bisherige, die Gegenbuchung bleibt ohne."
            : picked === undefined
              ? "Vorbelegt. Die Vorbelegung legst du im Menü einer Kategorie fest."
              : "Beide Buchungen bekommen diese Kategorie.";

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!target) {
            setTargetError("Bitte ein Zielkonto wählen.");
            focusFirstError({ "cb-acc": "missing" });
            return;
        }
        const r = await action.run(() => call(routes.createCounterBooking, { params: { id: tx.id }, body: { accountId: target.id, categoryId: cat } }), {
            topics: ["accounts", "transactions", "categories"],
            ok: `Gegenbuchung in „${target.name}“ angelegt${cat !== null ? `, beide als „${categoryPath(index, cat)}“` : ""}`,
        });
        if (r) ui.close();
    };

    return (
        <Modal title="Gegenbuchung anlegen" onClose={() => ui.close()} narrow>
            <form className="form-grid" style={{ gap: 16 }} onSubmit={submit} noValidate>
                <p className="muted">
                    Der Betrag wird umgekehrt als <b className="amt">{fmtSigned(-tx.amount)}</b> in einem Offline-Konto gebucht und mit diesem Umsatz verknüpft.
                </p>
                <Field id="cb-acc" label="Zielkonto" error={targetError}>
                    <Picker
                        items={accountItems}
                        value={target ? String(target.id) : undefined}
                        onPick={(v) => {
                            setAccountId(Number(v));
                            setTargetError(undefined);
                        }}
                        placeholder="Konto suchen …"
                        trigger={
                            <PickerButton {...fieldProps("cb-acc", targetError)} set={!!target} icon={target && <Tile icon={target.icon} color={target.color} size={12} className="ti-s" />}>
                                {target ? target.name : "Konto wählen"}
                            </PickerButton>
                        }
                    />
                </Field>
                <Field id="cb-cat" label="Kategorie für beide Buchungen" hint={catHint}>
                    <Picker
                        items={catItems}
                        value={cat === null ? "none" : String(cat)}
                        onPick={(v) => setPicked(v === "none" ? null : Number(v))}
                        placeholder="Kategorie suchen …"
                        trigger={
                            <PickerButton {...fieldProps("cb-cat", undefined, true)} set={cat !== null} icon={cat !== null ? <CatTile idx={index} id={cat} size={12} className="ti-s" /> : <Ic icon={Tag} size={14} />}>
                                {cat !== null ? categoryPath(index, cat) : "Ohne Kategorie"}
                            </PickerButton>
                        }
                    />
                </Field>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Link2}>
                        Gegenbuchung anlegen
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
