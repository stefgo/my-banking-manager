import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Search, X } from "lucide-react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { ImportFillField, ImportPreview } from "@mbm/shared";
import { dateText, fmtSigned, plural } from "../../lib/format";
import { categoryChange, matchesFilter, matchesSearch, parseReviewSearch, reviewCounts, reviewOutcome, rowCheck, rowDiffers, rowFills, rowFillsCategory, rowFillsFields, setRowPart, shownSelection, toggleRow, toggleShown, type CategoryChange, type ReviewChoice, type ReviewFilter, type RowPart } from "../../lib/importFormat";
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

/** A readable pending row the server does not take into a bank account. */
const heldBack = (r: Row): boolean => r.state === "invalid" && r.pending && r.date !== null && r.amount !== null;

const statusText = (r: Row): string => {
    if (r.state === "invalid") return heldBack(r) ? "vorgemerkt" : "unlesbar";
    if (r.state === "new") return r.pending ? "neu · vorgemerkt" : "neu";
    const parts = [rowDiffers(r) ? "Kategorie abweichend" : "", rowFills(r) ? "ergänzen" : "", r.categoryState === "split" ? "aufgeteilt, bleibt" : ""].filter(Boolean);
    return parts.join(" · ") || "vorhanden";
};

const statusTone = (r: Row): string => (r.state === "invalid" ? "neg" : r.state === "new" ? "pos" : rowDiffers(r) ? "warn" : rowFills(r) ? "iris" : "");

const CHANGE_TEXT: Record<CategoryChange, string> = {
    replaced: "Wird beim Import ersetzt. Das lässt sich nicht rückgängig machen.",
    filled: "Wird beim Import ergänzt.",
    "not-chosen": "Bleibt unverändert, solange du das Ersetzen nicht wählst.",
    "left-out": "Bleibt leer, weil die Zeile abgewählt ist.",
    "needs-category": "Bleibt unverändert, bis du oben „Fehlende Kategorien anlegen“ wählst.",
};

const fileCategory = (r: Row, index: CategoryIndex): string => (r.categoryId ? categoryPath(index, r.categoryId) : r.newCategory ? `${r.newCategory} (fehlt)` : "");

const FILL_LABEL: Record<ImportFillField, string> = {
    bookingText: "Umsatzart",
    reference: "Referenz",
    customerReference: "Kundenreferenz",
    bankReference: "Bankreferenz",
    mandateId: "Mandat",
    creditorId: "Gläubiger-ID",
    counterpartyBic: "BIC",
    counterpartyAccount: "Kontonummer",
    counterpartyBankCode: "BLZ",
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
function StoredChanges({ r, index, choice, onPart }: { r: Row; index: CategoryIndex; choice: ReviewChoice; onPart: (r: Row, part: RowPart, on: boolean) => void }) {
    const change = categoryChange(r, choice);
    const leftOut = choice.excluded.has(r.line);
    const one = r.fills.length === 1;
    const fillNote = leftOut ? `${one ? "Diese Angabe bleibt" : "Diese Angaben bleiben"} leer, weil sie abgewählt ${one ? "ist" : "sind"}.` : `${one ? "Diese Angabe wird" : "Diese Angaben werden"} beim Import ergänzt.`;
    const hasCategory = rowDiffers(r) || rowFillsCategory(r);
    // Only a row with both decisions needs its own switches; otherwise the row's checkbox says it all
    const both = rowDiffers(r) && rowFillsFields(r);
    return (
        <section className="rv-compare" aria-label="Änderungen durch den Import">
            <div className="rv-change head" aria-hidden="true">
                <span />
                <span>Aktuell in MBM</span>
                <span />
                <span>Aus der Datei</span>
            </div>
            {hasCategory && (
                <ChangeLine
                    label="Kategorie"
                    before={r.storedCategoryId ? categoryPath(index, r.storedCategoryId) : null}
                    after={fileCategory(r, index)}
                    tone={rowDiffers(r) ? "replace" : "fill"}
                    on={change === "replaced" || change === "filled"}
                    note={CHANGE_TEXT[change]}
                />
            )}
            {both && (
                <label className="check-row rv-part">
                    <input type="checkbox" checked={choice.replaced.has(r.line)} onChange={(e) => onPart(r, "category", e.target.checked)} />
                    <span>Kategorie ersetzen</span>
                </label>
            )}
            {r.fills.map((f) => <ChangeLine key={f} label={FILL_LABEL[f]} before={null} after={r[f]} tone="fill" on={!leftOut} />)}
            {r.fills.length > 0 && <p className={leftOut ? "" : "on"}>{fillNote}</p>}
            {both && (
                <label className="check-row rv-part">
                    <input type="checkbox" checked={!leftOut} onChange={(e) => onPart(r, "take", e.target.checked)} />
                    <span>{one ? "Angabe ergänzen" : "Angaben ergänzen"}</span>
                </label>
            )}
        </section>
    );
}

function RowDetails({ r, index, choice, onPart }: { r: Row; index: CategoryIndex; choice: ReviewChoice; onPart: (r: Row, part: RowPart, on: boolean) => void }) {
    // A field that the import fills in already stands in the comparison
    const detail = (f: ImportFillField): string => (r.fills.includes(f) ? "" : r[f]);
    const items: [string, string][] = [
        ["Verwendungszweck", r.purpose],
        ["Kategorie", rowDiffers(r) || rowFillsCategory(r) ? "" : fileCategory(r, index)],
        ["IBAN", r.iban ?? ""],
        [FILL_LABEL.counterpartyAccount, detail("counterpartyAccount")],
        [FILL_LABEL.counterpartyBankCode, detail("counterpartyBankCode")],
        [FILL_LABEL.counterpartyBic, detail("counterpartyBic")],
        [FILL_LABEL.reference, detail("reference")],
        [FILL_LABEL.customerReference, detail("customerReference")],
        [FILL_LABEL.bankReference, detail("bankReference")],
        [FILL_LABEL.mandateId, detail("mandateId")],
        [FILL_LABEL.creditorId, detail("creditorId")],
        ["Zeile der Datei", String(r.line)],
    ];
    return (
        <div className="rv-details">
            {(rowDiffers(r) || rowFills(r)) && <StoredChanges r={r} index={index} choice={choice} onPart={onPart} />}
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

function ReviewList({ rows, index, choice, onToggle, onPart }: { rows: Row[]; index: CategoryIndex; choice: ReviewChoice; onToggle: (r: Row) => void; onPart: (r: Row, part: RowPart, on: boolean) => void }) {
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
                const check = rowCheck(r, choice);
                // The ref is new on every render, so an opened row is measured right away
                return (
                    <div key={it.key} className="vrow" data-index={it.index} ref={(el) => v.measureElement(el)} style={{ transform: `translateY(${it.start - margin}px)` }}>
                        {/* A conflict starts unchosen and still needs a look, so only a row left out is dimmed */}
                        <div className={`rv-line ${check === "off" && choice.excluded.has(r.line) ? "off" : ""}`}>
                            <input
                                type="checkbox"
                                className="rv-check"
                                aria-label={`Zeile ${r.line} übernehmen`}
                                disabled={check === "none"}
                                checked={check === "on"}
                                ref={(el) => {
                                    if (el) el.indeterminate = check === "partial";
                                }}
                                onChange={() => onToggle(r)}
                            />
                            <button type="button" className="rv-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.line)}>
                                <span>{r.date ? dateText(r.date) : "?"}</span>
                                <span className="rv-main">
                                    <b>{r.shownName ?? (r.name || "—")}</b>
                                    <small>{r.shownPurpose ?? r.purpose}</small>
                                </span>
                                <span className="rv-kind">{r.bookingText}</span>
                                <span className="amt">{r.amount !== null ? fmtSigned(r.amount) : "?"}</span>
                                <span className={`rv-state ${statusTone(r)}`}>{statusText(r)}</span>
                            </button>
                        </div>
                        {expanded && <RowDetails r={r} index={index} choice={choice} onPart={onPart} />}
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
    onCommit: (options: { createCategories: boolean; replaceCategoryLines: number[] }) => void;
}) {
    const rows = preview.rows;
    const counts = useMemo(() => reviewCounts(rows), [rows]);
    // A file with nothing but conflicts opens where they can be decided
    const [filter, setFilter] = useState<ReviewFilter>(() => (!counts.changes && counts.differs ? "differs" : "changes"));
    const [search, setSearch] = useState("");
    const needle = useDeferredValue(search);
    const query = useMemo(() => parseReviewSearch(needle), [needle]);
    const shown = useMemo(() => rows.filter((r) => matchesFilter(r, filter) && matchesSearch(r, query)), [rows, filter, query]);
    const outcome = useMemo(() => reviewOutcome(rows, choice), [rows, choice]);
    const selection = useMemo(() => shownSelection(shown, filter, choice), [shown, filter, choice]);
    const { missing, create, changes, blocked, affected } = outcome;
    const summary = [
        outcome.fresh ? `${outcome.fresh.toLocaleString("de-DE")} neu` : "",
        outcome.fills ? `${outcome.fills.toLocaleString("de-DE")} ergänzen` : "",
        outcome.leftOut ? `${outcome.leftOut.toLocaleString("de-DE")} abgewählt` : "",
    ].filter(Boolean).join(", ");
    const replaces = changes ? `${plural(changes, "Kategorie", "Kategorien")} ersetzen (nicht rückgängig)` : "";
    const nothing = counts.differs ? "Hier gibt es nichts zu übernehmen. Abweichende Kategorien stehen unter „Abweichend“." : "Diese Datei ändert nichts: Alle Umsätze sind schon vorhanden.";
    const empty = needle.trim() ? "Keine Zeile passt zur Suche." : filter === "changes" ? nothing : "Keine Zeilen.";
    const setPart = (r: Row, part: RowPart, on: boolean) => onChoice(setRowPart([r], part, on, choice));

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
                        placeholder="Gegenseite, Verwendungszweck, IBAN, Referenz oder datum>=1.3.2026"
                        aria-label="Zeilen durchsuchen"
                        aria-invalid={!!query.error}
                        aria-describedby={query.error ? "rv-q-error" : undefined}
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
                {query.error && (
                    <p id="rv-q-error" className="hint bad" role="status">
                        {query.error} – diese Angabe bleibt bei der Suche außen vor.
                    </p>
                )}
                <div className="seg rv-filter" role="group" aria-label="Zeilen filtern">
                    {FILTERS.map((f) => (
                        <button key={f.filter} type="button" className={f.tone} aria-pressed={filter === f.filter} disabled={!counts[f.filter] && f.filter !== "changes" && f.filter !== "all"} onClick={() => setFilter(f.filter)}>
                            {f.filter === "invalid" && rows.some(heldBack) ? "Nicht übernehmbar" : f.label} <b>{counts[f.filter].toLocaleString("de-DE")}</b>
                        </button>
                    ))}
                </div>
            </div>
            {preview.newCategories.length > 0 && (
                <div className="rv-options">
                    <label className="check-row">
                        <input type="checkbox" disabled={!missing.length} checked={create} onChange={(e) => onChoice({ ...choice, createCategories: e.target.checked })} />
                        {missing.length ? (
                            <span>
                                {missing.length === 1 ? "Fehlende Kategorie" : `${missing.length} fehlende Kategorien`} anlegen: {missing.slice(0, 3).join(", ")}
                                {missing.length > 3 ? ` und ${missing.length - 3} weitere` : ""}
                            </span>
                        ) : (
                            <span>Fehlende Kategorien anlegen (für die gewählten Zeilen nicht nötig)</span>
                        )}
                    </label>
                    {blocked && <p className="hint">Kategorien, die noch fehlen, werden nur mit „Fehlende Kategorien anlegen“ übernommen.</p>}
                </div>
            )}
            <section className="panel rv-panel" aria-label="Zeilen der Datei">
                <div className="rv-list-head">
                    <label className="check-row">
                        <input
                            type="checkbox"
                            disabled={!selection.targets}
                            checked={selection.all}
                            ref={(el) => {
                                if (el) el.indeterminate = selection.some;
                            }}
                            onChange={() => onChoice(toggleShown(shown, filter, choice))}
                        />
                        <span>{filter === "differs" ? "Alle angezeigten ersetzen" : "Alle angezeigten"}</span>
                    </label>
                    <span className="faint small">{shown.length.toLocaleString("de-DE")} von {rows.length.toLocaleString("de-DE")} Zeilen · {selection.chosen.toLocaleString("de-DE")} gewählt</span>
                </div>
                {shown.length ? <ReviewList key={filter} rows={shown} index={index} choice={choice} onToggle={(r) => onChoice(toggleRow(r, choice))} onPart={setPart} /> : <p className="muted rv-empty">{empty}</p>}
            </section>
            {error && <Hint tone="bad">{error}</Hint>}
            <div className="imp-bar">
                <span className="muted rv-summary">
                    {summary}
                    {summary && replaces ? ", " : ""}
                    {replaces && <b>{replaces}</b>}
                    {!summary && !replaces && "Nichts zu übernehmen"}
                </span>
                <Button className="btn-ghost" icon={ArrowLeft} onClick={onBack}>Zurück</Button>
                <Button className="btn-primary" icon={Check} busy={busy} disabled={!affected} onClick={() => onCommit({ createCategories: create, replaceCategoryLines: [...choice.replaced] })}>
                    {plural(affected, "Umsatz", "Umsätze")} übernehmen
                </Button>
            </div>
        </div>
    );
}
