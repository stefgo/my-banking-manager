import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, GripVertical, Pencil, Search, Trash2, Wand2 } from "lucide-react";
import { routes, type Rule } from "@mbm/shared";
import { call } from "../lib/api";
import { useAction, useRules } from "../lib/queries";
import { plural } from "../lib/format";
import { openRunRules, takeRuleIntent, type RuleIntent } from "../lib/rules";
import { ui } from "../lib/ui";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { Empty, Switch } from "../components/common";
import { Ic } from "../components/icons";
import { RuleSummary } from "../components/RuleSummary";
import type { MenuEntry } from "../lib/menus";
import { MenuButton } from "../shell/Trees";
import { settingsRoute } from "../router";
import { RuleForm, type RuleValues } from "./RuleForm";

export function RulesTab() {
    const rules = useRules({ fresh: true }).data ?? [];
    const action = useAction();
    // Opened from a booking: one rule to edit, or a form filled in from it
    const [intent] = useState<RuleIntent | null>(() => takeRuleIntent());
    const [editing, setEditing] = useState<number | null>(intent?.kind === "edit" ? intent.ruleId : null);
    const [draft, setDraft] = useState(intent?.kind === "draft" ? intent.draft : undefined);
    const { new: adding } = settingsRoute.useSearch();
    const navigate = useNavigate();
    const formOpen = adding === true || draft !== undefined;
    const closeForm = () => {
        setDraft(undefined);
        if (adding) void navigate({ to: "/settings", search: { tab: "rules" }, replace: true });
    };
    // Dragging a rule: where it comes from and where it would land
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    const [dropAt, setDropAt] = useState<{ id: number; pos: "before" | "after" } | null>(null);

    const create = async (values: RuleValues, run: boolean) => {
        const r = await action.run(() => call(routes.createRule, { body: values }), { topics: ["rules"], ok: "Regel angelegt" });
        if (!r) return;
        if (run) openRunRules(r.id);
        else closeForm();
    };

    const update = async (rule: Rule, values: RuleValues, run: boolean) => {
        const r = await action.run(() => call(routes.updateRule, { params: { id: rule.id }, body: values }), { topics: ["rules"], ok: "Regel gespeichert" });
        if (!r) return;
        setEditing(null);
        if (run && r.active) openRunRules(r.id);
    };

    const order = (from: number, to: number) => {
        const ids = rules.map((r) => r.id);
        const [m] = ids.splice(from, 1);
        ids.splice(to, 0, m!);
        void action.run(() => call(routes.orderRules, { body: { ids } }), { topics: ["rules"] });
    };

    return (
        <>
            {formOpen && (
                <section className="panel">
                    <div className="panel-head">
                        <h3>Neue Regel</h3>
                    </div>
                    <RuleForm initial={draft} canRun onSubmit={create} onCancel={closeForm} autoFocus />
                </section>
            )}
            <section className="panel list-panel">
                {rules.length > 0 && <p className="muted small rules-note">Regeln wirken einmal auf neue Umsätze von der Bank und aus CSV-Dateien. Je Umsatz gilt nur die erste passende Regel. Vorhandene Umsätze ändern sich erst, wenn du eine Regel ausführst.</p>}
                {rules.length === 0 && <Empty icon={Wand2} title="Noch keine Regeln" text="Lege über „Regel hinzufügen“ eine an, speichere eine Suche in den Umsätzen als Regel oder ordne einen Umsatz zu und lass MBM die Zuordnung merken." />}
                {rules.map((r, i) =>
                    editing === r.id ? (
                        <div key={r.id} className="rule-edit">
                            <RuleForm
                                initial={r}
                                ruleId={r.id}
                                canRun={r.active}
                                onSubmit={(values, run) => update(r, values, run)}
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
 * One rule: its switch and all actions in "…", including moving; the grip drags it.
 */
function RuleRow({ r, index, count, onEdit, onMove, drop, drag }: { r: Rule; index: number; count: number; onEdit: () => void; onMove: (to: number) => void; drop: "before" | "after" | null; drag: DragHandlers }) {
    const action = useAction();
    const open = useOpenTransactions();
    const show = () => void open({ kind: "query", q: r.query });
    const apply = () => openRunRules(r.id);
    const title = r.name || r.query;
    const taken = r.active ? r.hits - r.wins : 0;
    const remove = () =>
        ui.confirm({
            title: `Regel „${title}“ löschen?`,
            text: "Vorhandene Umsätze bleiben unverändert. Das lässt sich nicht rückgängig machen.",
            confirm: "Löschen",
            danger: true,
            onConfirm: () => action.succeeds(() => call(routes.deleteRule, { params: { id: r.id } }), { topics: ["rules"], ok: "Regel gelöscht" }),
        });
    const menu: MenuEntry[] = [
        { label: "Bearbeiten", icon: Pencil, run: onEdit },
        { label: "In Umsätzen zeigen", icon: Search, run: show },
        { label: "Regel ausführen", icon: Wand2, disabled: !r.active, run: apply },
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
            <RuleSummary rule={r} />
            <span className="muted small r-hits" title={taken > 0 ? `${taken} davon erfasst eine Regel weiter oben` : undefined}>
                {plural(r.hits, "Umsatz", "Umsätze")}
                {taken > 0 && ` · ${taken} oben erfasst`}
            </span>
            <span className="card-tools">
                <Switch checked={r.active} label="Regel aktiv" onChange={(active) => void action.run(() => call(routes.updateRule, { params: { id: r.id }, body: { active } }), { topics: ["rules"] })} />
            </span>
            <MenuButton items={menu} label="Weitere Aktionen für die Regel" />
        </div>
    );
}
