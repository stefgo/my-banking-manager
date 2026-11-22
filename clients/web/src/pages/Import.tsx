import { useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, FileUp, ShieldCheck } from "lucide-react";
import { routes, type ImportFormat, type ImportFormatDefinition, type ImportPreview } from "@mbm/shared";
import { importRoute } from "../router";
import { call, errorText } from "../lib/api";
import { decodeCsv } from "../lib/decode";
import { fieldProps, focusFirstError } from "../lib/fields";
import { plural } from "../lib/format";
import { formatProblem, NO_CHOICE, useFormatTable, type ReviewChoice } from "../lib/importFormat";
import { invalidate, useAccounts, useAction, useCategoryIndex, useImportFormats } from "../lib/queries";
import { useLeaveGuard } from "../lib/useLeaveGuard";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { ui } from "../lib/ui";
import { Button, Hint, Spinner } from "../components/common";
import { Field } from "../components/form";
import { Ic, Tile } from "../components/icons";
import { FormatWorkbench } from "../components/import/FormatWorkbench";
import { ImportReview } from "../components/import/ImportReview";
import { StepList } from "../components/import/StepList";
import { Picker, PickerButton } from "../components/pickers";
import { accountPickItems } from "../components/pickItems";

type Step = "file" | "format" | "account" | "review" | "done";
type LoadedFile = { name: string; buffer: ArrayBuffer };
type Result = { imported: number; skipped: number; filled: number; recategorized: number; createdCategories: number; excluded: number };

const STEPS = ["Datei", "Format", "Konto", "Prüfen"] as const;
const STEP_ORDER: Step[] = ["file", "format", "account", "review", "done"];
const STEP_TEXT: Record<Step, string> = {
    file: "Wähle die CSV-Datei.",
    format: "Lege fest, wie die Datei gelesen wird.",
    account: "Wähle das Konto, in das importiert wird.",
    review: "Prüfe die Zeilen und wähle, was du übernimmst.",
    done: "Der Import ist abgeschlossen.",
};
const NO_FILE_SETTINGS: ImportFormatDefinition["file"] = { encoding: "auto", delimiter: "auto", quote: "\"", headerLine: "auto" };

/** Saves the format at hand: over the own one it came from, or under a new name. */
function SaveFormat({ base, def, dirty, formats, onSaved }: { base: ImportFormat | undefined; def: ImportFormatDefinition; dirty: boolean; formats: ImportFormat[]; onSaved: (f: ImportFormat) => void }) {
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const action = useAction();
    const own = base && !base.builtin ? base : null;
    const blocked = !!formatProblem(def, null);
    const options = {
        topics: ["importFormats"] as const,
        ok: "Format gespeichert",
        onError: (err: unknown) => {
            setError(errorText(err));
            return true;
        },
    };
    const saveOwn = async () => {
        setError("");
        const saved = await action.run(() => call(routes.updateImportFormat, { params: { id: own!.id! }, body: { definition: def } }), { ...options, topics: [...options.topics] });
        if (saved) onSaved(saved);
    };
    const saveNew = async () => {
        const trimmed = name.trim();
        if (!trimmed) return setError("Bitte einen Namen eingeben.");
        if (formats.some((f) => f.name.toLowerCase() === trimmed.toLowerCase())) return setError(`Ein Format „${trimmed}“ gibt es schon.`);
        setError("");
        const saved = await action.run(() => call(routes.createImportFormat, { body: { name: trimmed, definition: def } }), { ...options, topics: [...options.topics] });
        if (saved) {
            setNaming(false);
            setName("");
            onSaved(saved);
        }
    };
    if (naming) {
        return (
            <form
                className="imp-save"
                onSubmit={(e) => {
                    e.preventDefault();
                    void saveNew();
                }}
            >
                <input className="inp inp-sm" aria-label="Name des neuen Formats" placeholder="Name des Formats" maxLength={80} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                <Button className="btn-sm btn-primary" type="submit" busy={action.pending} disabled={blocked}>Speichern</Button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNaming(false)}>Abbrechen</button>
                {error && <Hint tone="bad">{error}</Hint>}
            </form>
        );
    }
    return (
        <div className="imp-save">
            {own && dirty && <Button className="btn-sm" busy={action.pending} disabled={blocked} onClick={() => void saveOwn()}>„{own.name}“ speichern</Button>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNaming(true)}>Als neues Format speichern</button>
            {error && <Hint tone="bad">{error}</Hint>}
        </div>
    );
}

/** Imports a CSV file in four steps, none of them skipped: file, format, account and review. */
export function ImportPage() {
    const { account } = importRoute.useSearch();
    const navigate = useNavigate();
    const openTransactions = useOpenTransactions();
    const accountsData = useAccounts().data;
    const accounts = accountsData ?? [];
    const accountItems = useMemo(() => accountPickItems(accountsData ?? []), [accountsData]);
    const { index } = useCategoryIndex();
    const formats = useImportFormats().data ?? [];
    const [accountId, setAccountId] = useState<number | undefined>(account);
    const [accountError, setAccountError] = useState<string | undefined>();
    const [step, setStep] = useState<Step>("file");
    const [file, setFile] = useState<LoadedFile | null>(null);
    const [def, setDef] = useState<ImportFormatDefinition | null>(null);
    const [baseKey, setBaseKey] = useState<string | null>(null);
    const [choice, setChoice] = useState<ReviewChoice>(NO_CHOICE);
    const [dirty, setDirty] = useState(false);
    // Another format starts the editor afresh; saving the one at hand leaves it as it is
    const [formatRun, setFormatRun] = useState(0);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [content, setContent] = useState("");
    const [result, setResult] = useState<Result | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [over, setOver] = useState(false);
    const action = useAction();
    const target = accounts.find((a) => a.id === accountId);
    const base = formats.find((f) => f.key === baseKey);
    const at = STEP_ORDER.indexOf(step);
    const table = useFormatTable(step === "format" ? file : null, def?.file ?? NO_FILE_SETTINGS);
    const problem = def && step === "format" && table ? formatProblem(def, table) : "";
    const guard = useLeaveGuard(!!file && step !== "done", "Import verlassen?", "Die Datei wird nicht übernommen. Nicht gespeicherte Änderungen am Format gehen verloren.");

    // Only the answer to the latest request counts: an earlier one may arrive after it
    const latest = useRef(0);
    const loadPreview = async (f: LoadedFile, format: ImportFormatDefinition, acc: number): Promise<ImportPreview | null> => {
        const request = ++latest.current;
        setBusy(true);
        setError("");
        try {
            const text = decodeCsv(f.buffer, format.file.encoding);
            const p = await call(routes.importPreview, { params: { id: acc }, body: { fileName: f.name, content: text, format } });
            if (request !== latest.current) return null;
            setContent(text);
            setPreview(p);
            return p;
        } catch (err) {
            if (request === latest.current) setError(errorText(err));
            return null;
        } finally {
            if (request === latest.current) setBusy(false);
        }
    };

    const readFile = async (f: File) => {
        if (f.size > 20_000_000) return setError("Die Datei ist größer als 20 MB.");
        const request = ++latest.current;
        setBusy(true);
        setError("");
        try {
            const next = { name: f.name, buffer: await f.arrayBuffer() };
            const found = await call(routes.detectImportFormat, { body: { content: decodeCsv(next.buffer, "auto") } });
            if (request !== latest.current) return;
            setFile(next);
            setDef(found.format);
            setBaseKey(found.formatKey);
            setChoice(NO_CHOICE);
            setPreview(null);
            setDirty(false);
            setFormatRun((n) => n + 1);
            setStep("format");
        } catch (err) {
            if (request === latest.current) setError(errorText(err));
        } finally {
            if (request === latest.current) setBusy(false);
        }
    };

    const toReview = async () => {
        if (!file || !def) return;
        if (accountId === undefined) {
            setAccountError("Bitte das Konto wählen, in das importiert wird.");
            focusFirstError({ "imp-acc": "missing" });
            return;
        }
        if (await loadPreview(file, def, accountId)) setStep("review");
    };

    const goTo = (next: Step) => {
        latest.current++;
        setBusy(false);
        setError("");
        setStep(next);
    };

    const pickFormat = (key: string) => {
        const picked = formats.find((f) => f.key === key);
        if (!picked) return;
        const take = () => {
            setDef(picked.definition);
            setBaseKey(picked.key);
            setChoice(NO_CHOICE);
            setDirty(false);
            setError("");
            setFormatRun((n) => n + 1);
        };
        if (!dirty) return take();
        ui.confirm({ title: "Änderungen verwerfen?", text: "Die Änderungen am aktuellen Format gehen verloren.", confirm: "Verwerfen", danger: true, onConfirm: take });
    };

    const commit = async (options: { createCategories: boolean; replaceCategoryLines: number[] }) => {
        if (!file || !def || accountId === undefined) return;
        setError("");
        const r = await action.run(() => call(routes.importCommit, { params: { id: accountId }, body: { fileName: file.name, content, format: def, ...options, excludeLines: [...choice.excluded] } }), {
            topics: ["accounts", "transactions", "categories", "imports"],
            onError: (err) => {
                setError(errorText(err));
                return true;
            },
        });
        if (!r) return;
        guard.release();
        setResult(r);
        setStep("done");
    };

    const restart = () => {
        latest.current++;
        setBusy(false);
        setFile(null);
        setDef(null);
        setBaseKey(null);
        setChoice(NO_CHOICE);
        setDirty(false);
        setPreview(null);
        setContent("");
        setResult(null);
        setError("");
        setStep("file");
    };

    return (
        <div className={`imp-page ${step === "format" ? "wide" : ""}`}>
            <div className="page-head">
                <div>
                    <h1>Umsätze importieren</h1>
                    <p className="muted">{STEP_TEXT[step]}</p>
                </div>
            </div>
            <StepList steps={STEPS} at={at} onPick={step === "done" ? undefined : (i) => goTo(STEP_ORDER[i]!)} />

            {step === "file" && (
                <>
                    <section className="panel imp-file">
                        {file && <p className="imp-current">Gewählt: <b>{file.name}</b></p>}
                        <label
                            className={`drop ${over ? "over" : ""}`}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setOver(true);
                            }}
                            onDragLeave={() => setOver(false)}
                            onDrop={(e) => {
                                e.preventDefault();
                                setOver(false);
                                const f = e.dataTransfer.files[0];
                                if (f) void readFile(f);
                            }}
                        >
                            <input type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} />
                            {busy ? <Spinner size={26} /> : <Ic icon={FileUp} size={26} />}
                            <b>{file ? "Andere CSV-Datei hierher ziehen oder auswählen" : "CSV-Datei hierher ziehen oder auswählen"}</b>
                            <small>z. B. CSV-Export aus dem Online-Banking, aus einem anderen Finanzprogramm oder ein Kassenbuch</small>
                        </label>
                        {error && <Hint tone="bad">{error}</Hint>}
                        <p className="hint">
                            <Ic icon={ShieldCheck} size={14} />
                            Die Datei wird nur gelesen, nicht gespeichert. Schon vorhandene Umsätze werden erkannt.
                        </p>
                    </section>
                    <div className="imp-bar narrow">
                        <Button className="btn-ghost" icon={ArrowLeft} disabled>Zurück</Button>
                        <Button className="btn-primary" icon={ArrowRight} disabled={!file || busy} onClick={() => goTo("format")}>Weiter</Button>
                    </div>
                </>
            )}

            {step === "format" && def && file && (
                <>
                    {!dirty && !base && <Hint>Kein passendes Format erkannt, bitte Spalten zuordnen.</Hint>}
                    <div className="imp-toolbar">
                        <label className="field">
                            <span className="flabel">Format</span>
                            <select className="inp inp-sm" value={baseKey ?? "none"} onChange={(e) => pickFormat(e.target.value)}>
                                {!base && <option value="none">Automatisch zugeordnet</option>}
                                <optgroup label="Standardformate">
                                    {formats.filter((f) => f.builtin).map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
                                </optgroup>
                                {formats.some((f) => !f.builtin) && (
                                    <optgroup label="Eigene Formate">
                                        {formats.filter((f) => !f.builtin).map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
                                    </optgroup>
                                )}
                            </select>
                        </label>
                        {dirty && <span className="imp-dirty">geändert</span>}
                        <SaveFormat
                            base={base}
                            def={def}
                            dirty={dirty}
                            formats={formats}
                            onSaved={(f) => {
                                setDef(f.definition);
                                setBaseKey(f.key);
                                setDirty(false);
                            }}
                        />
                    </div>
                    <FormatWorkbench
                        key={formatRun}
                        def={def}
                        table={table}
                        sampleName={file.name}
                        onChange={(next) => {
                            setDef(next);
                            setChoice(NO_CHOICE);
                            setDirty(true);
                        }}
                    />
                    {(problem || error) && <Hint tone="bad">{problem || error}</Hint>}
                    <div className="imp-bar">
                        <span className="muted">{file.name}</span>
                        <Button className="btn-ghost" icon={ArrowLeft} onClick={() => goTo("file")}>Zurück</Button>
                        <Button className="btn-primary" icon={ArrowRight} disabled={!!problem || !table} onClick={() => goTo("account")}>Weiter</Button>
                    </div>
                </>
            )}

            {step === "account" && file && (
                <>
                    <section className="panel imp-file">
                        <Field id="imp-acc" label="In Konto" error={accountError}>
                            <Picker
                                items={accountItems}
                                value={accountId === undefined ? undefined : String(accountId)}
                                onPick={(v) => {
                                    if (Number(v) !== accountId) setChoice(NO_CHOICE);
                                    setAccountId(Number(v));
                                    setAccountError(undefined);
                                }}
                                placeholder="Konto suchen …"
                                trigger={
                                    <PickerButton {...fieldProps("imp-acc", accountError)} set={!!target} icon={target && <Tile icon={target.icon} color={target.color} size={12} className="ti-s" />}>
                                        {target ? target.name : "Konto wählen"}
                                    </PickerButton>
                                }
                            />
                        </Field>
                        {error && <Hint tone="bad">{error}</Hint>}
                    </section>
                    <div className="imp-bar narrow">
                        <span className="muted">{file.name}</span>
                        <Button className="btn-ghost" icon={ArrowLeft} onClick={() => goTo("format")}>Zurück</Button>
                        <Button className="btn-primary" icon={ArrowRight} busy={busy} onClick={() => void toReview()}>Weiter zur Prüfung</Button>
                    </div>
                </>
            )}

            {step === "review" && preview && file && (
                <ImportReview
                    preview={preview}
                    index={index}
                    fileName={file.name}
                    accountName={target?.name ?? ""}
                    formatName={dirty ? `${base?.name ?? "Eigene Zuordnung"} (geändert)` : (base?.name ?? "Automatisch zugeordnet")}
                    busy={action.pending}
                    error={error}
                    choice={choice}
                    onChoice={setChoice}
                    onBack={() => goTo("account")}
                    onCommit={(options) => void commit(options)}
                />
            )}

            {step === "done" && result && (
                <section className="panel imp-done">
                    <span className="imp-done-ic"><Ic icon={Check} size={22} /></span>
                    <h2>{plural(result.imported, "Umsatz", "Umsätze")} importiert</h2>
                    <p className="muted">
                        {[
                            file?.name,
                            result.filled ? `${plural(result.filled, "Umsatz", "Umsätze")} ergänzt` : "",
                            result.recategorized ? `${plural(result.recategorized, "Kategorie", "Kategorien")} geändert` : "",
                            result.createdCategories ? `${plural(result.createdCategories, "Kategorie", "Kategorien")} angelegt` : "",
                            result.skipped ? `${result.skipped.toLocaleString("de-DE")} schon vorhanden` : "",
                            result.excluded ? `${result.excluded.toLocaleString("de-DE")} abgewählt` : "",
                        ].filter(Boolean).join(" · ")}
                    </p>
                    <div className="actions">
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => {
                                invalidate("imports");
                                restart();
                            }}
                        >
                            Weitere Datei importieren
                        </button>
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => void (accountId === undefined ? navigate({ to: "/transactions" }) : openTransactions({ kind: "show", search: { scope: `account:${accountId}` } }))}
                        >
                            Umsätze ansehen
                        </button>
                    </div>
                </section>
            )}
        </div>
    );
}
