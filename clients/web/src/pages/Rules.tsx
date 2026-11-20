import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Pencil, Plus, Search, Tag, Trash2, Wand2 } from "lucide-react";
import { parseTxQuery, routes, type Rule } from "@mbm/shared";
import { call } from "../lib/api";
import { useAction, useCategoryIndex, useRules, useTransactions } from "../lib/queries";
import { categoryPath } from "../lib/tree";
import { plural } from "../lib/format";
import { reviewRules } from "../lib/rules";
import { ui } from "../lib/ui";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { Empty, Hint, Switch, Button } from "../components/common";
import { CatTile, Ic } from "../components/icons";
import { Picker, PickerButton } from "../components/pickers";
import { focusFirstError } from "../lib/fields";
import { useCategoryItems } from "../components/pickItems";
import { QueryHelp } from "../components/QueryHelp";
import { SuggestList } from "../components/SuggestList";
import { useSuggest } from "../lib/useSuggest";
import type { MenuEntry } from "../lib/menus";
import { MenuButton } from "../shell/Trees";

export function RulesTab() {
    const rules = useRules({ fresh: true }).data ?? [];
    const action = useAction();
    const [editing, setEditing] = useState<number | null>(null);
    // Dragging a rule: where it comes from and where it would land
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    const [dropAt, setDropAt] = useState<{ id: number; pos: "before" | "after" } | null>(null);

    const create = async (query: string, categoryId: number) => {
        const r = await action.run(() => call(routes.createRule, { body: { query, categoryId } }), { topics: ["rules"] });
        if (!r) return false;
        await reviewRules({ ruleId: r.id, created: true });
        return true;
    };

    const update = async (rule: Rule, query: string, categoryId: number) => {
        const r = await action.run(() => call(routes.updateRule, { params: { id: rule.id }, body: { query, categoryId } }), { topics: ["rules"], ok: "Regel geändert" });
        if (!r) return false;
        setEditing(null);
        return true;
    };

    const order = (from: number, to: number) => {
        const ids = rules.map((r) => r.id);
        const [m] = ids.splice(from, 1);
        ids.splice(to, 0, m!);
        void action.run(() => call(routes.orderRules, { body: { ids } }), { topics: ["rules"] });
    };

    return (
        <>
            <section className="panel">
                <div className="panel-head">
                    <h3>Neue Regel</h3>
                </div>
                <p className="muted small" style={{ marginBottom: 12 }}>Neue Umsätze bekommen ihre Kategorie automatisch. Eine Regel ist eine Suche wie in den Umsätzen; die erste passende Regel gewinnt.</p>
                <RuleForm submitLabel="Regel anlegen" onSubmit={create} resetOnSuccess />
            </section>
            <section className="panel list-panel">
                {rules.length === 0 && <Empty icon={Wand2} title="Noch keine Regeln" text="Lege eine Regel oben an, speichere eine Suche in den Umsätzen als Regel oder ordne einen Umsatz zu und lass MBM die Zuordnung merken." />}
                {rules.map((r, i) =>
                    editing === r.id ? (
                        <div key={r.id} className="rule-edit">
                            <RuleForm
                                initialQuery={r.query}
                                initialCategory={r.categoryId}
                                submitLabel="Speichern"
                                onSubmit={(query, categoryId) => update(r, query, categoryId)}
                                onCancel={() => setEditing(null)}
                                autoFocus
                            />
                        </div>
                    ) : (
                        <RuleRow
                            key={r.id}
                            r={r}
                            index={i}
                            count={rules.length}
                            onEdit={() => setEditing(r.id)}
                            onMove={(to) => order(i, to)}
                            drop={dropAt?.id === r.id ? dropAt.pos : null}
                            drag={{
                                onDragStart: (e) => {
                                    setDragFrom(i);
                                    e.dataTransfer.setData("mbm/rule", String(r.id));
                                    e.dataTransfer.effectAllowed = "move";
                                },
                                onDragOver: (e) => {
                                    if (dragFrom === null) return;
                                    e.preventDefault();
                                    const box = e.currentTarget.getBoundingClientRect();
                                    setDropAt({ id: r.id, pos: e.clientY - box.top < box.height / 2 ? "before" : "after" });
                                },
                                onDragLeave: () => setDropAt(null),
                                onDrop: (e) => {
                                    e.preventDefault();
                                    if (dragFrom !== null && dropAt) {
                                        const to = dropIndex(dragFrom, i, dropAt.pos);
                                        if (to !== dragFrom) order(dragFrom, to);
                                    }
                                    setDragFrom(null);
                                    setDropAt(null);
                                },
                                onDragEnd: () => {
                                    setDragFrom(null);
                                    setDropAt(null);
                                },
                            }}
                        />
                    ),
                )}
            </section>
        </>
    );
}

/** Index in the order after taking the dragged rule out, for a drop before or after row `at`. */
function dropIndex(from: number, at: number, pos: "before" | "after"): number {
    const i = pos === "before" ? at : at + 1;
    return from < i ? i - 1 : i;
}

type DragHandlers = Pick<React.HTMLAttributes<HTMLDivElement>, "onDragStart" | "onDragOver" | "onDragLeave" | "onDrop" | "onDragEnd">;

/**
 * One rule: switch, the frequent actions as buttons (on wide screens) and all of them in "…",
 * including moving; the grip drags it.
 */
function RuleRow({ r, index, count, onEdit, onMove, drop, drag }: { r: Rule; index: number; count: number; onEdit: () => void; onMove: (to: number) => void; drop: "before" | "after" | null; drag: DragHandlers }) {
    const { index: cats } = useCategoryIndex();
    const action = useAction();
    const open = useOpenTransactions();
    const show = () => void open({ kind: "query", q: r.query });
    const apply = () => void reviewRules({ ruleId: r.id });
    const remove = () =>
        ui.confirm({
            title: `Regel „${r.query}“ löschen?`,
            text: "Bereits zugeordnete Umsätze behalten ihre Kategorie. Das lässt sich nicht rückgängig machen.",
            confirm: "Löschen",
            danger: true,
            onConfirm: () => action.succeeds(() => call(routes.deleteRule, { params: { id: r.id } }), { topics: ["rules"], ok: "Regel gelöscht" }),
        });
    const menu: MenuEntry[] = [
        { label: "Bearbeiten", icon: Pencil, run: onEdit },
        { label: "In Umsätzen zeigen", icon: Search, run: show },
        { label: "Auf Umsätze ohne Kategorie anwenden", icon: Wand2, disabled: !r.active, run: apply },
        { separator: true },
        { label: "Nach oben", icon: ArrowUp, disabled: index === 0, run: () => onMove(index - 1) },
        { label: "Nach unten", icon: ArrowDown, disabled: index === count - 1, run: () => onMove(index + 1) },
        { separator: true },
        { label: "Löschen", icon: Trash2, danger: true, run: remove },
    ];
    return (
        <div className={`rule ${r.active ? "" : "off"} ${drop ? `drop-${drop}` : ""}`} draggable {...drag}>
            <span className="grip" aria-hidden="true" title="Ziehen zum Verschieben">
                <Ic icon={GripVertical} size={14} />
            </span>
            <span className="r-txt">
                Wenn <code>{r.query}</code>
                <Ic icon={ChevronRight} size={14} />
                <span className="cchip">
                    <CatTile idx={cats} id={r.categoryId} size={11} className="ti-s" />
                    {categoryPath(cats, r.categoryId)}
                </span>
            </span>
            <span className="muted small r-hits">{plural(r.hits, "Umsatz", "Umsätze")}</span>
            <span className="card-tools">
                <Switch checked={r.active} label="Regel aktiv" onChange={(active) => void action.run(() => call(routes.updateRule, { params: { id: r.id }, body: { active } }), { topics: ["rules"] })} />
            </span>
            <span className="card-tools rule-btns">
                <button className="mini" aria-label="Regel bearbeiten" title="Bearbeiten" onClick={onEdit}>
                    <Ic icon={Pencil} size={14} />
                </button>
                <button className="mini" aria-label="In Umsätzen zeigen" title="In Umsätzen zeigen" onClick={show}>
                    <Ic icon={Search} size={14} />
                </button>
                <button
                    className="mini"
                    aria-label="Auf Umsätze ohne Kategorie anwenden"
                    title={r.active ? "Auf Umsätze ohne Kategorie anwenden" : "Abgeschaltet – zum Anwenden einschalten"}
                    disabled={!r.active}
                    onClick={apply}
                >
                    <Ic icon={Wand2} size={14} />
                </button>
                <button className="mini" aria-label="Regel löschen" title="Löschen" onClick={remove}>
                    <Ic icon={Trash2} size={15} />
                </button>
            </span>
            <MenuButton items={menu} label="Weitere Aktionen für die Regel" />
        </div>
    );
}

/** Query and category of a rule, checked while typing, with the number of bookings it matches. */
function RuleForm({
    initialQuery = "",
    initialCategory = null,
    submitLabel,
    onSubmit,
    onCancel,
    resetOnSuccess = false,
    autoFocus = false,
}: {
    initialQuery?: string;
    initialCategory?: number | null;
    submitLabel: string;
    onSubmit: (query: string, categoryId: number) => Promise<boolean>;
    onCancel?: () => void;
    resetOnSuccess?: boolean;
    autoFocus?: boolean;
}) {
    const { index } = useCategoryIndex();
    const catItems = useCategoryItems();
    const [query, setQuery] = useState(initialQuery);
    const queryRef = useRef<HTMLInputElement>(null);
    const hints = useSuggest({ value: query, onChange: setQuery, inputRef: queryRef, mode: "rule" });
    const [cat, setCat] = useState<number | null>(initialCategory);
    const [error, setError] = useState<{ field: "query" | "cat"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const ids = useId();
    const queryId = `${ids}-q`;
    const catId = `${ids}-cat`;
    const msgId = `${ids}-msg`;
    // Checking and counting wait a moment after typing
    const [settled, setSettled] = useState(initialQuery.trim());
    useEffect(() => {
        const t = setTimeout(() => setSettled(query.trim()), 220);
        return () => clearTimeout(t);
    }, [query]);
    const check = parseTxQuery(settled, { mode: "rule" });
    const hits = useTransactions({ q: settled, range: "all", limit: 1 }, check.ok);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        const now = parseTxQuery(query.trim(), { mode: "rule" });
        const problem = !query.trim()
            ? ({ field: "query", text: "Bitte eine Abfrage eingeben, z. B. gegenseite:rewe." } as const)
            : !now.ok
              ? ({ field: "query", text: now.error } as const)
              : !cat
                ? ({ field: "cat", text: "Bitte eine Kategorie wählen." } as const)
                : null;
        if (problem || !cat) {
            if (problem) {
                setError(problem);
                focusFirstError({ [problem.field === "query" ? queryId : catId]: problem.text });
            }
            return;
        }
        setBusy(true);
        const ok = await onSubmit(query.trim(), cat);
        setBusy(false);
        if (ok && resetOnSuccess) setQuery("");
    };

    return (
        <form className="rule-form-wrap" onSubmit={submit} noValidate>
            <div className="rule-form">
                <label className="q-field">
                    <input
                        placeholder='z. B. gegenseite:rewe ODER zweck:"edeka markt"'
                        aria-label="Abfrage der Regel"
                        value={query}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus={autoFocus}
                        id={queryId}
                        aria-invalid={error?.field === "query" || (!!settled && !check.ok) ? true : undefined}
                        aria-describedby={msgId}
                        ref={queryRef}
                        {...hints.inputProps}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            hints.onInput();
                            if (error?.field === "query") setError(null);
                        }}
                        onKeyDown={(e) => {
                            if (hints.onKeyDown(e)) return;
                            if (e.key === "Escape") onCancel?.();
                        }}
                    />
                    <QueryHelp mode="rule" />
                    <SuggestList list={hints.list} />
                </label>
                <Picker
                    items={catItems}
                    value={cat ? String(cat) : undefined}
                    onPick={(v) => {
                        setCat(Number(v));
                        if (error?.field === "cat") setError(null);
                    }}
                    placeholder="Kategorie suchen …"
                    trigger={
                        <PickerButton
                            id={catId}
                            aria-label="Kategorie der Regel"
                            aria-invalid={error?.field === "cat" ? true : undefined}
                            aria-describedby={error?.field === "cat" ? msgId : undefined}
                            set={!!cat}
                            icon={cat ? <CatTile idx={index} id={cat} size={12} className="ti-s" /> : <Ic icon={Tag} size={15} />}
                        >
                            <span>{cat ? categoryPath(index, cat) : "Kategorie wählen"}</span>
                        </PickerButton>
                    }
                />
                <span className="row">
                    <Button className="btn-primary btn-sm" type="submit" busy={busy} icon={onCancel ? undefined : Plus} iconSize={14}>
                        {submitLabel}
                    </Button>
                    {onCancel && (
                        <button className="btn btn-sm btn-ghost" type="button" onClick={onCancel}>
                            Abbrechen
                        </button>
                    )}
                </span>
            </div>
            <div id={msgId}>
                {error ? (
                    <Hint tone="bad">{error.text}</Hint>
                ) : settled && !check.ok ? (
                    <Hint tone="bad">{check.error}</Hint>
                ) : settled && hits.data ? (
                    <Hint>Passt auf {plural(hits.data.count, "Umsatz", "Umsätze")}. Neue Umsätze ohne Kategorie, auf die die Abfrage passt, bekommen die Kategorie.</Hint>
                ) : null}
            </div>
        </form>
    );
}
