import { Fragment, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Search, Wand2, X } from "lucide-react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { routes, type Rule, type RuleChangeField, type RuleChangeKind, type RuleFieldChange, type RulePreview, type RuleRunItem, type RuleRunMode } from "@mbm/shared";
import { ApiFailure, call, errorText } from "../lib/api";
import { dateText, fmtSigned, plural } from "../lib/format";
import { useAction, useAccounts, useCategoryIndex, useRules } from "../lib/queries";
import { carryChoice, deviationsOf, isChosen, itemKind, rowCheck, runCounts, runOutcome, setChosen, shownState, toggleRow, toggleShown, type RunChoice, type RunFilter } from "../lib/ruleRun";
import { categoryPath, type CategoryIndex } from "../lib/tree";
import { Button, Hint } from "../components/common";
import { Ic } from "../components/icons";
import { StepList } from "../components/import/StepList";
import { RuleSummary } from "../components/RuleSummary";
import { runRulesRoute } from "../router";

const STEPS = ["Auswahl", "Änderungen prüfen"] as const;
const NO_CHOICE: RunChoice = new Map();
const MODE_TEXT: Record<RuleRunMode, string> = { empty: "Nur leere Felder füllen", all: "Alles neu berechnen" };

/** What the chosen scope reaches among the stored bookings. */
function scopeText(rule: Rule | undefined, activeCount: number): string {
    if (!rule) {
        if (activeCount === 0) return "Es ist keine Regel aktiv.";
        if (activeCount === 1) return "Die einzige aktive Regel läuft über alle Umsätze.";
        return `${activeCount.toLocaleString("de-DE")} aktive Regeln laufen in ihrer Reihenfolge. Je Umsatz wirkt die erste passende.`;
    }
    if (rule.hits === 0) return "Passt aktuell auf keinen Umsatz.";
    const taken = rule.hits - rule.wins;
    const hits = `Passt auf ${plural(rule.hits, "Umsatz", "Umsätze")}.`;
    if (taken === 0) return hits;
    return `${hits} ${taken.toLocaleString("de-DE")} davon erfasst eine Regel weiter oben. ${taken === 1 ? "Er bleibt" : "Diese bleiben"} hier unverändert.`;
}

const FILTERS: { filter: RunFilter; label: string; tone: string }[] = [
    { filter: "all", label: "Änderungen", tone: "" },
    { filter: "fill", label: "Ergänzen", tone: "pos" },
    { filter: "change", label: "Ändern", tone: "iris" },
    { filter: "replace", label: "Ersetzen", tone: "warn" },
    { filter: "reset", label: "Zurücksetzen", tone: "" },
];

const KIND_TEXT: Record<RuleChangeKind, string> = { fill: "ergänzen", change: "ändern", replace: "ersetzen", reset: "zurücksetzen" };
const FIELD_TEXT: Record<RuleChangeField, string> = { counterparty: "Gegenseite", remittance: "Verwendungszweck", category: "Kategorie" };
const KIND_TONE: Record<RuleChangeKind, string> = { fill: "pos", change: "iris", replace: "warn", reset: "" };

function changeValue(c: RuleFieldChange, side: "before" | "after", index: CategoryIndex): string | null {
    const v = c[side];
    if (v === null) return null;
    return c.field === "category" ? categoryPath(index, Number(v)) : v;
}

function RunDetails({ item, index, choice, onChoice }: { item: RuleRunItem; index: CategoryIndex; choice: RunChoice; onChoice: (next: RunChoice) => void }) {
    return (
        <div className="rv-details">
            <section className="rv-compare" aria-label="Änderungen durch die Regeln">
                <div className="rv-change head" aria-hidden="true">
                    <span />
                    <span>Aktuell in MBM</span>
                    <span />
                    <span>Nach den Regeln</span>
                </div>
                {item.changes.map((c) => {
                    const on = isChosen(item, c, choice);
                    const before = changeValue(c, "before", index);
                    return (
                        <Fragment key={c.field}>
                            <div className={`rv-change ${c.kind === "replace" ? "replace" : "fill"} ${on ? "on" : ""}`}>
                                <b>{FIELD_TEXT[c.field]}</b>
                                <div className={`rv-side old ${before === null ? "rv-blank" : ""}`} data-label="Aktuell in MBM"><span>{before ?? "Leer"}</span></div>
                                <Ic icon={ArrowRight} size={15} />
                                <div className="rv-side new" data-label="Nach den Regeln"><span>{changeValue(c, "after", index)}</span></div>
                                {c.kind === "replace" && <p>Wird nur ersetzt, wenn du dieses Feld wählst. Das lässt sich nicht rückgängig machen.</p>}
                            </div>
                            <label className="check-row rv-part">
                                <input type="checkbox" checked={on} onChange={(e) => onChoice(setChosen([item], e.target.checked, choice, c.field))} />
                                <span>{FIELD_TEXT[c.field]} {KIND_TEXT[c.kind]}</span>
                            </label>
                        </Fragment>
                    );
                })}
                {item.split && <p>Aufgeteilte Buchung: Ihre Kategorien bleiben unverändert.</p>}
                {item.manual && <p>Von Hand erfasst: Diese Buchung ändert sich nur, wenn du sie wählst.</p>}
            </section>
        </div>
    );
}

function RunList({ items, index, choice, onChoice }: { items: RuleRunItem[]; index: CategoryIndex; choice: RunChoice; onChoice: (next: RunChoice) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const [margin, setMargin] = useState(0);
    const [open, setOpen] = useState<string | null>(null);
    useLayoutEffect(() => {
        setMargin(ref.current ? ref.current.getBoundingClientRect().top + window.scrollY : 0);
    }, []);
    const v = useWindowVirtualizer({ count: items.length, estimateSize: () => 54, overscan: 12, scrollMargin: margin, getItemKey: (i) => items[i]!.key });
    return (
        <div ref={ref} className="vlist rv-list" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((it) => {
                const item = items[it.index]!;
                const expanded = open === item.key;
                const check = rowCheck(item, choice);
                const kind = itemKind(item);
                return (
                    <div key={it.key} className="vrow" data-index={it.index} ref={(el) => v.measureElement(el)} style={{ transform: `translateY(${it.start - margin}px)` }}>
                        <div className="rv-line">
                            <input
                                type="checkbox"
                                className="rv-check"
                                aria-label={`${item.counterparty || item.remittance || "Umsatz"} übernehmen`}
                                checked={check === "on"}
                                ref={(el) => {
                                    if (el) el.indeterminate = check === "partial";
                                }}
                                onChange={() => onChoice(toggleRow(item, choice))}
                            />
                            <button type="button" className="rv-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : item.key)}>
                                <span>{dateText(item.bookingDate)}</span>
                                <span className="rv-main">
                                    <b>{item.counterparty || "—"}</b>
                                    <small>{item.remittance}</small>
                                </span>
                                <span className="rv-kind">{item.changes.map((c) => FIELD_TEXT[c.field]).join(", ")}</span>
                                <span className="amt">{fmtSigned(item.amount)}</span>
                                <span className={`rv-state ${KIND_TONE[kind]}`}>{KIND_TEXT[kind]}</span>
                            </button>
                        </div>
                        {expanded && <RunDetails item={item} index={index} choice={choice} onChoice={onChoice} />}
                    </div>
                );
            })}
        </div>
    );
}

const matches = (item: RuleRunItem, needle: string, index: CategoryIndex): boolean => {
    const q = needle.trim().toLowerCase();
    if (!q) return true;
    const texts = [item.counterparty, item.remittance, ...item.changes.flatMap((c) => [changeValue(c, "before", index), changeValue(c, "after", index)])];
    return texts.some((t) => t?.toLowerCase().includes(q));
};

/** Checks what the rules would change and writes only what was chosen. */
export function RunRulesPage() {
    const { rule: ruleParam } = runRulesRoute.useSearch();
    const navigate = useNavigate();
    const rules = useRules({ fresh: true }).data ?? [];
    const accounts = useAccounts().data ?? [];
    const { index } = useCategoryIndex();
    const action = useAction();
    // The rule from the address until another one is picked here
    const [pickedRule, setPickedRule] = useState<{ id: number | undefined } | null>(null);
    const ruleId = pickedRule ? pickedRule.id : ruleParam;
    const [mode, setMode] = useState<RuleRunMode>("empty");
    const [preview, setPreview] = useState<RulePreview | null>(null);
    const [choice, setChoice] = useState<RunChoice>(NO_CHOICE);
    const [filter, setFilter] = useState<RunFilter>("all");
    const [search, setSearch] = useState("");
    const needle = useDeferredValue(search);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [written, setWritten] = useState<number | null>(null);

    const items = useMemo(() => preview?.items ?? [], [preview]);
    const counts = useMemo(() => runCounts(items), [items]);
    const shown = useMemo(() => items.filter((i) => (filter === "all" || itemKind(i) === filter) && matches(i, needle, index)), [items, filter, needle, index]);
    const outcome = useMemo(() => runOutcome(items, choice), [items, choice]);
    const selection = useMemo(() => shownState(shown, choice), [shown, choice]);
    const activeRules = rules.filter((r) => r.active);
    const chosenRule = ruleId === undefined ? undefined : rules.find((r) => r.id === ruleId);
    const ruleName = (id: number) => {
        const r = rules.find((x) => x.id === id);
        return r ? r.name || r.query : "Regel";
    };

    const check = async (keep?: { items: RuleRunItem[]; choice: RunChoice }) => {
        setBusy(true);
        setError("");
        try {
            const next = await call(routes.previewRules, { query: { ruleId, mode } });
            setChoice(keep ? carryChoice(keep.items, next.items, keep.choice) : NO_CHOICE);
            setPreview(next);
            setFilter("all");
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const commit = async () => {
        if (!preview) return;
        setError("");
        setNotice("");
        let stale = false;
        const r = await action.run(() => call(routes.applyRules, { body: { ruleId, mode, planHash: preview.planHash, deviations: deviationsOf(items, choice) } }), {
            topics: ["transactions", "categories", "rules", "activity"],
            onError: (err: unknown) => {
                if (err instanceof ApiFailure && err.code === "rule_plan_stale") {
                    stale = true;
                    return true;
                }
                setError(errorText(err));
                return true;
            },
        });
        if (stale) {
            setNotice("Seit der Prüfung hat sich etwas geändert. Das ist der neue Stand, gespeichert wurde nichts.");
            await check({ items, choice });
        } else if (r) setWritten(r.changed);
    };

    const restart = () => {
        setPreview(null);
        setChoice(NO_CHOICE);
        setWritten(null);
        setNotice("");
        setError("");
    };

    const step = preview ? 1 : 0;
    const parts = [
        outcome.byKind.fill ? `${outcome.byKind.fill.toLocaleString("de-DE")} ergänzen` : "",
        outcome.byKind.change ? `${outcome.byKind.change.toLocaleString("de-DE")} ändern` : "",
        outcome.byKind.reset ? `${outcome.byKind.reset.toLocaleString("de-DE")} zurücksetzen` : "",
        outcome.left ? `${outcome.left.toLocaleString("de-DE")} nicht gewählt` : "",
    ].filter(Boolean).join(", ");

    if (written !== null) {
        return (
            <div className="imp-page">
                <section className="panel imp-done">
                    <span className="imp-done-ic"><Ic icon={Check} size={22} /></span>
                    <h2>{plural(written, "Umsatz", "Umsätze")} geändert</h2>
                    <div className="actions">
                        <button type="button" className="btn btn-ghost" onClick={restart}>Erneut prüfen</button>
                        <button type="button" className="btn btn-primary" onClick={() => void navigate({ to: "/settings", search: { tab: "rules" } })}>Zu den Regeln</button>
                    </div>
                </section>
            </div>
        );
    }

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>{ruleId === undefined ? "Alle aktiven Regeln ausführen" : "Regel ausführen"}</h1>
                    <p className="muted">{preview ? "Wähle, welche Änderungen übernommen werden." : `Wendet ${ruleId === undefined ? "alle aktiven Regeln" : "die Regel"} auf bereits vorhandene Umsätze an.`}</p>
                </div>
            </div>
            <div className={`imp-page ${preview ? "wide" : ""}`}>
                <StepList steps={STEPS} at={step} onPick={() => restart()} />
                {!preview && (
                    <>
                        <section className="panel imp-file run-scope">
                            <label className="run-field">
                                <span className="flabel">Regel</span>
                                <select className="inp" value={ruleId ?? "all"} onChange={(e) => setPickedRule({ id: e.target.value === "all" ? undefined : Number(e.target.value) })}>
                                    <option value="all">Alle aktiven Regeln</option>
                                    {activeRules.map((r) => <option key={r.id} value={r.id}>{r.name || r.query}</option>)}
                                </select>
                            </label>
                            {(ruleId === undefined || chosenRule) && (
                                <div className="run-rule">
                                    {chosenRule && <RuleSummary rule={chosenRule} />}
                                    <p className="muted small">{scopeText(chosenRule, activeRules.length)}</p>
                                </div>
                            )}
                            <fieldset className="run-modes">
                                <legend className="flabel">Welche Werte dürfen sich ändern?</legend>
                                <label className="check-row">
                                    <input type="radio" name="run-mode" checked={mode === "empty"} onChange={() => setMode("empty")} />
                                    <span><b>{MODE_TEXT.empty}</b><small>Vorhandene Werte bleiben.</small></span>
                                </label>
                                <label className="check-row">
                                    <input type="radio" name="run-mode" checked={mode === "all"} onChange={() => setMode("all")} />
                                    <span><b>{MODE_TEXT.all}</b><small>Aktualisiert auch frühere Ergebnisse von Regeln. Eigene Werte änderst du nur, wenn du sie wählst.</small></span>
                                </label>
                            </fieldset>
                            {error && <Hint tone="bad">{error}</Hint>}
                        </section>
                        <div className="imp-bar narrow">
                            <Button className="btn-ghost" icon={ArrowLeft} onClick={() => void navigate({ to: "/settings", search: { tab: "rules" } })}>Zurück</Button>
                            <Button className="btn-primary" icon={Wand2} busy={busy} disabled={!accounts.length && !rules.length} onClick={() => void check()}>Änderungen anzeigen</Button>
                        </div>
                    </>
                )}
                {preview && (
                    <div className="rv">
                        <div className="rv-head">
                            <span>
                                <span><b>{ruleId === undefined ? "Alle aktiven Regeln" : ruleName(ruleId)}</b> · {MODE_TEXT[mode]}</span>
                                <small>{plural(items.length, "Umsatz ändert", "Umsätze ändern")} sich, {preview.unchanged.toLocaleString("de-DE")} {preview.unchanged === 1 ? "bleibt" : "bleiben"} gleich</small>
                            </span>
                        </div>
                        {notice && <Hint>{notice}</Hint>}
                        <div className="rv-tools">
                            <label className="search">
                                <Ic icon={Search} />
                                <input type="search" placeholder="Gegenseite, Verwendungszweck oder neuer Wert" aria-label="Änderungen durchsuchen" autoComplete="off" spellCheck={false} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Escape" && search && setSearch("")} />
                                {search && (
                                    <button type="button" className="search-clear" aria-label="Suche leeren" title="Suche leeren (Esc)" onClick={() => setSearch("")}>
                                        <Ic icon={X} size={15} strokeWidth={2.2} />
                                    </button>
                                )}
                            </label>
                            <div className="seg rv-filter" role="group" aria-label="Änderungen filtern">
                                {FILTERS.map((f) => (
                                    <button key={f.filter} type="button" className={f.tone} aria-pressed={filter === f.filter} disabled={!counts[f.filter] && f.filter !== "all"} onClick={() => setFilter(f.filter)}>
                                        {f.label} <b>{counts[f.filter].toLocaleString("de-DE")}</b>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <section className="panel rv-panel" aria-label="Änderungen">
                            <div className="rv-list-head">
                                <label className="check-row">
                                    <input
                                        type="checkbox"
                                        disabled={!shown.length}
                                        checked={selection.all}
                                        ref={(el) => {
                                            if (el) el.indeterminate = selection.some;
                                        }}
                                        onChange={() => setChoice(toggleShown(shown, choice))}
                                    />
                                    <span>Alle angezeigten</span>
                                </label>
                                <span className="faint small">{shown.length.toLocaleString("de-DE")} Umsätze · {selection.chosen.toLocaleString("de-DE")} gewählt</span>
                            </div>
                            {shown.length ? <RunList key={filter} items={shown} index={index} choice={choice} onChoice={setChoice} /> : <p className="muted rv-empty">{items.length ? "Keine Änderung passt zur Suche." : "Nichts zu übernehmen."}</p>}
                        </section>
                        {error && <Hint tone="bad">{error}</Hint>}
                        <div className="imp-bar">
                            <span className="muted rv-summary">
                                {parts || "Nichts gewählt"}
                                {outcome.replaces > 0 && <>, <b>{plural(outcome.replaces, "Wert", "Werte")} ersetzen (nicht rückgängig)</b></>}
                            </span>
                            <Button className="btn-ghost" icon={ArrowLeft} onClick={restart}>Zurück</Button>
                            <Button className="btn-primary" icon={Check} busy={action.pending || busy} disabled={!outcome.chosen} onClick={() => void commit()}>
                                {plural(outcome.chosen, "Umsatz", "Umsätze")} übernehmen
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
