import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, Plus, Tag, Wallet, X } from "lucide-react";
import { parsePattern, parseTemplate, parseTxQuery, routes, RULE_MAX_EDITS, RULE_MAX_EXTRACTS, ruleIssues, type RuleEdit, type RuleExtract, type RuleSourceField, type RuleTestResult, type TxEditField } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useCategoryIndex, useRules } from "../lib/queries";
import { plural } from "../lib/format";
import { categoryPath } from "../lib/tree";
import { useSuggest } from "../lib/useSuggest";
import { Button, Hint } from "../components/common";
import { CatTile, Ic } from "../components/icons";
import { Picker, PickerButton } from "../components/pickers";
import { useCategoryItems, useScopeItems } from "../components/pickItems";
import { QueryHelp } from "../components/QueryHelp";
import { SuggestList } from "../components/SuggestList";

export interface RuleValues {
    name: string;
    query: string;
    categoryId: number | null;
    accountIds: number[] | null;
    extracts: RuleExtract[];
    edits: RuleEdit[];
}

const SOURCES: { value: RuleSourceField; label: string }[] = [
    { value: "remittance", label: "Verwendungszweck" },
    { value: "party", label: "Gegenseite" },
    { value: "ultimateParty", label: "Händler" },
    { value: "counterpartyName", label: "Kontoinhaber" },
    { value: "bookingText", label: "Umsatzart" },
    { value: "reference", label: "Referenz" },
    { value: "mandateId", label: "Mandat" },
    { value: "creditorId", label: "Gläubiger-ID" },
];

const EDIT_FIELDS: { value: TxEditField; label: string }[] = [
    { value: "counterparty", label: "Gegenseite" },
    { value: "remittance", label: "Zweck" },
];

const piecesOf = (e: RuleExtract): string[] => {
    if (e.type === "separator") return e.parts;
    if (e.type === "keywords") return e.keywords.map((k) => k.part);
    const parsed = parsePattern(e.pattern);
    return parsed.ok ? parsed.parts.flatMap((p) => (p.k === "slot" ? [p.name] : [])) : [];
};

const inputKey = (input: RuleExtract["input"]): string => ("field" in input ? `field:${input.field}` : `step:${input.step}:${input.part}`);

function inputFrom(key: string): RuleExtract["input"] {
    const [kind, a, b] = key.split(":");
    return kind === "field" ? { field: a as RuleSourceField } : { step: a!, part: b! };
}

function nextStepId(extracts: RuleExtract[]): string {
    for (let n = 1; ; n++) if (!extracts.some((e) => e.id === `s${n}`)) return `s${n}`;
}

/** Turns a step into another kind, keeping its id and input. */
function retype(e: RuleExtract, type: RuleExtract["type"]): RuleExtract {
    const base = { id: e.id, input: e.input };
    if (type === "pattern") return { ...base, type, pattern: "" };
    if (type === "separator") return { ...base, type, separator: "//", parts: [] };
    return { ...base, type, prefix: "", suffix: ":", keywords: [] };
}

function retypeEdit(e: RuleEdit, op: RuleEdit["op"]): RuleEdit {
    if (op === "set") return { op, field: e.field, value: e.op === "set" ? e.value : e.op === "replace" ? e.with : "" };
    if (op === "remove") return { op, field: e.field, text: e.op === "set" ? "" : e.text };
    return { op, field: e.field, text: e.op === "set" ? "" : e.text, with: e.op === "set" ? e.value : e.op === "replace" ? e.with : "" };
}

/** What keeps the extracts and actions from being evaluated yet; null when they can be tried. */
function draftProblem(v: RuleValues): string | null {
    if (v.accountIds?.length === 0) return "Bitte mindestens ein Konto wählen.";
    for (const e of v.extracts) {
        if (e.type === "pattern" && !e.pattern.trim()) return "Bitte ein Muster eingeben.";
        if (e.type === "separator" && (!e.separator || !e.parts.length)) return "Bitte Trennzeichen und Namen der Teile eingeben.";
        if (e.type === "keywords" && !e.keywords.length) return "Bitte Trennwörter eingeben, z. B. Referenz=ref.";
    }
    for (const e of v.edits) {
        if (e.op === "set" && !e.value.trim()) return "Bitte den neuen Text eingeben.";
        if (e.op !== "set" && !e.text) return "Bitte den gesuchten Text eingeben.";
    }
    // The missing action is told apart: what a condition hits shows before there is one
    return ruleIssues({ categoryId: v.categoryId ?? 0, extracts: v.extracts, edits: v.edits })[0] ?? null;
}

/** A text input for a list; it keeps what is being typed and reports the parsed list. */
function ListInput({ value, parse, show, ...rest }: { value: string[]; parse: (s: string) => string[]; show: (v: string[]) => string; onList: (v: string[]) => void } & Omit<React.ComponentProps<"input">, "value" | "onChange">) {
    const { onList, ...input } = rest;
    const [text, setText] = useState(() => show(value));
    return (
        <input
            {...input}
            className="inp inp-sm"
            value={text}
            onChange={(e) => {
                setText(e.target.value);
                onList(parse(e.target.value));
            }}
        />
    );
}

const splitList = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

function StepEditor({ step, index, earlier, onChange, onRemove }: { step: RuleExtract; index: number; earlier: RuleExtract[]; onChange: (e: RuleExtract) => void; onRemove: () => void }) {
    return (
        <div className="rf-line">
            <select className="inp inp-sm" aria-label={`Quelle von Stufe ${index + 1}`} value={inputKey(step.input)} onChange={(e) => onChange({ ...step, input: inputFrom(e.target.value) })}>
                <optgroup label="Text der Buchung">
                    {SOURCES.map((s) => <option key={s.value} value={`field:${s.value}`}>{s.label}</option>)}
                </optgroup>
                {earlier.map((e, i) => (
                    <optgroup key={e.id} label={`Stufe ${i + 1}`}>
                        {piecesOf(e).map((p) => <option key={p} value={`step:${e.id}:${p}`}>{p}</option>)}
                        <option value={`step:${e.id}:rest`}>Rest</option>
                    </optgroup>
                ))}
            </select>
            <select className="inp inp-sm" aria-label={`Art von Stufe ${index + 1}`} value={step.type} onChange={(e) => onChange(retype(step, e.target.value as RuleExtract["type"]))}>
                <option value="pattern">Muster</option>
                <option value="separator">Trennzeichen</option>
                <option value="keywords">Trennwörter</option>
            </select>
            <span className="rf-grow">
                {step.type === "pattern" && (
                    <input className="inp inp-sm mono" aria-label="Muster" placeholder="VISA Debit {haendler}//{ort}/" spellCheck={false} maxLength={200} value={step.pattern} onChange={(e) => onChange({ ...step, pattern: e.target.value })} />
                )}
                {step.type === "separator" && (
                    <>
                        <input className="inp inp-sm rf-short mono" aria-label="Trennzeichen" maxLength={40} value={step.separator} onChange={(e) => onChange({ ...step, separator: e.target.value })} />
                        <ListInput aria-label="Namen der Teile" placeholder="haendler, ort" spellCheck={false} value={step.parts} parse={splitList} show={(v) => v.join(", ")} onList={(parts) => onChange({ ...step, parts })} />
                    </>
                )}
                {step.type === "keywords" && (
                    <ListInput
                        aria-label="Trennwörter"
                        placeholder="Referenz=ref, Kunde=kunde"
                        spellCheck={false}
                        value={step.keywords.map((k) => `${k.text}=${k.part}`)}
                        parse={splitList}
                        show={(v) => v.join(", ")}
                        onList={(list) =>
                            onChange({
                                ...step,
                                keywords: list.flatMap((x) => {
                                    const at = x.indexOf("=");
                                    return at > 0 && at < x.length - 1 ? [{ text: x.slice(0, at).trim(), part: x.slice(at + 1).trim() }] : [];
                                }),
                            })
                        }
                    />
                )}
            </span>
            <button type="button" className="mini" aria-label={`Stufe ${index + 1} entfernen`} title="Entfernen" onClick={onRemove}>
                <Ic icon={X} size={14} />
            </button>
        </div>
    );
}

function EditEditor({ edit, index, onChange, onRemove }: { edit: RuleEdit; index: number; onChange: (e: RuleEdit) => void; onRemove: () => void }) {
    return (
        <div className="rf-line">
            <select className="inp inp-sm" aria-label={`Feld von Aktion ${index + 1}`} value={edit.field} onChange={(e) => onChange({ ...edit, field: e.target.value as TxEditField })}>
                {EDIT_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <select className="inp inp-sm" aria-label={`Art von Aktion ${index + 1}`} value={edit.op} onChange={(e) => onChange(retypeEdit(edit, e.target.value as RuleEdit["op"]))}>
                <option value="set">Setzen</option>
                <option value="remove">Entfernen</option>
                <option value="replace">Ersetzen</option>
            </select>
            <span className="rf-grow">
                {edit.op === "set" && <input className="inp inp-sm" aria-label="Neuer Text" placeholder="{haendler:titel}" spellCheck={false} maxLength={400} value={edit.value} onChange={(e) => onChange({ ...edit, value: e.target.value })} />}
                {edit.op !== "set" && <input className="inp inp-sm" aria-label="Gesuchter Text" placeholder="Kartenzahlung girocard" spellCheck={false} maxLength={200} value={edit.text} onChange={(e) => onChange({ ...edit, text: e.target.value })} />}
                {edit.op === "replace" && <input className="inp inp-sm" aria-label="Ersetzen durch" placeholder="durch …" spellCheck={false} maxLength={400} value={edit.with} onChange={(e) => onChange({ ...edit, with: e.target.value })} />}
            </span>
            <button type="button" className="mini" aria-label={`Aktion ${index + 1} entfernen`} title="Entfernen" onClick={onRemove}>
                <Ic icon={X} size={14} />
            </button>
        </div>
    );
}

function Probe({ result, ruleName }: { result: RuleTestResult; ruleName: (id: number) => string }) {
    const taken = result.hits - result.wins;
    const first = result.takenBy[0];
    return (
        <div className="rf-probe">
            <Hint>
                {plural(result.hits, "Treffer", "Treffer")}
                {taken > 0 && first && <>, davon {taken} schon durch {result.takenBy.length === 1 ? `„${ruleName(first.ruleId)}“` : `${result.takenBy.length} Regeln`} weiter oben erfasst</>}
                {result.missed > 0 && <>. Bei {plural(result.missed, "Umsatz", "Umsätzen")} fehlt ein Ausschnitt, dort trifft die Regel nicht</>}.
            </Hint>
            {result.samples.slice(0, 5).map((s) => (
                <div key={s.transactionId} className={`rf-sample ${s.hit ? "" : "miss"}`}>
                    <span className="rf-orig">{s.counterparty || "—"} · {s.remittance}</span>
                    {s.hit ? (
                        <>
                            {Object.keys(s.values).length > 0 && <small>{Object.entries(s.values).map(([k, v]) => `${k}: ${v}`).join(" · ")}</small>}
                            {(s.newCounterparty || s.newRemittance) && (
                                <span className="rf-new">
                                    <Ic icon={ArrowRight} size={13} /> {[s.newCounterparty, s.newRemittance].filter(Boolean).join(" · ")}
                                </span>
                            )}
                            {s.takenBy !== null && <small>Erfasst durch „{ruleName(s.takenBy)}“</small>}
                        </>
                    ) : (
                        <small>Ausschnitt nicht gefunden</small>
                    )}
                </div>
            ))}
        </div>
    );
}

/** A rule: where it applies, its condition, what it takes from the text and what it does. */
export function RuleForm({
    initial,
    ruleId,
    canRun = false,
    onSubmit,
    onCancel,
    autoFocus = false,
}: {
    initial?: Partial<RuleValues>;
    ruleId?: number;
    /** Offers to run the rule right after saving it. */
    canRun?: boolean;
    onSubmit: (values: RuleValues, run: boolean) => Promise<void>;
    onCancel?: () => void;
    autoFocus?: boolean;
}) {
    const { index } = useCategoryIndex();
    const accounts = useAccounts().data ?? [];
    const rules = useRules().data ?? [];
    const scopeItems = useScopeItems(true);
    const accountItems = useMemo(() => scopeItems.filter((x) => x.value === "all" || x.value.startsWith("account:")).map((x) => ({ ...x, depth: 0 })), [scopeItems]);
    const catBase = useCategoryItems({ none: true });
    const catItems = useMemo(() => catBase.map((x) => (x.value === "none" ? { ...x, label: "Keine Kategorie setzen" } : x)), [catBase]);
    const [name, setName] = useState(initial?.name ?? "");
    const [query, setQuery] = useState(initial?.query ?? "");
    const [cat, setCat] = useState<number | null>(initial?.categoryId ?? null);
    const [accountIds, setAccountIds] = useState<number[] | null>(initial?.accountIds === undefined ? null : initial.accountIds);
    const [extracts, setExtracts] = useState<RuleExtract[]>(initial?.extracts ?? []);
    const [edits, setEdits] = useState<RuleEdit[]>(initial?.edits ?? []);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<"save" | "run" | null>(null);
    const [probe, setProbe] = useState<RuleTestResult | null>(null);
    const queryRef = useRef<HTMLInputElement>(null);
    const hints = useSuggest({ value: query, onChange: setQuery, inputRef: queryRef, mode: "rule" });
    const ids = useId();

    const values: RuleValues = { name: name.trim(), query: query.trim(), categoryId: cat, accountIds, extracts, edits };
    const check = parseTxQuery(values.query, { mode: "rule" });
    const structural = draftProblem(values);
    const canTry = !!values.query && check.ok && !structural;
    const draftKey = JSON.stringify(values);

    // The sample starts a moment after the last change and writes nothing
    useEffect(() => {
        if (!canTry) return;
        let stale = false;
        const t = setTimeout(() => {
            void call(routes.testRule, { body: { ...(JSON.parse(draftKey) as RuleValues), ...(ruleId === undefined ? {} : { ruleId }) } })
                .then((r) => !stale && setProbe(r))
                .catch(() => !stale && setProbe(null));
        }, 350);
        return () => {
            stale = true;
            clearTimeout(t);
        };
    }, [canTry, draftKey, ruleId]);

    const ruleName = (id: number) => {
        const r = rules.find((x) => x.id === id);
        return r ? r.name || r.query : "Regel";
    };

    const toggleAccount = (v: string) => {
        if (v === "all") return setAccountIds(null);
        const id = Number(v.slice("account:".length));
        const now = accountIds ?? [];
        const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
        setAccountIds(next.length ? next : null);
    };
    const accountText = accountIds === null ? "Alle Konten" : accountIds.length === 0 ? "Konto fehlt" : accountIds.map((id) => accounts.find((a) => a.id === id)?.name ?? "Konto").join(", ");

    const save = async (run: boolean) => {
        if (busy) return;
        setError("");
        const problem = !values.query
            ? "Bitte eine Abfrage eingeben, z. B. gegenseite:rewe."
            : !check.ok
              ? check.error
              : (structural ?? (cat === null && !edits.length ? "Bitte eine Kategorie oder eine Aktion wählen." : null));
        if (problem) return setError(problem);
        for (const edit of edits) {
            const t = edit.op === "set" ? parseTemplate(edit.value) : edit.op === "replace" ? parseTemplate(edit.with) : null;
            if (t && !t.ok) return setError(t.error);
        }
        setBusy(run ? "run" : "save");
        await onSubmit(values, run);
        setBusy(null);
    };

    return (
        <form
            className="rf"
            noValidate
            onSubmit={(e) => {
                e.preventDefault();
                void save(false);
            }}
        >
            <div className="rf-row">
                <label htmlFor={`${ids}-name`}>Name</label>
                <input id={`${ids}-name`} className="inp inp-sm" placeholder="optional" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="rf-row">
                <span>Gilt für</span>
                <Picker
                    items={accountItems}
                    selected={accountIds === null ? ["all"] : accountIds.map((id) => `account:${id}`)}
                    onPick={toggleAccount}
                    placeholder="Konto suchen …"
                    trigger={
                        <PickerButton aria-label="Konten der Regel" set={accountIds !== null} icon={<Ic icon={Wallet} size={14} />}>
                            <span className="picker-text" title={accountText}>{accountText}</span>
                        </PickerButton>
                    }
                />
            </div>
            <div className="rf-row">
                <label htmlFor={`${ids}-q`}>Wenn</label>
                <span className="q-field">
                    <input
                        id={`${ids}-q`}
                        className="inp inp-sm"
                        placeholder='z. B. gegenseite:rewe ODER zweck:"edeka markt"'
                        aria-label="Abfrage der Regel"
                        value={query}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus={autoFocus}
                        aria-invalid={!!values.query && !check.ok ? true : undefined}
                        ref={queryRef}
                        {...hints.inputProps}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            hints.onInput();
                        }}
                        onKeyDown={(e) => {
                            if (hints.onKeyDown(e)) return;
                            if (e.key === "Escape") onCancel?.();
                        }}
                    />
                    <QueryHelp mode="rule" />
                    <SuggestList list={hints.list} />
                </span>
            </div>
            <div className="rf-row top">
                <span>Ausschnitte</span>
                <div className="rf-stack">
                    {extracts.map((step, i) => (
                        <StepEditor
                            key={step.id}
                            step={step}
                            index={i}
                            earlier={extracts.slice(0, i)}
                            onChange={(next) => setExtracts(extracts.map((x) => (x.id === step.id ? next : x)))}
                            onRemove={() => setExtracts(extracts.filter((x) => x.id !== step.id))}
                        />
                    ))}
                    {extracts.length < RULE_MAX_EXTRACTS && (
                        <button type="button" className="link rf-add" onClick={() => setExtracts([...extracts, { id: nextStepId(extracts), input: { field: "remittance" }, type: "pattern", pattern: "" }])}>
                            <Ic icon={Plus} size={13} /> Stufe hinzufügen
                        </button>
                    )}
                </div>
            </div>
            <div className="rf-row top">
                <span>Dann</span>
                <div className="rf-stack">
                    {edits.map((edit, i) => (
                        <EditEditor key={i} edit={edit} index={i} onChange={(next) => setEdits(edits.map((x, j) => (j === i ? next : x)))} onRemove={() => setEdits(edits.filter((_, j) => j !== i))} />
                    ))}
                    {edits.length < RULE_MAX_EDITS && (
                        <button type="button" className="link rf-add" onClick={() => setEdits([...edits, { op: "set", field: "counterparty", value: "" }])}>
                            <Ic icon={Plus} size={13} /> Aktion hinzufügen
                        </button>
                    )}
                    <Picker
                        items={catItems}
                        value={cat ? String(cat) : "none"}
                        onPick={(v) => setCat(v === "none" ? null : Number(v))}
                        placeholder="Kategorie suchen …"
                        trigger={
                            <PickerButton aria-label="Kategorie der Regel" set={!!cat} icon={cat ? <CatTile idx={index} id={cat} size={12} className="ti-s" /> : <Ic icon={Tag} size={15} />}>
                                <span className="picker-text" title={cat ? categoryPath(index, cat) : undefined}>{cat ? categoryPath(index, cat) : "Keine Kategorie"}</span>
                            </PickerButton>
                        }
                    />
                </div>
            </div>
            <div>
                {error ? <Hint tone="bad">{error}</Hint> : values.query && !check.ok ? <Hint tone="bad">{check.error}</Hint> : structural && values.query ? <Hint tone="bad">{structural}</Hint> : canTry && probe ? <Probe result={probe} ruleName={ruleName} /> : null}
            </div>
            <p className="muted small rf-note">Speichern ändert nur die Regel. Vorhandene Umsätze bleiben unverändert, bis du sie ausführst.</p>
            <div className="row rf-actions">
                {onCancel && (
                    <button className="btn btn-sm btn-ghost" type="button" onClick={onCancel}>
                        Abbrechen
                    </button>
                )}
                {canRun && (
                    <Button className="btn-sm" busy={busy === "run"} disabled={busy === "save"} onClick={() => void save(true)}>
                        Speichern & ausführen
                    </Button>
                )}
                <Button className="btn-primary btn-sm" type="submit" busy={busy === "save"} disabled={busy === "run"}>
                    Speichern
                </Button>
            </div>
        </form>
    );
}
