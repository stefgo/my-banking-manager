import { useMemo, useRef, useState } from "react";
import { Check, FileUp, ShieldCheck } from "lucide-react";
import { IMPORT_FIELD_LABELS, IMPORT_FIELDS, routes, type ColumnMap, type ImportPreview } from "@mbm/shared";
import { call, errorText } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex } from "../lib/queries";
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

type Row = ImportPreview["rows"][number];

/** A stored booking whose file names another category. */
const differs = (r: Row): boolean => r.categoryState === "differs";

/** Imports a CSV file; without `accountId` the account is chosen first. */
export function ImportDialog({ accountId: initial }: { accountId?: number }) {
    const accountsData = useAccounts().data;
    const accounts = accountsData ?? [];
    const accountItems = useMemo(() => accountPickItems(accountsData ?? []), [accountsData]);
    const [accountId, setAccountId] = useState<number | undefined>(initial);
    const [accountError, setAccountError] = useState<string | undefined>();
    const account = accounts.find((a) => a.id === accountId);
    const { index } = useCategoryIndex();
    const [file, setFile] = useState<{ name: string; content: string } | null>(null);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [columns, setColumns] = useState<ColumnMap | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [over, setOver] = useState(false);
    const [createCategories, setCreateCategories] = useState(false);
    const [overwriteCategories, setOverwriteCategories] = useState(false);
    const action = useAction();

    // Only the answer to the latest request counts: an earlier one may arrive after it
    const latest = useRef(0);
    const load = async (f: { name: string; content: string }, cols: ColumnMap | undefined, acc: number) => {
        const request = ++latest.current;
        setBusy(true);
        setError("");
        try {
            const p = await call(routes.importPreview, { params: { id: acc }, body: { fileName: f.name, content: f.content, columns: cols } });
            if (request !== latest.current) return;
            setPreview(p);
            setColumns(p.columns);
        } catch (err) {
            if (request !== latest.current) return;
            setError(errorText(err));
            setPreview(null);
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
        const content = decodeCsv(await f.arrayBuffer());
        const next = { name: f.name, content };
        setFile(next);
        await load(next, undefined, accountId);
    };

    const commit = async () => {
        if (!file || accountId === undefined) return;
        const r = await action.run(() => call(routes.importCommit, { params: { id: accountId }, body: { fileName: file.name, content: file.content, columns, createCategories: create, overwriteCategories: overwrite } }), {
            topics: ["accounts", "transactions", "categories", "imports"],
            ok: (res) =>
                `${plural(res.imported, "Umsatz", "Umsätze")} importiert${res.skipped ? ` · ${res.skipped} übersprungen` : ""}` +
                (res.createdCategories ? ` · ${plural(res.createdCategories, "Kategorie", "Kategorien")} angelegt` : "") +
                (res.recategorized ? ` · ${plural(res.recategorized, "Kategorie", "Kategorien")} geändert` : ""),
        });
        if (r) ui.close();
    };

    const fresh = preview?.counts.new ?? 0;
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
        if (r.categoryState === "split") return "aufgeteilt, bleibt";
        if (!differs(r)) return "schon vorhanden";
        return overwrite && (r.categoryId !== null || (create && r.newCategory)) ? "Kategorie wird geändert" : "Kategorie abweichend";
    };
    const duplicates = preview?.counts.duplicate ?? 0;
    const duplicateText = !duplicates
        ? ""
        : changes
          ? ` · ${duplicates} schon vorhanden, bei ${changes} davon wird die Kategorie geändert`
          : ` · ${duplicates} schon vorhanden, werden übersprungen${differing.length ? ` (${differing.length} mit abweichender Kategorie)` : ""}`;
    const actionText = [fresh ? `${plural(fresh, "Umsatz", "Umsätze")} importieren` : "", changes ? `${plural(changes, "Kategorie", "Kategorien")} ändern` : ""].filter(Boolean).join(", ");

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
            ) : (
                <>
                    <div className="note">
                        <Ic icon={FileUp} size={16} />
                        <span>
                            <b>{file?.name}</b> · {plural(preview.rows.length, "Zeile", "Zeilen")}
                        </span>
                    </div>
                    <div className="imp-map">
                        {IMPORT_FIELDS.map((f) => (
                            <label className="field" key={f}>
                                <span className="flabel">{IMPORT_FIELD_LABELS[f]}</span>
                                <select
                                    className="inp inp-sm"
                                    value={columns?.[f] ?? -1}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        const next = { ...columns!, [f]: v < 0 ? null : v };
                                        setColumns(next);
                                        if (file && accountId !== undefined) void load(file, next, accountId);
                                    }}
                                >
                                    <option value={-1}>— nicht zuordnen —</option>
                                    {preview.header.map((h, i) => <option key={i} value={i}>{h || `Spalte ${i + 1}`}</option>)}
                                </select>
                            </label>
                        ))}
                    </div>
                    <div className="imp-prev">
                        {preview.rows.map((r) => (
                            <div key={r.line} className={`imp-row ${differs(r) ? "diff" : r.state === "duplicate" ? "dup" : r.state === "invalid" ? "bad" : ""}`} title={r.error ?? undefined}>
                                <span>{r.date ? dateText(r.date) : "?"}</span>
                                <span>
                                    {r.name || "—"}
                                    <small>{rowCategory(r)}{r.purpose}</small>
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
                                setColumns(undefined);
                                setCreateCategories(false);
                                setOverwriteCategories(false);
                            }}
                        >
                            Andere Datei
                        </button>
                        <Button className="btn-primary" busy={action.pending} disabled={(!fresh && !changes) || busy} icon={Check} onClick={() => void commit()}>
                            {actionText || `${plural(0, "Umsatz", "Umsätze")} importieren`}
                        </Button>
                    </div>
                </>
            )}
        </Modal>
    );
}
