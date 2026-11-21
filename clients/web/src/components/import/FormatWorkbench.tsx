import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, FileUp, Plus, Trash2, X } from "lucide-react";
import {
    FORMAT_FIELD_LABELS,
    FORMAT_MAX_STEPS,
    mapFormatRows,
    previewParts,
    type CsvTable,
    type FormatField,
    type FormatStep,
    type FormatValueRef,
    type ImportFormatDefinition,
    type ImportRow,
} from "@mbm/shared";
import { dateText, fmtSigned } from "../../lib/format";
import { FIELD_GROUPS, fieldsSummary, fileSummary, formatColumns, newStep, partName, pruneRefs, replaceStep, sourceKey, sourceLabel, sourceOptions, stepsSummary } from "../../lib/importFormat";
import { Hint } from "../common";
import { Ic } from "../icons";

type Section = "file" | "steps" | "fields";

const DELIMITERS: { value: string; label: string }[] = [
    { value: "auto", label: "Automatisch" },
    { value: ";", label: "Semikolon ;" },
    { value: ",", label: "Komma ," },
    { value: "\t", label: "Tabulator" },
    { value: "|", label: "Senkrechter Strich |" },
];

const RESULT: { field: FormatField; text: (r: ImportRow) => string }[] = [
    { field: "bookingDate", text: (r) => (r.date ? dateText(r.date) : "nicht lesbar") },
    { field: "valueDate", text: (r) => (r.valueDate ? dateText(r.valueDate) : "") },
    { field: "amount", text: (r) => (r.amount !== null ? fmtSigned(r.amount) : "nicht lesbar") },
    { field: "counterpartyName", text: (r) => r.name },
    { field: "counterpartyIban", text: (r) => r.iban ?? "" },
    { field: "counterpartyBic", text: (r) => r.counterpartyBic },
    { field: "remittance", text: (r) => r.purpose },
    { field: "bookingText", text: (r) => r.bookingText },
    { field: "category", text: (r) => r.category ?? "" },
    { field: "reference", text: (r) => r.reference },
    { field: "mandateId", text: (r) => r.mandateId },
    { field: "creditorId", text: (r) => r.creditorId },
    { field: "status", text: (r) => (r.pending ? "vorgemerkt" : "gebucht") },
];

function SectionCard({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: ReactNode }) {
    return (
        <section className={`wb-sec ${open ? "open" : ""}`}>
            <button type="button" className="wb-sec-head" aria-expanded={open} onClick={onToggle}>
                <Ic icon={open ? ChevronDown : ChevronRight} size={15} />
                <b>{title}</b>
                <small>{summary}</small>
            </button>
            {open && <div className="wb-sec-body">{children}</div>}
        </section>
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

function SelectSetting<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
    return (
        <label className="field">
            <span className="flabel">{label}</span>
            <select className="inp inp-sm" value={value} onChange={(e) => onChange(e.target.value as T)}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        </label>
    );
}

/** One entry of a list of words. An empty entry stays while typing and falls back when left. */
function ChipInput({ value, label, onChange, onRemove }: { value: string; label: string; onChange: (text: string) => void; onRemove?: (() => void) | undefined }) {
    const [draft, setDraft] = useState<string | null>(null);
    const shown = draft ?? value;
    return (
        <span className="wb-chip">
            <input
                aria-label={label}
                spellCheck={false}
                maxLength={60}
                size={Math.max(shown.length, 3)}
                value={shown}
                onChange={(e) => {
                    setDraft(e.target.value);
                    if (e.target.value.trim()) onChange(e.target.value.trim());
                }}
                onBlur={() => setDraft(null)}
            />
            {onRemove && (
                <button type="button" aria-label={`${value} entfernen`} onClick={onRemove}>
                    <Ic icon={X} size={12} />
                </button>
            )}
        </span>
    );
}

function ChipAdd({ label, onAdd }: { label: string; onAdd: (text: string) => void }) {
    const [text, setText] = useState("");
    const add = () => {
        if (text.trim()) onAdd(text.trim());
        setText("");
    };
    return (
        <span className="wb-chip add">
            <Ic icon={Plus} size={12} />
            <input
                aria-label={label}
                placeholder={label}
                spellCheck={false}
                maxLength={60}
                size={Math.max(text.length, label.length)}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={add}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        add();
                    }
                }}
            />
        </span>
    );
}

function StepCard({ def, index, header, onChange, onRemove }: { def: ImportFormatDefinition; index: number; header: string[]; onChange: (step: FormatStep) => void; onRemove: () => void }) {
    const step = def.steps[index]!;
    const options = sourceOptions(def, header, index);
    const inputKey = sourceKey(step.input, header);
    const setType = (type: FormatStep["type"]) => {
        if (type === step.type) return;
        onChange(
            type === "keywords"
                ? { id: step.id, input: step.input, type: "keywords", prefix: ", ", suffix: ": ", keywords: [{ text: "Stichwort", part: "Stichwort" }] }
                : { id: step.id, input: step.input, type: "separator", separator: ",", parts: ["Teil-1", "Teil-2"] },
        );
    };
    return (
        <div className="wb-step">
            <div className="wb-step-head">
                <b>Stufe {index + 1}</b>
                <div className="seg" role="group" aria-label={`Art der Stufe ${index + 1}`}>
                    <button type="button" aria-pressed={step.type === "keywords"} onClick={() => setType("keywords")}>Trennwörter</button>
                    <button type="button" aria-pressed={step.type === "separator"} onClick={() => setType("separator")}>Trennzeichen</button>
                </div>
                <button type="button" className="mini" aria-label={`Stufe ${index + 1} entfernen`} title="Stufe entfernen" onClick={onRemove}>
                    <Ic icon={Trash2} size={14} />
                </button>
            </div>
            <div className="wb-row">
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
                {step.type === "keywords" ? (
                    <>
                        <TextSetting label="Text davor" value={step.prefix} maxLength={20} onChange={(prefix) => onChange({ ...step, prefix })} />
                        <TextSetting label="Text danach" value={step.suffix} maxLength={20} onChange={(suffix) => onChange({ ...step, suffix })} />
                    </>
                ) : (
                    <TextSetting label="Trennzeichen" value={step.separator} maxLength={40} onChange={(separator) => onChange({ ...step, separator })} />
                )}
            </div>
            {step.type === "keywords" ? (
                <div className="field">
                    <span className="flabel">Trennwörter</span>
                    <div className="wb-chips">
                        {step.keywords.map((k, i) => (
                            <ChipInput
                                key={k.part}
                                label={`Trennwort ${i + 1}`}
                                value={k.text}
                                onChange={(text) => onChange({ ...step, keywords: step.keywords.map((x, at) => (at === i ? { ...x, text } : x)) })}
                                onRemove={step.keywords.length > 1 ? () => onChange({ ...step, keywords: step.keywords.filter((_, at) => at !== i) }) : undefined}
                            />
                        ))}
                        <ChipAdd label="Trennwort" onAdd={(text) => !step.keywords.some((k) => k.text === text) && onChange({ ...step, keywords: [...step.keywords, { text, part: partName(text, step.keywords.map((k) => k.part)) }] })} />
                    </div>
                </div>
            ) : (
                <div className="field">
                    <span className="flabel">Teile der Reihe nach</span>
                    <div className="wb-chips">
                        {step.parts.map((part, i) => (
                            <ChipInput
                                key={i}
                                label={`Teil ${i + 1}`}
                                value={part}
                                onChange={(text) => onChange({ ...step, parts: step.parts.map((x, at) => (at === i ? partName(text, step.parts.filter((_, other) => other !== i)) : x)) })}
                                onRemove={step.parts.length > 1 ? () => onChange({ ...step, parts: step.parts.filter((_, at) => at !== i) }) : undefined}
                            />
                        ))}
                        <ChipAdd label="Teil" onAdd={(text) => onChange({ ...step, parts: [...step.parts, partName(text, step.parts)] })} />
                    </div>
                </div>
            )}
        </div>
    );
}

function FieldRow({ field, def, header, example, onChange }: { field: FormatField; def: ImportFormatDefinition; header: string[]; example: string; onChange: (refs: FormatValueRef[] | null) => void }) {
    const options = sourceOptions(def, header);
    const refs = def.fields[field] ?? [];
    const value = refs.length === 1 ? sourceKey(refs[0]!, header) : refs.length ? "several" : "none";
    const absent = refs.length === 1 && !options.some((o) => o.key === value);
    return (
        <label className={`wb-field ${absent ? "bad" : ""}`}>
            <span>{FORMAT_FIELD_LABELS[field]}</span>
            <select
                className="inp inp-sm"
                value={value}
                onChange={(e) => {
                    const picked = options.find((o) => o.key === e.target.value);
                    onChange(picked ? [picked.ref] : null);
                }}
            >
                <option value="none">— nicht zuordnen —</option>
                {value === "several" && <option value="several" disabled>mehrere Quellen</option>}
                {absent && <option value={value} disabled>fehlt: {sourceLabel(refs[0]!)}</option>}
                {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <small title={example}>{example || "—"}</small>
        </label>
    );
}

/** The columns of a format without a file: those it names, and those typed in. */
function ManualColumns({ used, extra, onChange }: { used: string[]; extra: string[]; onChange: (extra: string[]) => void }) {
    return (
        <div className="field">
            <span className="flabel">Spalten der Datei</span>
            <div className="wb-chips">
                {used.map((c) => <span className="wb-chip fixed" key={c}>{c}</span>)}
                {extra.map((c) => (
                    <span className="wb-chip fixed" key={c}>
                        {c}
                        <button type="button" aria-label={`${c} entfernen`} onClick={() => onChange(extra.filter((x) => x !== c))}>
                            <Ic icon={X} size={12} />
                        </button>
                    </span>
                ))}
                <ChipAdd label="Spalte" onAdd={(text) => !used.includes(text) && !extra.includes(text) && onChange([...extra, text])} />
            </div>
        </div>
    );
}

function SamplePanel({ def, table, row, onRow, sampleName, onPickSample }: { def: ImportFormatDefinition; table: CsvTable | null; row: number; onRow: (row: number) => void; sampleName?: string | undefined; onPickSample?: ((f: File) => void) | undefined }) {
    const picker = onPickSample && (
        <label className="btn btn-sm btn-ghost">
            <input type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => e.target.files?.[0] && onPickSample(e.target.files[0])} />
            <Ic icon={FileUp} size={14} />
            {sampleName ? "Andere Datei" : "Beispieldatei wählen"}
        </label>
    );
    if (!table) {
        return (
            <aside className="panel wb-sample" aria-label="Beispielzeile">
                <div className="panel-head"><h3>Beispielzeile</h3></div>
                <p className="muted small">Mit einer Beispieldatei siehst du sofort, was das Format aus einer Zeile macht. Sie bleibt im Browser und wird nicht gespeichert.</p>
                {picker}
            </aside>
        );
    }
    const count = table.rows.length;
    const at = Math.min(row, Math.max(count - 1, 0));
    const read = previewParts(table, def, at);
    const result = count ? mapFormatRows({ ...table, rows: [table.rows[at]!] }, def)[0]! : null;
    const inputs = [...new Map(def.steps.filter((s) => !("step" in s.input)).map((s) => [sourceLabel(s.input), s.input])).entries()];
    const shown = RESULT.filter((c) => def.fields[c.field]?.length);
    return (
        <aside className="panel wb-sample" aria-label="Beispielzeile">
            <div className="panel-head">
                <h3>Beispielzeile</h3>
                <span className="wb-nav">
                    <button type="button" className="mini" aria-label="Vorherige Zeile" disabled={at === 0} onClick={() => onRow(at - 1)}><Ic icon={ChevronLeft} size={15} /></button>
                    <span>{count ? at + 1 : 0} von {count.toLocaleString("de-DE")}</span>
                    <button type="button" className="mini" aria-label="Nächste Zeile" disabled={at >= count - 1} onClick={() => onRow(at + 1)}><Ic icon={ChevronRight} size={15} /></button>
                </span>
            </div>
            {sampleName && <p className="faint small wb-file">{sampleName}</p>}
            {inputs.length > 0 && (
                <div className="wb-block">
                    <h4>Aus der Datei</h4>
                    {inputs.map(([label, ref]) => (
                        <div key={label}>
                            <span className="flabel">{label}</span>
                            <p className="wb-raw">{read(ref) || "—"}</p>
                        </div>
                    ))}
                </div>
            )}
            <div className="wb-block">
                <h4>Ergebnis</h4>
                {result?.error && <Hint tone="bad">{result.error}</Hint>}
                <dl className="wb-result">
                    {result && shown.map((c) => (
                        <div key={c.field}>
                            <dt>{FORMAT_FIELD_LABELS[c.field]}</dt>
                            <dd>{c.text(result) || "—"}</dd>
                        </div>
                    ))}
                </dl>
            </div>
            {picker}
        </aside>
    );
}

/**
 * Sets up an import format: on the left how a file is read and taken apart, on the right what
 * that makes of one row. Used by the import and by the format page in the settings.
 */
export function FormatWorkbench({
    def,
    onChange,
    table,
    readOnly = false,
    sampleName,
    onPickSample,
}: {
    def: ImportFormatDefinition;
    onChange: (next: ImportFormatDefinition) => void;
    /** The sample file read with this format; null without one. */
    table: CsvTable | null;
    readOnly?: boolean;
    sampleName?: string | undefined;
    onPickSample?: ((f: File) => void) | undefined;
}) {
    const [open, setOpen] = useState<Section | null>(def.steps.length ? "steps" : "fields");
    const [row, setRow] = useState(0);
    const [extra, setExtra] = useState<string[]>([]);
    const used = formatColumns(def);
    const header = table?.header.length ? table.header : [...used, ...extra.filter((c) => !used.includes(c))];
    const update = (next: ImportFormatDefinition) => onChange(pruneRefs(next));
    const setFile = (patch: Partial<ImportFormatDefinition["file"]>) => update({ ...def, file: { ...def.file, ...patch } });
    const setValues = (patch: Partial<ImportFormatDefinition["values"]>) => update({ ...def, values: { ...def.values, ...patch } });
    const toggle = (s: Section) => setOpen((o) => (o === s ? null : s));
    const delimiterChoice = DELIMITERS.some((d) => d.value === def.file.delimiter) ? def.file.delimiter : "custom";
    const headerChoice = typeof def.file.headerLine === "number" ? "line" : def.file.headerLine;
    const example = (field: FormatField): string => {
        if (!table?.rows.length) return "";
        const read = previewParts(table, def, Math.min(row, table.rows.length - 1));
        return (def.fields[field] ?? []).map(read).filter(Boolean).join(" ");
    };

    return (
        <div className="wb">
            <div className="wb-main">
                <SectionCard title="Datei lesen" summary={fileSummary(def)} open={open === "file"} onToggle={() => toggle("file")}>
                    <fieldset disabled={readOnly}>
                        <div className="wb-row">
                            <SelectSetting label="Spaltentrenner" value={delimiterChoice} options={[...DELIMITERS, { value: "custom", label: "Eigener Text" }]} onChange={(v) => setFile({ delimiter: v === "custom" ? "~" : v })} />
                            {delimiterChoice === "custom" && <TextSetting label="Eigener Trenner" value={def.file.delimiter} maxLength={10} onChange={(delimiter) => setFile({ delimiter })} />}
                            <SelectSetting
                                label="Kopfzeile"
                                value={headerChoice}
                                options={[{ value: "auto", label: "Automatisch" }, { value: "line", label: "In Zeile …" }, { value: "none", label: "Keine" }]}
                                onChange={(v) => setFile({ headerLine: v === "line" ? 1 : v })}
                            />
                            {typeof def.file.headerLine === "number" && (
                                <label className="field">
                                    <span className="flabel">Zeile mit Inhalt Nr.</span>
                                    <input className="inp inp-sm" type="number" min={1} max={1000} value={def.file.headerLine} onChange={(e) => setFile({ headerLine: Math.min(1000, Math.max(1, Number(e.target.value) || 1)) })} />
                                </label>
                            )}
                        </div>
                        {!table && <ManualColumns used={used} extra={extra.filter((c) => !used.includes(c))} onChange={setExtra} />}
                        <details className="wb-more">
                            <summary>Erweitert</summary>
                            <div className="wb-row">
                                <SelectSetting label="Kodierung" value={def.file.encoding} options={[{ value: "auto", label: "Automatisch" }, { value: "utf-8", label: "UTF-8" }, { value: "windows-1252", label: "Windows-1252" }]} onChange={(encoding) => setFile({ encoding })} />
                                <SelectSetting
                                    label="Anführungszeichen"
                                    value={def.file.quote ?? "none"}
                                    options={[{ value: "\"", label: "Doppelt \"" }, { value: "'", label: "Einfach '" }, { value: "none", label: "Keine" }]}
                                    onChange={(v) => setFile({ quote: v === "none" ? null : v })}
                                />
                                <SelectSetting label="Datum" value={def.values.dateOrder} options={[{ value: "auto", label: "Automatisch" }, { value: "dmy", label: "Tag.Monat.Jahr" }, { value: "mdy", label: "Monat/Tag/Jahr" }, { value: "ymd", label: "Jahr-Monat-Tag" }]} onChange={(dateOrder) => setValues({ dateOrder })} />
                                <SelectSetting label="Dezimalzeichen" value={def.values.decimalSeparator} options={[{ value: "auto", label: "Automatisch" }, { value: ",", label: "Komma" }, { value: ".", label: "Punkt" }]} onChange={(decimalSeparator) => setValues({ decimalSeparator })} />
                                <TextSetting label="Trenner der Kategorien" value={def.values.categorySeparator} maxLength={10} onChange={(categorySeparator) => setValues({ categorySeparator })} />
                                <TextSetting
                                    label="Wörter für „vorgemerkt“"
                                    value={def.values.pendingWords.join(", ")}
                                    maxLength={200}
                                    onChange={(v) => setValues({ pendingWords: v.split(",").map((w) => w.trim()).filter(Boolean).slice(0, 10) })}
                                />
                            </div>
                        </details>
                    </fieldset>
                </SectionCard>

                <SectionCard title="Text zerlegen" summary={stepsSummary(def)} open={open === "steps"} onToggle={() => toggle("steps")}>
                    <fieldset disabled={readOnly}>
                        <p className="hint">Eine Stufe zerlegt eine Spalte oder den Teil einer früheren Stufe. Was keinem Feld zugeordnet ist, bleibt im Teil „Rest“.</p>
                        {def.steps.map((step, i) => (
                            <StepCard
                                key={step.id}
                                def={def}
                                index={i}
                                header={header}
                                onChange={(next) => update(replaceStep(def, i, next))}
                                onRemove={() => update({ ...def, steps: def.steps.filter((_, at) => at !== i) })}
                            />
                        ))}
                        {def.steps.length < FORMAT_MAX_STEPS && (
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => update({ ...def, steps: [...def.steps, newStep(def, header)] })}>
                                <Ic icon={Plus} size={14} />
                                Stufe hinzufügen
                            </button>
                        )}
                    </fieldset>
                </SectionCard>

                <SectionCard title="Felder zuordnen" summary={fieldsSummary(def)} open={open === "fields"} onToggle={() => toggle("fields")}>
                    <fieldset disabled={readOnly}>
                        {FIELD_GROUPS.map((group) => (
                            <div className="wb-group" key={group.label}>
                                <h4>{group.label}</h4>
                                {group.fields.map((field) => (
                                    <FieldRow
                                        key={field}
                                        field={field}
                                        def={def}
                                        header={header}
                                        example={example(field)}
                                        onChange={(refs) => {
                                            const fields = { ...def.fields };
                                            if (refs) fields[field] = refs;
                                            else delete fields[field];
                                            update({ ...def, fields });
                                        }}
                                    />
                                ))}
                            </div>
                        ))}
                    </fieldset>
                </SectionCard>
            </div>
            <SamplePanel def={def} table={table} row={row} onRow={setRow} sampleName={sampleName} onPickSample={onPickSample} />
        </div>
    );
}
