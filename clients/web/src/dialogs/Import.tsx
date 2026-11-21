import { useCallback, useMemo, useRef, useState } from "react";
import { Check, FileUp, ShieldCheck } from "lucide-react";
import { routes, type ImportFormatDefinition, type ImportPreview } from "@mbm/shared";
import { call, errorText } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex, useImportFormats } from "../lib/queries";
import { categoryPath } from "../lib/tree";
import { dateText, fmtSigned, plural } from "../lib/format";
import { ui } from "../lib/ui";
import { Button, Hint, Modal, Spinner } from "../components/common";
import { Ic, Tile } from "../components/icons";
import { Field } from "../components/form";
import { fieldProps, focusFirstError } from "../lib/fields";
import { Picker, PickerButton } from "../components/pickers";
import { accountPickItems } from "../components/pickItems";
import { decodeCsv } from "../lib/decode";
import { FormatFieldGrid, ImportFormatEditor } from "./ImportFormatEditor";

type Row = ImportPreview["rows"][number];
type LoadedFile = { name: string; content: string; buffer: ArrayBuffer };

/** Choice in the format list: the automatic assignment, or a format changed for this import. */
const AUTO = "auto";
const ADJUSTED = "adjusted";

/** A stored booking whose file names another category. */
const differs = (r: Row): boolean => r.categoryState === "differs";

/** A stored booking that takes details from the file. */
const fills = (r: Row): boolean => r.fillsBookingText || r.fillsDetails;

/** Imports a CSV file; without `accountId` the account is chosen first. */
export function ImportDialog({ accountId: initial }: { accountId?: number }) {
    const accountsData = useAccounts().data;
    const accounts = accountsData ?? [];
    const accountItems = useMemo(() => accountPickItems(accountsData ?? []), [accountsData]);
    const [accountId, setAccountId] = useState<number | undefined>(initial);
    const [accountError, setAccountError] = useState<string | undefined>();
    const account = accounts.find((a) => a.id === accountId);
    const { index } = useCategoryIndex();
    const formats = useImportFormats().data ?? [];
    const [file, setFile] = useState<LoadedFile | null>(null);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [format, setFormat] = useState<ImportFormatDefinition | undefined>(undefined);
    const [choice, setChoice] = useState(AUTO);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [over, setOver] = useState(false);
    const [createCategories, setCreateCategories] = useState(false);
    const [overwriteCategories, setOverwriteCategories] = useState(false);
    const action = useAction();

    // Only the answer to the latest request counts: an earlier one may arrive after it
    const latest = useRef(0);
    // Without a format the server picks one by the header. A format that does not fit leaves the
    // last preview in place, so another one can be chosen.
    const load = async (f: LoadedFile, requested: { definition: ImportFormatDefinition; key: string } | null, acc: number) => {
        const request = ++latest.current;
        setBusy(true);
        setError("");
        try {
            const content = decodeCsv(f.buffer, requested?.definition.file.encoding ?? "auto");
            const p = await call(routes.importPreview, { params: { id: acc }, body: { fileName: f.name, content, format: requested?.definition } });
            if (request !== latest.current) return;
            setFile({ ...f, content });
            setPreview(p);
            setFormat(p.format);
            setChoice(requested?.key ?? p.formatKey ?? AUTO);
        } catch (err) {
            if (request !== latest.current) return;
            setError(errorText(err));
        } finally {
            if (request === latest.current) setBusy(false);
        }
    };

    const readFile = async (f: File) => {
        if (accountId === undefined) {
            setAccountError("Bitte zuerst das Konto wählen, in das importiert wird.");
            focusFirstError({ "imp-acc": "missing" });
            return;
        }
        if (f.size > 20_000_000) return setError("Die Datei ist größer als 20 MB.");
        const buffer = await f.arrayBuffer();
        const next = { name: f.name, content: decodeCsv(buffer), buffer };
        setFile(next);
        await load(next, null, accountId);
    };

    const commit = async () => {
        if (!file || accountId === undefined) return;
        const r = await action.run(() => call(routes.importCommit, { params: { id: accountId }, body: { fileName: file.name, content: file.content, format, createCategories: create, overwriteCategories: overwrite } }), {
            topics: ["accounts", "transactions", "categories", "imports"],
            ok: (res) =>
                `${plural(res.imported, "Umsatz", "Umsätze")} importiert${res.skipped ? ` · ${res.skipped} übersprungen` : ""}` +
                (res.createdCategories ? ` · ${plural(res.createdCategories, "Kategorie", "Kategorien")} angelegt` : "") +
                (res.recategorized ? ` · ${plural(res.recategorized, "Kategorie", "Kategorien")} geändert` : "") +
                (res.filled ? ` · ${plural(res.filled, "Umsatz", "Umsätze")} ergänzt` : ""),
        });
        if (r) ui.close();
    };

    const decode = useCallback((encoding: ImportFormatDefinition["file"]["encoding"]) => (file ? decodeCsv(file.buffer, encoding) : ""), [file]);
    const fresh = preview?.counts.new ?? 0;
    const filled = preview?.counts.filled ?? 0;
    const rows = preview?.rows ?? [];
    const differing = rows.filter(differs);
    const overwrite = overwriteCategories && differing.length > 0;
    // Missing categories of rows that will be written: new ones, and differing ones when overwritten
    const missing = [...new Set(rows.filter((r) => r.newCategory && (r.state === "new" || (overwrite && differs(r)))).map((r) => r.newCategory!))];
    const create = createCategories && missing.length > 0;
    const changes = overwrite ? differing.filter((r) => r.categoryId !== null || (create && r.newCategory)).length : 0;
    const blocked = overwrite && differing.length > changes;
    const fileCategory = (r: Row): string => (r.categoryId ? categoryPath(index, r.categoryId) : `${r.newCategory} (${create ? "neu" : "fehlt"})`);
    const rowCategory = (r: Row): string => {
        if (differs(r)) return `bisher: ${r.storedCategoryId ? categoryPath(index, r.storedCategoryId) : "ohne Kategorie"} → Datei: ${fileCategory(r)} · `;
        if (r.state === "duplicate") return "";
        if (create && r.newCategory) return `neu: ${r.newCategory} · `;
        return r.categoryId ? `${categoryPath(index, r.categoryId)} · ` : "";
    };
    const rowState = (r: Row): string => {
        if (r.state === "invalid") return "unlesbar";
        if (r.state === "new") return r.pending ? "neu · vorgemerkt" : "neu";
        if (r.categoryState === "split") return fills(r) ? "aufgeteilt, bleibt · Angaben werden ergänzt" : "aufgeteilt, bleibt";
        if (!differs(r)) return fills(r) ? "Angaben werden ergänzt" : "schon vorhanden";
        const category = overwrite && (r.categoryId !== null || (create && r.newCategory)) ? "Kategorie wird geändert" : "Kategorie abweichend";
        return fills(r) ? `${category} · Angaben werden ergänzt` : category;
    };
    const duplicates = preview?.counts.duplicate ?? 0;
    const duplicateChanges = [changes ? `bei ${changes} davon wird die Kategorie geändert` : "", filled ? `bei ${filled} davon werden Angaben ergänzt` : ""].filter(Boolean).join(", ");
    const differingNote = !changes && differing.length ? ` (${differing.length} mit abweichender Kategorie)` : "";
    const duplicateText = duplicates ? ` · ${duplicates} schon vorhanden, ${duplicateChanges || "werden übersprungen"}${differingNote}` : "";
    const actionText = [
        fresh ? `${plural(fresh, "Umsatz", "Umsätze")} importieren` : "",
        changes ? `${plural(changes, "Kategorie", "Kategorien")} ändern` : "",
        filled ? `${plural(filled, "Umsatz", "Umsätze")} ergänzen` : "",
    ]
        .filter(Boolean)
        .join(", ");

    return (
        <Modal title={`Umsätze importieren${account ? ` · ${account.name}` : ""}`} onClose={() => ui.close()} wide={!!preview}>
            {!preview ? (
                <>
                    <Field id="imp-acc" label="In Konto" error={accountError}>
                        <Picker
                            items={accountItems}
                            value={accountId === undefined ? undefined : String(accountId)}
                            onPick={(v) => {
                                setAccountId(Number(v));
                                setAccountError(undefined);
                            }}
                            placeholder="Konto suchen …"
                            trigger={
                                <PickerButton {...fieldProps("imp-acc", accountError)} set={!!account} icon={account && <Tile icon={account.icon} color={account.color} size={12} className="ti-s" />}>
                                    {account ? account.name : "Konto wählen"}
                                </PickerButton>
                            }
                        />
                    </Field>
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
                        <b>CSV-Datei hierher ziehen oder auswählen</b>
                        <small>z. B. CSV-Export aus dem Online-Banking, aus einem anderen Finanzprogramm oder ein Kassenbuch</small>
                    </label>
                    {error && <Hint tone="bad">{error}</Hint>}
                    <p className="hint">
                        <Ic icon={ShieldCheck} size={14} />
                        Die Datei wird nur gelesen, nicht gespeichert. Schon vorhandene Umsätze werden übersprungen.
                    </p>
                </>
            ) : editing && file && format ? (
                <ImportFormatEditor
                    initial={format}
                    choice={choice}
                    formats={formats}
                    decode={decode}
                    onCancel={() => setEditing(false)}
                    onApply={(definition, key) => {
                        setEditing(false);
                        if (accountId !== undefined) void load(file, { definition, key: key ?? ADJUSTED }, accountId);
                    }}
                />
            ) : (
                <>
                    <div className="note">
                        <Ic icon={FileUp} size={16} />
                        <span>
                            <b>{file?.name}</b> · {plural(preview.rows.length, "Zeile", "Zeilen")}
                        </span>
                    </div>
                    <div className="imp-format">
                        <label className="field">
                            <span className="flabel">Format</span>
                            <select
                                className="inp inp-sm"
                                value={choice}
                                onChange={(e) => {
                                    if (!file || accountId === undefined) return;
                                    const picked = formats.find((x) => x.key === e.target.value);
                                    void load(file, picked ? { definition: picked.definition, key: picked.key } : null, accountId);
                                }}
                            >
                                <option value={AUTO}>Automatisch erkennen</option>
                                {choice === ADJUSTED && <option value={ADJUSTED}>Angepasst für diesen Import</option>}
                                <optgroup label="Standardformate">
                                    {formats.filter((x) => x.builtin).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
                                </optgroup>
                                {formats.some((x) => !x.builtin) && (
                                    <optgroup label="Eigene Formate">
                                        {formats.filter((x) => !x.builtin).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
                                    </optgroup>
                                )}
                            </select>
                        </label>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>Format bearbeiten …</button>
                    </div>
                    {format && (
                        <FormatFieldGrid
                            def={format}
                            header={preview.header}
                            onChange={(next) => {
                                if (file && accountId !== undefined) void load(file, { definition: next, key: ADJUSTED }, accountId);
                            }}
                        />
                    )}
                    <div className="imp-prev">
                        {preview.rows.map((r) => (
                            <div key={r.line} className={`imp-row ${differs(r) ? "diff" : r.state === "duplicate" && !fills(r) ? "dup" : r.state === "invalid" ? "bad" : ""}`} title={r.error ?? undefined}>
                                <span>{r.date ? dateText(r.date) : "?"}</span>
                                <span>
                                    {r.name || "—"}
                                    <small>{rowCategory(r)}{[r.bookingText, r.purpose].filter(Boolean).join(" · ")}</small>
                                </span>
                                <span className="amt">{r.amount !== null ? fmtSigned(r.amount) : "?"}</span>
                                <small>{rowState(r)}</small>
                            </div>
                        ))}
                    </div>
                    {missing.length > 0 && (
                        <label className="check-row">
                            <input type="checkbox" checked={createCategories} onChange={(e) => setCreateCategories(e.target.checked)} />
                            <span>
                                {missing.length === 1 ? "Fehlende Kategorie" : `${missing.length} fehlende Kategorien`} anlegen: {missing.slice(0, 3).join(", ")}
                                {missing.length > 3 ? ` und ${missing.length - 3} weitere` : ""}
                            </span>
                        </label>
                    )}
                    {differing.length > 0 && (
                        <label className="check-row">
                            <input type="checkbox" checked={overwriteCategories} onChange={(e) => setOverwriteCategories(e.target.checked)} />
                            <span>Kategorie bei {plural(differing.length, "vorhandenem Umsatz", "vorhandenen Umsätzen")} überschreiben</span>
                        </label>
                    )}
                    {error && <Hint tone="bad">{error}</Hint>}
                    <p className="hint">
                        {fresh} neu
                        {duplicateText}
                        {preview.counts.invalid ? ` · ${preview.counts.invalid} unlesbar` : ""}.{" "}
                        {create ? "Kategorien kommen aus der Datei, fehlende werden angelegt; sonst greifen die Regeln." : "Kategorien kommen aus der Datei oder von den Regeln."}
                        {blocked ? " Fehlende Kategorien vorhandener Umsätze werden nur mit „Fehlende Kategorien anlegen“ übernommen." : ""}
                    </p>
                    <div className="actions">
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => {
                                latest.current++;
                                setBusy(false);
                                setPreview(null);
                                setFile(null);
                                setFormat(undefined);
                                setChoice(AUTO);
                                setCreateCategories(false);
                                setOverwriteCategories(false);
                            }}
                        >
                            Andere Datei
                        </button>
                        <Button className="btn-primary" busy={action.pending} disabled={(!fresh && !changes && !filled) || busy} icon={Check} onClick={() => void commit()}>
                            {actionText || `${plural(0, "Umsatz", "Umsätze")} importieren`}
                        </Button>
                    </div>
                </>
            )}
        </Modal>
    );
}
