import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Search, X } from "lucide-react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { ImportFillField, ImportPreview } from "@mbm/shared";
import { dateText, fmtSigned, plural } from "../../lib/format";
import { categoryChange, matchesFilter, matchesSearch, reviewCounts, reviewOutcome, rowDiffers, rowFills, rowSelectable, type CategoryChange, type ReviewChoice, type ReviewFilter } from "../../lib/importFormat";
import { categoryPath, type CategoryIndex } from "../../lib/tree";
import { Button, Hint } from "../common";
import { Ic } from "../icons";

type Row = ImportPreview["rows"][number];

const FILTERS: { filter: ReviewFilter; label: string; tone: string }[] = [
    { filter: "changes", label: "Änderungen", tone: "" },
    { filter: "new", label: "Neu", tone: "pos" },
    { filter: "fill", label: "Ergänzen", tone: "iris" },
    { filter: "differs", label: "Abweichend", tone: "warn" },
    { filter: "duplicate", label: "Vorhanden", tone: "" },
    { filter: "invalid", label: "Unlesbar", tone: "neg" },
    { filter: "all", label: "Alle", tone: "" },
];

const statusText = (r: Row): string => {
    if (r.state === "invalid") return "unlesbar";
    if (r.state === "new") return r.pending ? "neu · vorgemerkt" : "neu";
    const parts = [rowDiffers(r) ? "Kategorie abweichend" : "", rowFills(r) ? "ergänzen" : "", r.categoryState === "split" ? "aufgeteilt, bleibt" : ""].filter(Boolean);
    return parts.join(" · ") || "vorhanden";
};

const statusTone = (r: Row): string => (r.state === "invalid" ? "neg" : r.state === "new" ? "pos" : rowDiffers(r) ? "warn" : rowFills(r) ? "iris" : "");

const CHANGE_TEXT: Record<CategoryChange, string> = {
    replaced: "Wird beim Import ersetzt.",
    "no-overwrite": "Bleibt unverändert. Zum Ersetzen unten „abweichende Kategorien überschreiben“ wählen.",
    "left-out": "Bleibt unverändert, weil die Zeile abgewählt ist.",
    "needs-category": "Bleibt unverändert, bis du unten „Fehlende Kategorien anlegen“ wählst.",
};

const fileCategory = (r: Row, index: CategoryIndex): string => (r.categoryId ? categoryPath(index, r.categoryId) : r.newCategory ? `${r.newCategory} (fehlt)` : "");

const FILL_LABEL: Record<ImportFillField, string> = {
    bookingText: "Umsatzart",
    reference: "Referenz",
    mandateId: "Mandat",
    creditorId: "Gläubiger-ID",
    counterpartyBic: "BIC",
};

/** One value before and after the import. */
function ChangeLine({ label, before, after, tone, on, note }: { label: string; before: string | null; after: string; tone: "replace" | "fill"; on: boolean; note?: string }) {
    return (
        <div className={`rv-change ${tone} ${on ? "on" : ""}`}>
            <b>{label}</b>
            <div className={`rv-side old ${before === null ? "rv-blank" : ""}`} data-label="Aktuell in MBM"><span>{before ?? "Leer"}</span></div>
            <Ic icon={ArrowRight} size={15} />
            <div className="rv-side new" data-label="Aus der Datei"><span>{after}</span></div>
            {note && <p>{note}</p>}
        </div>
    );
}

/** What the import changes in a booking already stored: its category and the empty fields it fills. */
function StoredChanges({ r, index, choice }: { r: Row; index: CategoryIndex; choice: ReviewChoice }) {
    const change = categoryChange(r, choice);
    const leftOut = choice.excluded.has(r.line);
    const one = r.fills.length === 1;
    const fillNote = leftOut ? `${one ? "Diese Angabe bleibt" : "Diese Angaben bleiben"} leer, weil die Zeile abgewählt ist.` : `${one ? "Diese Angabe wird" : "Diese Angaben werden"} beim Import ergänzt.`;
    return (
        <section className="rv-compare" aria-label="Änderungen durch den Import">
            <div className="rv-change head" aria-hidden="true">
                <span />
                <span>Aktuell in MBM</span>
                <span />
                <span>Aus der Datei</span>
            </div>
            {rowDiffers(r) && (
                <ChangeLine
                    label="Kategorie"
                    before={r.storedCategoryId ? categoryPath(index, r.storedCategoryId) : null}
                    after={fileCategory(r, index)}
                    tone="replace"
                    on={change === "replaced"}
                    note={CHANGE_TEXT[change]}
                />
            )}
            {r.fills.map((f) => <ChangeLine key={f} label={FILL_LABEL[f]} before={null} after={r[f]} tone="fill" on={!leftOut} />)}
            {r.fills.length > 0 && <p className={leftOut ? "" : "on"}>{fillNote}</p>}
        </section>
    );
}

function RowDetails({ r, index, choice }: { r: Row; index: CategoryIndex; choice: ReviewChoice }) {
    // A field that the import fills in already stands in the comparison
    const detail = (f: ImportFillField): string => (r.fills.includes(f) ? "" : r[f]);
    const items: [string, string][] = [
        ["Verwendungszweck", r.purpose],
        ["Kategorie", rowDiffers(r) ? "" : fileCategory(r, index)],
        ["IBAN", r.iban ?? ""],
        [FILL_LABEL.counterpartyBic, detail("counterpartyBic")],
        [FILL_LABEL.reference, detail("reference")],
        [FILL_LABEL.mandateId, detail("mandateId")],
        [FILL_LABEL.creditorId, detail("creditorId")],
        ["Zeile der Datei", String(r.line)],
    ];
    return (
        <div className="rv-details">
            {(rowDiffers(r) || r.fills.length > 0) && <StoredChanges r={r} index={index} choice={choice} />}
            <dl className="rv-fields">
                {r.error && (
                    <div className="bad">
                        <dt>Grund</dt>
                        <dd>{r.error}</dd>
                    </div>
                )}
                {items.filter(([, v]) => v).map(([k, v]) => (
                    <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

function ReviewList({ rows, index, choice, onToggle }: { rows: Row[]; index: CategoryIndex; choice: ReviewChoice; onToggle: (line: number) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const [margin, setMargin] = useState(0);
    const [open, setOpen] = useState<number | null>(null);
    useLayoutEffect(() => {
        setMargin(ref.current ? ref.current.getBoundingClientRect().top + window.scrollY : 0);
    }, []);
    const v = useWindowVirtualizer({ count: rows.length, estimateSize: () => 54, overscan: 12, scrollMargin: margin, getItemKey: (i) => rows[i]!.line });
    return (
        <div ref={ref} className="vlist rv-list" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((it) => {
                const r = rows[it.index]!;
                const expanded = open === r.line;
                const selectable = rowSelectable(r, choice.overwriteCategories);
                const selected = selectable && !choice.excluded.has(r.line);
                // The ref is new on every render, so an opened row is measured right away
                return (
                    <div key={it.key} className="vrow" data-index={it.index} ref={(el) => v.measureElement(el)} style={{ transform: `translateY(${it.start - margin}px)` }}>
                        <div className={`rv-line ${selectable && !selected ? "off" : ""}`}>
                            <input type="checkbox" className="rv-check" aria-label={`Zeile ${r.line} übernehmen`} disabled={!selectable} checked={selected} onChange={() => onToggle(r.line)} />
                            <button type="button" className="rv-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.line)}>
                                <span>{r.date ? dateText(r.date) : "?"}</span>
                                <span className="rv-main">
                                    <b>{r.name || "—"}</b>
                                    <small>{r.purpose}</small>
                                </span>
                                <span className="rv-kind">{r.bookingText}</span>
                                <span className="amt">{r.amount !== null ? fmtSigned(r.amount) : "?"}</span>
                                <span className={`rv-state ${statusTone(r)}`}>{statusText(r)}</span>
                            </button>
                        </div>
                        {expanded && <RowDetails r={r} index={index} choice={choice} />}
                    </div>
                );
            })}
        </div>
    );
}

/** The last step of an import: what the file changes, with filter, search and a choice of rows. */
export function ImportReview({
    preview,
    index,
    fileName,
    accountName,
    formatName,
    busy,
    error,
    choice,
    onChoice,
    onBack,
    onCommit,
}: {
    preview: ImportPreview;
    index: CategoryIndex;
    fileName: string;
    accountName: string;
    formatName: string;
    busy: boolean;
    error: string;
    choice: ReviewChoice;
    onChoice: (next: ReviewChoice) => void;
    onBack: () => void;
    onCommit: (options: { createCategories: boolean; overwriteCategories: boolean }) => void;
}) {
    const [filter, setFilter] = useState<ReviewFilter>("changes");
    const [search, setSearch] = useState("");
    const needle = useDeferredValue(search);
    const rows = preview.rows;
    const counts = useMemo(() => reviewCounts(rows), [rows]);
    const shown = useMemo(() => rows.filter((r) => matchesFilter(r, filter) && matchesSearch(r, needle)), [rows, filter, needle]);
    const outcome = useMemo(() => reviewOutcome(rows, choice), [rows, choice]);
    const selectable = useMemo(() => shown.filter((r) => rowSelectable(r, choice.overwriteCategories)), [shown, choice.overwriteCategories]);
    const selected = selectable.filter((r) => !choice.excluded.has(r.line)).length;
    const allSelected = selectable.length > 0 && selected === selectable.length;
    const { missing, create, overwrite, changes, blocked, affected } = outcome;
    const summary = [
        outcome.fresh ? `${outcome.fresh.toLocaleString("de-DE")} neu` : "",
        outcome.fills ? `${outcome.fills.toLocaleString("de-DE")} ergänzen` : "",
        changes ? `${plural(changes, "Kategorie", "Kategorien")} ändern` : "",
        outcome.leftOut ? `${outcome.leftOut.toLocaleString("de-DE")} abgewählt` : "",
    ].filter(Boolean).join(", ");
    const empty = needle.trim() ? "Keine Zeile passt zur Suche." : filter === "changes" ? "Diese Datei ändert nichts: Alle Umsätze sind schon vorhanden." : "Keine Zeilen.";

    const toggle = (line: number) => {
        const excluded = new Set(choice.excluded);
        if (!excluded.delete(line)) excluded.add(line);
        onChoice({ ...choice, excluded });
    };
    const toggleShown = () => {
        const excluded = new Set(choice.excluded);
        for (const r of selectable) {
            if (allSelected) excluded.add(r.line);
            else excluded.delete(r.line);
        }
        onChoice({ ...choice, excluded });
    };

    return (
        <div className="rv">
            <div className="rv-head">
                <span>
                    <span><b>{fileName}</b> → {accountName}</span>
                    <small>{formatName} · {plural(rows.length, "Zeile", "Zeilen")}</small>
                </span>
            </div>
            <div className="rv-tools">
                <label className="search">
                    <Ic icon={Search} />
                    <input
                        type="search"
                        placeholder="Gegenseite, Verwendungszweck, IBAN oder Referenz"
                        aria-label="Zeilen durchsuchen"
                        autoComplete="off"
                        spellCheck={false}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape" && search) setSearch("");
                        }}
                    />
                    {search && (
                        <button type="button" className="search-clear" aria-label="Suche leeren" title="Suche leeren (Esc)" onClick={() => setSearch("")}>
                            <Ic icon={X} size={15} strokeWidth={2.2} />
                        </button>
                    )}
                </label>
                <div className="seg rv-filter" role="group" aria-label="Zeilen filtern">
                    {FILTERS.map((f) => (
                        <button key={f.filter} type="button" className={f.tone} aria-pressed={filter === f.filter} disabled={!counts[f.filter] && f.filter !== "changes" && f.filter !== "all"} onClick={() => setFilter(f.filter)}>
                            {f.label} <b>{counts[f.filter].toLocaleString("de-DE")}</b>
                        </button>
                    ))}
                </div>
            </div>
            <section className="panel rv-panel" aria-label="Zeilen der Datei">
                <div className="rv-list-head">
                    <label className="check-row">
                        <input
                            type="checkbox"
                            disabled={!selectable.length}
                            checked={allSelected}
                            ref={(el) => {
                                if (el) el.indeterminate = selected > 0 && !allSelected;
                            }}
                            onChange={toggleShown}
                        />
                        <span>Alle angezeigten</span>
                    </label>
                    <span className="faint small">{shown.length.toLocaleString("de-DE")} von {rows.length.toLocaleString("de-DE")} Zeilen · {selected.toLocaleString("de-DE")} gewählt</span>
                </div>
                {shown.length ? <ReviewList key={filter} rows={shown} index={index} choice={choice} onToggle={toggle} /> : <p className="muted rv-empty">{empty}</p>}
            </section>
            {(missing.length > 0 || counts.differs > 0) && (
                <div className="rv-options">
                    {missing.length > 0 && (
                        <label className="check-row">
                            <input type="checkbox" checked={choice.createCategories} onChange={(e) => onChoice({ ...choice, createCategories: e.target.checked })} />
                            <span>
                                {missing.length === 1 ? "Fehlende Kategorie" : `${missing.length} fehlende Kategorien`} anlegen: {missing.slice(0, 3).join(", ")}
                                {missing.length > 3 ? ` und ${missing.length - 3} weitere` : ""}
                            </span>
                        </label>
                    )}
                    {counts.differs > 0 && (
                        <label className="check-row">
                            <input type="checkbox" checked={choice.overwriteCategories} onChange={(e) => onChoice({ ...choice, overwriteCategories: e.target.checked })} />
                            <span>
                                {outcome.differing === counts.differs
                                    ? plural(counts.differs, "abweichende Kategorie", "abweichende Kategorien")
                                    : `${outcome.differing.toLocaleString("de-DE")} von ${plural(counts.differs, "abweichenden Kategorie", "abweichenden Kategorien")}`} überschreiben
                            </span>
                        </label>
                    )}
                    {blocked && <p className="hint">Fehlende Kategorien vorhandener Umsätze werden nur mit „Fehlende Kategorien anlegen“ übernommen.</p>}
                </div>
            )}
            {error && <Hint tone="bad">{error}</Hint>}
            <div className="imp-bar">
                <span className="muted">{summary || "Nichts zu übernehmen"}</span>
                <Button className="btn-ghost" icon={ArrowLeft} onClick={onBack}>Zurück</Button>
                <Button className="btn-primary" icon={Check} busy={busy} disabled={!affected} onClick={() => onCommit({ createCategories: create, overwriteCategories: overwrite })}>
                    {plural(affected, "Umsatz", "Umsätze")} übernehmen
                </Button>
            </div>
        </div>
    );
}
