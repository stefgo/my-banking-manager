import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
    FORMAT_FIELD_LABELS,
    FORMAT_FIELDS,
    FORMAT_MAX_STEPS,
    formatIssues,
    ImportFormatDefinition,
    mapFormatRows,
    missingColumns,
    readWithFormat,
    routes,
    type FormatField,
    type FormatStep,
    type ImportFormat,
    type ImportRow,
} from "@mbm/shared";
import { call, errorText } from "../lib/api";
import { dateText, fmtSigned } from "../lib/format";
import { copyName, keywordsFrom, newStep, partsFrom, pruneRefs, replaceStep, sourceKey, sourceLabel, sourceOptions } from "../lib/importFormat";
import { useAction } from "../lib/queries";
import { Button, Hint } from "../components/common";
import { Ic } from "../components/icons";

const SAMPLE_CHARS = 100_000;
const SAMPLE_ROWS = 6;

const DELIMITERS: { value: string; label: string }[] = [
    { value: "auto", label: "Automatisch" },
    { value: ";", label: "Semikolon ;" },
    { value: ",", label: "Komma ," },
    { value: "\t", label: "Tabulator" },
    { value: "|", label: "Senkrechter Strich |" },
];

const SAMPLE_COLUMNS: { field: FormatField; text: (r: ImportRow) => string }[] = [
    { field: "bookingDate", text: (r) => (r.date ? dateText(r.date) : "?") },
    { field: "amount", text: (r) => (r.amount !== null ? fmtSigned(r.amount) : "?") },
    { field: "counterpartyName", text: (r) => r.name },
    { field: "remittance", text: (r) => r.purpose },
    { field: "bookingText", text: (r) => r.bookingText },
    { field: "reference", text: (r) => r.reference },
    { field: "mandateId", text: (r) => r.mandateId },
    { field: "creditorId", text: (r) => r.creditorId },
    { field: "counterpartyIban", text: (r) => r.iban ?? "" },
    { field: "counterpartyBic", text: (r) => r.counterpartyBic },
    { field: "category", text: (r) => r.category ?? "" },
];

/** Which source feeds which field of a format. */
export function FormatFieldGrid({ def, header, onChange }: { def: ImportFormatDefinition; header: string[]; onChange: (next: ImportFormatDefinition) => void }) {
    const options = sourceOptions(def, header);
    return (
        <div className="imp-map">
            {FORMAT_FIELDS.map((field) => {
                const refs = def.fields[field] ?? [];
                const value = refs.length === 1 ? sourceKey(refs[0]!, header) : refs.length ? "several" : "none";
                const absent = refs.length === 1 && !options.some((o) => o.key === value);
                return (
                    <label className="field" key={field}>
                        <span className="flabel">{FORMAT_FIELD_LABELS[field]}</span>
                        <select
                            className="inp inp-sm"
                            value={value}
                            onChange={(e) => {
                                const fields = { ...def.fields };
                                const picked = options.find((o) => o.key === e.target.value);
                                if (picked) fields[field] = [picked.ref];
                                else delete fields[field];
                                onChange({ ...def, fields });
                            }}
                        >
                            <option value="none">— nicht zuordnen —</option>
                            {value === "several" && <option value="several" disabled>mehrere Quellen</option>}
                            {absent && <option value={value} disabled>fehlt: {sourceLabel(refs[0]!)}</option>}
                            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                        </select>
                    </label>
                );
            })}
        </div>
    );
}

/** A list of words, one per line; spaces inside a word stay while typing. */
function LinesInput({ label, values, onChange }: { label: string; values: string[]; onChange: (lines: string[]) => void }) {
    const [text, setText] = useState(values.join("\n"));
    return (
        <label className="field">
            <span className="flabel">{label}</span>
            <textarea
                className="inp inp-sm mono"
                rows={Math.min(Math.max(values.length, 2), 6)}
                spellCheck={false}
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    onChange(e.target.value.split("\n").map((l) => l.trim()).filter(Boolean));
                }}
            />
        </label>
    );
}

function TextSetting({ label, value, onChange, maxLength }: { label: string; value: string; onChange: (v: string) => void; maxLength: number }) {
    return (
        <label className="field">
            <span className="flabel">{label}</span>
            <input className="inp inp-sm mono" spellCheck={false} maxLength={maxLength} value={value} onChange={(e) => onChange(e.target.value)} />
        </label>
    );
}

function StepCard({ def, index, header, onChange, onRemove }: { def: ImportFormatDefinition; index: number; header: string[]; onChange: (step: FormatStep) => void; onRemove: () => void }) {
    const step = def.steps[index]!;
    const options = sourceOptions(def, header, index);
    const inputKey = sourceKey(step.input, header);
    return (
        <div className="fmt-step">
            <div className="fmt-step-head">
                <b>Stufe {index + 1}</b>
                <button type="button" className="mini" aria-label={`Stufe ${index + 1} entfernen`} title="Stufe entfernen" onClick={onRemove}>
                    <Ic icon={Trash2} size={14} />
                </button>
            </div>
            <div className="fmt-grid">
                <label className="field">
                    <span className="flabel">Eingabe</span>
                    <select
                        className="inp inp-sm"
                        value={inputKey}
                        onChange={(e) => {
                            const picked = options.find((o) => o.key === e.target.value);
                            if (picked) onChange({ ...step, input: picked.ref });
                        }}
                    >
                        {!options.some((o) => o.key === inputKey) && <option value={inputKey} disabled>fehlt: {sourceLabel(step.input)}</option>}
                        {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </select>
                </label>
                <label className="field">
                    <span className="flabel">Zerlegen an</span>
                    <select
                        className="inp inp-sm"
                        value={step.type}
                        onChange={(e) =>
                            onChange(
                                e.target.value === "keywords"
                                    ? { id: step.id, input: step.input, type: "keywords", prefix: ", ", suffix: ": ", keywords: [{ text: "Stichwort", part: "Stichwort" }] }
                                    : { id: step.id, input: step.input, type: "separator", separator: ",", parts: ["Teil-1", "Teil-2"] },
                            )
                        }
                    >
                        <option value="keywords">Trennwörtern</option>
                        <option value="separator">Trennzeichen</option>
                    </select>
                </label>
                {step.type === "keywords" ? (
                    <>
                        <TextSetting label="Text vor dem Wort" value={step.prefix} maxLength={20} onChange={(prefix) => onChange({ ...step, prefix })} />
                        <TextSetting label="Text nach dem Wort" value={step.suffix} maxLength={20} onChange={(suffix) => onChange({ ...step, suffix })} />
                    </>
                ) : (
                    <TextSetting label="Trennzeichen" value={step.separator} maxLength={40} onChange={(separator) => onChange({ ...step, separator })} />
                )}
            </div>
            {step.type === "keywords" ? (
                <LinesInput key={`${step.id}-keywords`} label="Trennwörter, eines je Zeile" values={step.keywords.map((k) => k.text)} onChange={(lines) => onChange({ ...step, keywords: keywordsFrom(lines, step.keywords) })} />
            ) : (
                <LinesInput key={`${step.id}-parts`} label="Namen der Teile, einer je Zeile" values={step.parts} onChange={(lines) => onChange({ ...step, parts: partsFrom(lines) })} />
            )}
        </div>
    );
}

/**
 * Edits an import format against the file at hand. The sample is worked out in the browser with
 * the code the server uses; the file only goes to the server again when the format is applied.
 */
export function ImportFormatEditor({
    initial,
    choice,
    formats,
    decode,
    onApply,
    onCancel,
}: {
    initial: ImportFormatDefinition;
    /** Key of the format being edited, if it is a stored one. */
    choice: string;
    formats: ImportFormat[];
    decode: (encoding: ImportFormatDefinition["file"]["encoding"]) => string;
    onApply: (definition: ImportFormatDefinition, key: string | null) => void;
    onCancel: () => void;
}) {
    const base = formats.find((f) => f.key === choice);
    const own = base && !base.builtin ? base : null;
    const [def, setDef] = useState(initial);
    const [name, setName] = useState(own?.name ?? (base ? copyName(base.name, formats.map((f) => f.name)) : ""));
    const [error, setError] = useState("");
    const action = useAction();
    const update = (next: ImportFormatDefinition) => setDef(pruneRefs(next));
    const setFile = (patch: Partial<ImportFormatDefinition["file"]>) => update({ ...def, file: { ...def.file, ...patch } });
    const setValues = (patch: Partial<ImportFormatDefinition["values"]>) => update({ ...def, values: { ...def.values, ...patch } });

    const encoding = def.file.encoding;
    const sample = useMemo(() => decode(encoding).slice(0, SAMPLE_CHARS), [decode, encoding]);
    const table = useMemo(() => (def.file.delimiter ? readWithFormat(sample, def) : { delimiter: "", header: [], rows: [] }), [sample, def]);
    const parsed = ImportFormatDefinition.safeParse(def);
    const absent = missingColumns(def, table.header);
    const unmapped = !def.fields.bookingDate?.length || !def.fields.amount?.length;
    const problem = !table.header.length
        ? "Mit diesen Einstellungen steht keine Tabelle in der Datei."
        : absent.length
          ? `In der Datei fehlt: ${absent.join(", ")}.`
          : unmapped
            ? "Buchungstag und Betrag müssen zugeordnet sein."
            : !parsed.success
              ? (formatIssues(def)[0] ?? "Bitte alle Angaben der Stufen ausfüllen.")
              : "";
    const rows = !problem ? mapFormatRows({ ...table, rows: table.rows.slice(0, SAMPLE_ROWS) }, def) : [];
    const shown = SAMPLE_COLUMNS.filter((c) => def.fields[c.field]?.length);
    const delimiterChoice = DELIMITERS.some((d) => d.value === def.file.delimiter) ? def.file.delimiter : "custom";
    const headerChoice = typeof def.file.headerLine === "number" ? "line" : def.file.headerLine;

    const save = async (asNew: boolean) => {
        if (!parsed.success) return;
        const trimmed = name.trim();
        if (!trimmed) return setError("Bitte einen Namen für das Format eingeben.");
        setError("");
        const saved = await action.run(
            () => (!asNew && own ? call(routes.updateImportFormat, { params: { id: own.id! }, body: { name: trimmed, definition: parsed.data } }) : call(routes.createImportFormat, { body: { name: trimmed, definition: parsed.data } })),
            {
                topics: ["importFormats"],
                ok: "Format gespeichert",
                onError: (err) => {
                    setError(errorText(err));
                    return true;
                },
            },
        );
        if (saved) onApply(saved.definition, saved.key);
    };

    return (
        <div className="fmt-editor">
            <section>
                <h3>Datei</h3>
                <div className="fmt-grid">
                    <label className="field">
                        <span className="flabel">Kodierung</span>
                        <select className="inp inp-sm" value={def.file.encoding} onChange={(e) => setFile({ encoding: e.target.value as typeof def.file.encoding })}>
                            <option value="auto">Automatisch</option>
                            <option value="utf-8">UTF-8</option>
                            <option value="windows-1252">Windows-1252</option>
                        </select>
                    </label>
                    <label className="field">
                        <span className="flabel">Spaltentrenner</span>
                        <select className="inp inp-sm" value={delimiterChoice} onChange={(e) => setFile({ delimiter: e.target.value === "custom" ? "~" : e.target.value })}>
                            {DELIMITERS.map((d) => <option key={d.label} value={d.value}>{d.label}</option>)}
                            <option value="custom">Eigener Text</option>
                        </select>
                    </label>
                    {delimiterChoice === "custom" && <TextSetting label="Eigener Trenner" value={def.file.delimiter} maxLength={10} onChange={(delimiter) => setFile({ delimiter })} />}
                    <label className="field">
                        <span className="flabel">Anführungszeichen</span>
                        <select className="inp inp-sm" value={def.file.quote ?? "none"} onChange={(e) => setFile({ quote: e.target.value === "none" ? null : (e.target.value as "\"" | "'") })}>
                            <option value={"\""}>Doppelt "</option>
                            <option value="'">Einfach '</option>
                            <option value="none">Keine</option>
                        </select>
                    </label>
                    <label className="field">
                        <span className="flabel">Kopfzeile</span>
                        <select className="inp inp-sm" value={headerChoice} onChange={(e) => setFile({ headerLine: e.target.value === "line" ? 1 : (e.target.value as "auto" | "none") })}>
                            <option value="auto">Automatisch</option>
                            <option value="line">In Zeile …</option>
                            <option value="none">Keine</option>
                        </select>
                    </label>
                    {typeof def.file.headerLine === "number" && (
                        <label className="field">
                            <span className="flabel">Zeile mit Inhalt Nr.</span>
                            <input className="inp inp-sm" type="number" min={1} max={1000} value={def.file.headerLine} onChange={(e) => setFile({ headerLine: Math.min(1000, Math.max(1, Number(e.target.value) || 1)) })} />
                        </label>
                    )}
                    <label className="field">
                        <span className="flabel">Datum</span>
                        <select className="inp inp-sm" value={def.values.dateOrder} onChange={(e) => setValues({ dateOrder: e.target.value as typeof def.values.dateOrder })}>
                            <option value="auto">Automatisch</option>
                            <option value="dmy">Tag.Monat.Jahr</option>
                            <option value="mdy">Monat/Tag/Jahr</option>
                            <option value="ymd">Jahr-Monat-Tag</option>
                        </select>
                    </label>
                    <label className="field">
                        <span className="flabel">Dezimalzeichen</span>
                        <select className="inp inp-sm" value={def.values.decimalSeparator} onChange={(e) => setValues({ decimalSeparator: e.target.value as typeof def.values.decimalSeparator })}>
                            <option value="auto">Automatisch</option>
                            <option value=",">Komma</option>
                            <option value=".">Punkt</option>
                        </select>
                    </label>
                    <TextSetting label="Trenner der Kategorien" value={def.values.categorySeparator} maxLength={10} onChange={(categorySeparator) => setValues({ categorySeparator })} />
                </div>
            </section>

            <section>
                <h3>Stufen</h3>
                <p className="hint">Eine Stufe zerlegt eine Spalte oder den Teil einer früheren Stufe. Was keinem Feld zugeordnet ist, bleibt im Teil „Rest“.</p>
                {def.steps.map((step, i) => (
                    <StepCard
                        key={step.id}
                        def={def}
                        index={i}
                        header={table.header}
                        onChange={(next) => update(replaceStep(def, i, next))}
                        onRemove={() => update({ ...def, steps: def.steps.filter((_, at) => at !== i) })}
                    />
                ))}
                {def.steps.length < FORMAT_MAX_STEPS && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => update({ ...def, steps: [...def.steps, newStep(def, table.header)] })}>
                        <Ic icon={Plus} size={14} />
                        Stufe hinzufügen
                    </button>
                )}
            </section>

            <section>
                <h3>Felder</h3>
                <FormatFieldGrid def={def} header={table.header} onChange={update} />
            </section>

            <section>
                <h3>Beispielzeilen</h3>
                {problem ? (
                    <Hint tone="bad">{problem}</Hint>
                ) : (
                    <div className="fmt-sample">
                        <table>
                            <thead>
                                <tr>{shown.map((c) => <th key={c.field}>{FORMAT_FIELD_LABELS[c.field]}</th>)}</tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.line} title={r.error ?? undefined} className={r.error ? "bad" : ""}>
                                        {shown.map((c) => <td key={c.field}>{c.text(r) || "—"}</td>)}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <label className="field">
                <span className="flabel">Name des Formats</span>
                <input className="inp" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {error && <Hint tone="bad">{error}</Hint>}
            <div className="actions">
                <button type="button" className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
                {own && <Button className="btn-ghost" busy={action.pending} disabled={!!problem} onClick={() => void save(false)}>Speichern</Button>}
                <Button className="btn-ghost" busy={action.pending} disabled={!!problem} onClick={() => void save(true)}>{base?.builtin ? "Als eigenes Format speichern" : "Als neues Format speichern"}</Button>
                <Button className="btn-primary" disabled={!!problem} onClick={() => parsed.success && onApply(parsed.data, def === initial ? choice : null)}>Für diesen Import verwenden</Button>
            </div>
        </div>
    );
}
