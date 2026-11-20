import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, GripVertical, Plus, X } from "lucide-react";
import { INFO_LIMITS, routes, type Info } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex, useGroups } from "../lib/queries";
import { categoryPath } from "../lib/tree";
import { infoFromRows, labelSuggestions, moveRow, newRow, rowsOf, type InfoRow, type InfoTarget } from "../lib/info";
import { hintId } from "../lib/fields";
import { ui } from "../lib/ui";
import { Button, Modal } from "../components/common";
import { Field } from "../components/form";
import { Ic } from "../components/icons";

const KIND_NAMES: Record<InfoTarget, string> = { account: "Konto", group: "Kontogruppe", category: "Kategorie" };

/** Edits the label/value pairs and the note of an account, a group or a category. */
export function InfoDialog({ target, id }: { target: InfoTarget; id: number }) {
    const accounts = useAccounts().data;
    const groups = useGroups().data;
    const { index } = useCategoryIndex();
    const node =
        target === "account" ? accounts?.find((a) => a.id === id) : target === "group" ? groups?.find((g) => g.id === id) : index.byId.get(id);
    if (!node) return null;
    const name = target === "category" ? categoryPath(index, id) : node.name;
    // Accounts and groups share their labels; categories have their own
    const others: Info[] =
        target === "category"
            ? [...index.byId.values()].filter((c) => c.id !== id).map((c) => c.info)
            : [...(accounts ?? []).filter((a) => target !== "account" || a.id !== id), ...(groups ?? []).filter((g) => target !== "group" || g.id !== id)].map((n) => n.info);
    return <InfoForm key={`${target}:${id}`} target={target} id={id} name={name} info={node.info} others={others} />;
}

function InfoForm({ target, id, name, info, others }: { target: InfoTarget; id: number; name: string; info: Info; others: Info[] }) {
    const action = useAction();
    const [rows, setRows] = useState<InfoRow[]>(() => (info.attributes.length ? rowsOf(info) : [newRow()]));
    const [notes, setNotes] = useState(info.notes);
    const [errors, setErrors] = useState<Record<number, string>>({});
    const [fresh, setFresh] = useState<number | null>(null);
    const dragFrom = useRef<number | null>(null);
    const suggestions = labelSuggestions(others, rows.map((r) => r.key));

    const change = (rowId: number, patch: Partial<InfoRow>) => {
        setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
        if (errors[rowId]) setErrors(({ [rowId]: _, ...rest }) => rest);
    };
    const add = () => {
        const r = newRow();
        setRows((rs) => [...rs, r]);
        setFresh(r.id);
    };
    const remove = (rowId: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== rowId) : [newRow()]));
    const move = (from: number, to: number) => setRows((rs) => moveRow(rs, from, to));

    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        const result = infoFromRows(rows, notes);
        setErrors(result.errors);
        const bad = rows.find((r) => result.errors[r.id]);
        if (bad) {
            setTimeout(() => document.getElementById(`info-key-${bad.id}`)?.focus(), 0);
            return;
        }
        const body = { info: result.info };
        const r = await action.run<unknown>(
            () =>
                target === "account"
                    ? call(routes.updateAccount, { params: { id }, body })
                    : target === "group"
                      ? call(routes.updateGroup, { params: { id }, body })
                      : call(routes.updateCategory, { params: { id }, body }),
            { topics: [target === "account" ? "accounts" : target === "group" ? "groups" : "categories"], ok: "Infos gespeichert" },
        );
        if (r) ui.close();
    };

    const full = rows.length >= INFO_LIMITS.attributes;
    return (
        <Modal title={`Infos zu „${name}“`} onClose={() => ui.close()}>
            <form
                className="info-form"
                onSubmit={submit}
                noValidate
                onKeyDown={(e) => {
                    // ⌘/Ctrl + Enter saves, also from the note
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
                }}
            >
                <p className="label">{KIND_NAMES[target]}</p>
                <div className="field">
                    <span className="flabel" id="info-attrs">Merkmale</span>
                    <div className="info-edit" role="list" aria-labelledby="info-attrs">
                        {rows.map((r, i) => (
                            <div
                                key={r.id}
                                className="info-erow"
                                role="listitem"
                                onDragOver={(e) => {
                                    if (dragFrom.current === null) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = "move";
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    if (dragFrom.current !== null) move(dragFrom.current, i);
                                    dragFrom.current = null;
                                }}
                            >
                                <span
                                    className="info-grip"
                                    draggable
                                    title="Ziehen zum Verschieben"
                                    aria-hidden="true"
                                    onDragStart={(e) => {
                                        dragFrom.current = i;
                                        e.dataTransfer.effectAllowed = "move";
                                        e.dataTransfer.setData("text/plain", "");
                                    }}
                                    onDragEnd={() => (dragFrom.current = null)}
                                >
                                    <Ic icon={GripVertical} size={14} />
                                </span>
                                <input
                                    id={`info-key-${r.id}`}
                                    className="inp inp-sm"
                                    placeholder="Bezeichnung"
                                    aria-label={`Bezeichnung ${i + 1}`}
                                    aria-invalid={errors[r.id] ? true : undefined}
                                    aria-describedby={errors[r.id] ? `info-err-${r.id}` : undefined}
                                    list="info-labels"
                                    maxLength={INFO_LIMITS.key}
                                    autoComplete="off"
                                    autoFocus={r.id === fresh}
                                    value={r.key}
                                    onChange={(e) => change(r.id, { key: e.target.value })}
                                />
                                <input
                                    className="inp inp-sm"
                                    placeholder="Wert"
                                    aria-label={`Wert ${i + 1}`}
                                    maxLength={INFO_LIMITS.value}
                                    autoComplete="off"
                                    value={r.value}
                                    onChange={(e) => change(r.id, { value: e.target.value })}
                                />
                                <span className="info-ebtns">
                                    <button type="button" className="mini" aria-label="Nach oben" title="Nach oben" disabled={i === 0} onClick={() => move(i, i - 1)}>
                                        <Ic icon={ArrowUp} size={14} />
                                    </button>
                                    <button type="button" className="mini" aria-label="Nach unten" title="Nach unten" disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>
                                        <Ic icon={ArrowDown} size={14} />
                                    </button>
                                    <button type="button" className="mini" aria-label="Merkmal entfernen" title="Merkmal entfernen" onClick={() => remove(r.id)}>
                                        <Ic icon={X} size={14} />
                                    </button>
                                </span>
                                {errors[r.id] && (
                                    <p className="hint bad info-err" id={`info-err-${r.id}`}>
                                        {errors[r.id]}
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>
                    <datalist id="info-labels">
                        {suggestions.map((s) => (
                            <option key={s} value={s} />
                        ))}
                    </datalist>
                    <button type="button" className="link info-add" onClick={add} disabled={full}>
                        <Ic icon={Plus} size={14} />
                        {full ? `Höchstens ${INFO_LIMITS.attributes} Merkmale` : "Merkmal hinzufügen"}
                    </button>
                </div>
                <Field id="info-notes" label="Notiz" hint={`${notes.length.toLocaleString("de-DE")} von ${INFO_LIMITS.notes.toLocaleString("de-DE")} Zeichen`}>
                    <textarea
                        id="info-notes"
                        className="inp info-notes"
                        aria-describedby={hintId("info-notes")}
                        rows={6}
                        maxLength={INFO_LIMITS.notes}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                    />
                </Field>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>
                        Abbrechen
                    </button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Check}>
                        Speichern
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
