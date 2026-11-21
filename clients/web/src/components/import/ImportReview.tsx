import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, SlidersHorizontal } from "lucide-react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { ImportPreview } from "@mbm/shared";
import { dateText, fmtSigned, plural } from "../../lib/format";
import { matchesFilter, reviewCounts, rowDiffers, rowFills, type ReviewFilter } from "../../lib/importFormat";
import { categoryPath, type CategoryIndex } from "../../lib/tree";
import { Button, Hint } from "../common";

type Row = ImportPreview["rows"][number];

const TILES: { filter: Exclude<ReviewFilter, "changes">; label: string; tone: string }[] = [
    { filter: "new", label: "neu", tone: "pos" },
    { filter: "fill", label: "ergänzen", tone: "iris" },
    { filter: "differs", label: "abweichend", tone: "warn" },
    { filter: "duplicate", label: "vorhanden", tone: "" },
    { filter: "invalid", label: "unlesbar", tone: "neg" },
];

const statusText = (r: Row): string => {
    if (r.state === "invalid") return "unlesbar";
    if (r.state === "new") return r.pending ? "neu · vorgemerkt" : "neu";
    const parts = [rowDiffers(r) ? "Kategorie abweichend" : "", rowFills(r) ? "ergänzen" : "", r.categoryState === "split" ? "aufgeteilt, bleibt" : ""].filter(Boolean);
    return parts.join(" · ") || "vorhanden";
};

const statusTone = (r: Row): string => (r.state === "invalid" ? "neg" : r.state === "new" ? "pos" : rowDiffers(r) ? "warn" : rowFills(r) ? "iris" : "");

function RowDetails({ r, index }: { r: Row; index: CategoryIndex }) {
    const items: [string, string][] = [
        ["Verwendungszweck", r.purpose],
        ["Kategorie", r.categoryId ? categoryPath(index, r.categoryId) : r.newCategory ? `${r.newCategory} (fehlt)` : ""],
        ["Bisherige Kategorie", rowDiffers(r) && r.storedCategoryId ? categoryPath(index, r.storedCategoryId) : ""],
        ["IBAN", r.iban ?? ""],
        ["BIC", r.counterpartyBic],
        ["Referenz", r.reference],
        ["Mandat", r.mandateId],
        ["Gläubiger-ID", r.creditorId],
        ["Zeile der Datei", String(r.line)],
    ];
    return (
        <dl className="rv-details">
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
    );
}

function ReviewList({ rows, index }: { rows: Row[]; index: CategoryIndex }) {
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
                // The ref is new on every render, so an opened row is measured right away
                return (
                    <div key={it.key} className="vrow" data-index={it.index} ref={(el) => v.measureElement(el)} style={{ transform: `translateY(${it.start - margin}px)` }}>
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
                        {expanded && <RowDetails r={r} index={index} />}
                    </div>
                );
            })}
        </div>
    );
}

/** The last step of an import: what the file changes, filterable, and the decision to take it. */
export function ImportReview({
    preview,
    index,
    fileName,
    accountName,
    formatName,
    busy,
    error,
    onAdjust,
    onCommit,
}: {
    preview: ImportPreview;
    index: CategoryIndex;
    fileName: string;
    accountName: string;
    formatName: string;
    busy: boolean;
    error: string;
    onAdjust: () => void;
    onCommit: (options: { createCategories: boolean; overwriteCategories: boolean }) => void;
}) {
    const [filter, setFilter] = useState<ReviewFilter>("changes");
    const [createCategories, setCreateCategories] = useState(false);
    const [overwriteCategories, setOverwriteCategories] = useState(false);
    const rows = preview.rows;
    const counts = useMemo(() => reviewCounts(rows), [rows]);
    const shown = useMemo(() => rows.filter((r) => matchesFilter(r, filter)), [rows, filter]);
    const differing = useMemo(() => rows.filter(rowDiffers), [rows]);
    const overwrite = overwriteCategories && differing.length > 0;
    // Missing categories of rows that will be written: new ones, and differing ones when overwritten
    const missing = useMemo(() => [...new Set(rows.filter((r) => r.newCategory && (r.state === "new" || (overwrite && rowDiffers(r)))).map((r) => r.newCategory!))], [rows, overwrite]);
    const create = createCategories && missing.length > 0;
    const changes = overwrite ? differing.filter((r) => r.categoryId !== null || (create && r.newCategory)).length : 0;
    const blocked = overwrite && differing.length > changes;
    const affected = rows.filter((r) => r.state === "new" || rowFills(r) || (overwrite && rowDiffers(r) && (r.categoryId !== null || (create && r.newCategory)))).length;
    const summary = [
        counts.new ? `${counts.new.toLocaleString("de-DE")} neu` : "",
        counts.fill ? `${counts.fill.toLocaleString("de-DE")} ergänzen` : "",
        changes ? `${plural(changes, "Kategorie", "Kategorien")} ändern` : "",
    ].filter(Boolean).join(", ");

    return (
        <div className="rv">
            <div className="rv-head">
                <span>
                    <span><b>{fileName}</b> → {accountName}</span>
                    <small>{formatName} · {plural(rows.length, "Zeile", "Zeilen")}</small>
                </span>
                <Button className="btn-sm btn-ghost" icon={SlidersHorizontal} iconSize={14} onClick={onAdjust}>Anpassen</Button>
            </div>
            <div className="rv-tiles" role="group" aria-label="Zeilen filtern">
                {TILES.map((t) => (
                    <button key={t.filter} type="button" className={`rv-tile ${t.tone}`} aria-pressed={filter === t.filter} disabled={!counts[t.filter]} onClick={() => setFilter(filter === t.filter ? "changes" : t.filter)}>
                        <b>{counts[t.filter].toLocaleString("de-DE")}</b>
                        <span>{t.label}</span>
                    </button>
                ))}
            </div>
            <section className="panel rv-panel" aria-label="Zeilen der Datei">
                <p className="faint small">
                    {filter === "changes" ? "Zeilen, die etwas ändern oder unlesbar sind" : `Nur „${TILES.find((t) => t.filter === filter)!.label}“`} · {shown.length.toLocaleString("de-DE")} von {rows.length.toLocaleString("de-DE")}
                </p>
                {shown.length ? <ReviewList key={filter} rows={shown} index={index} /> : <p className="muted rv-empty">Diese Datei ändert nichts: Alle Umsätze sind schon vorhanden.</p>}
            </section>
            {(missing.length > 0 || differing.length > 0) && (
                <div className="rv-options">
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
                            <span>{plural(differing.length, "abweichende Kategorie", "abweichende Kategorien")} überschreiben</span>
                        </label>
                    )}
                    {blocked && <p className="hint">Fehlende Kategorien vorhandener Umsätze werden nur mit „Fehlende Kategorien anlegen“ übernommen.</p>}
                </div>
            )}
            {error && <Hint tone="bad">{error}</Hint>}
            <div className="imp-bar">
                <span className="muted">{summary || "Nichts zu übernehmen"}</span>
                <Button className="btn-ghost" icon={ArrowLeft} onClick={onAdjust}>Zurück</Button>
                <Button className="btn-primary" icon={Check} busy={busy} disabled={!affected} onClick={() => onCommit({ createCategories: create, overwriteCategories: overwrite })}>
                    {plural(affected, "Umsatz", "Umsätze")} übernehmen
                </Button>
            </div>
        </div>
    );
}
