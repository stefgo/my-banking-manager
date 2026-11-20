import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Folder, Tag } from "lucide-react";
import { CARD_LABELS, CARD_TYPES, routes, type Card, type CardType } from "@mbm/shared";
import { call } from "../../lib/api";
import { setCardsInCache, useAction, useProfile } from "../../lib/queries";
import { ui } from "../../lib/ui";
import { Modal, Button } from "../../components/common";
import { Ic } from "../../components/icons";
import { Field } from "../../components/form";
import { Picker, PickerButton } from "../../components/pickers";
import { useCategoryItems, useScopeItems, type PickItem } from "../../components/pickItems";
import { PERIOD_LABELS, type Period } from "./period";

const CARD_HINTS: Record<CardType, string> = {
    balance: "Kontostand eines Kontos, einer Gruppe oder aller Konten mit Verlauf",
    recent: "Die neuesten Umsätze, auf Wunsch nur einer Kategorie oder vorgemerkte",
    groups: "Kontogruppen mit ihren Salden",
    cashflow: "Eingänge und Ausgaben eines Zeitraums, ohne Umbuchungen",
    upcoming: "Anstehende Termin- und Daueraufträge",
    category: "Summe einer Kategorie im Zeitraum, aufgeteilt nach Unterkategorien",
};

export function AddCardDialog() {
    const action = useAction();
    const add = async (type: CardType) => {
        const card = await action.run(() => call(routes.createCard, { body: { type } }), { ok: `Karte „${CARD_LABELS[type]}“ hinzugefügt` });
        if (card) {
            setCardsInCache((cs) => [...cs, card]);
            ui.open({ kind: "cardSettings", cardId: card.id });
        }
    };
    return (
        <Modal title="Karte hinzufügen" onClose={() => ui.close()}>
            <p className="muted">Jeder Kartentyp lässt sich mehrfach mit eigenen Einstellungen anlegen.</p>
            <div className="kind-list">
                {CARD_TYPES.map((t) => (
                    <button key={t} className="bank-item" onClick={() => void add(t)}>
                        <span className="acc-ic"><Ic icon={Check} size={16} /></span>
                        <span>
                            <b>{CARD_LABELS[t]}</b>
                            <small>{CARD_HINTS[t]}</small>
                        </span>
                        <Ic icon={ChevronRight} size={16} />
                    </button>
                ))}
            </div>
        </Modal>
    );
}

export function CardSettingsDialog({ cardId }: { cardId: number }) {
    const card = useProfile().data?.cards.find((c) => c.id === cardId);
    if (!card) return null;
    return <CardForm card={card} />;
}

function CardForm({ card }: { card: Card }) {
    const [title, setTitle] = useState(card.title ?? "");
    const [cfg, setCfg] = useState<Record<string, unknown>>(card.config);
    const scopes = useScopeItems();
    const groupItems = useMemo(() => [{ value: "top", label: "Oberste Ebene", top: true }, ...scopes.filter((x) => x.value.startsWith("group:"))], [scopes]);
    const cats = useCategoryItems();
    const allCats = useCategoryItems({ all: true });
    const action = useAction();
    const set = (k: string, v: unknown) => setCfg((c) => ({ ...c, [k]: v }));
    const has = (k: string) => k in card.config;

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        const r = await action.run(() => call(routes.updateCard, { params: { id: card.id }, body: { title: title.trim() || null, config: cfg } }), { ok: "Karte gespeichert" });
        if (r) {
            setCardsInCache((cs) => cs.map((c) => (c.id === r.id ? r : c)));
            ui.close();
        }
    };

    return (
        <Modal title={`Karte einstellen · ${CARD_LABELS[card.type]}`} onClose={() => ui.close()} narrow>
            <form className="form-grid" style={{ gap: 14 }} onSubmit={save} noValidate>
                <div className="field">
                    <label className="flabel" htmlFor="cd-title">Titel</label>
                    <input className="inp inp-sm" id="cd-title" placeholder={CARD_LABELS[card.type]} value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>
                {has("scope") && (
                    <Field id="cd-scope" label="Konten">
                        <ItemPicker id="cd-scope" items={scopes} value={String(cfg.scope)} onPick={(v) => set("scope", v)} placeholder="Konto oder Gruppe suchen …" fallback={<Ic icon={Folder} size={14} />} />
                    </Field>
                )}
                {card.type === "category" && (
                    <Field id="cd-cat" label="Kategorie">
                        <ItemPicker
                            id="cd-cat"
                            items={cats}
                            value={cfg.categoryId == null ? "" : String(cfg.categoryId)}
                            onPick={(v) => set("categoryId", Number(v))}
                            placeholder="Kategorie suchen …"
                            empty="Kategorie wählen"
                            fallback={<Ic icon={Tag} size={14} />}
                        />
                    </Field>
                )}
                {card.type === "recent" && (
                    <>
                        <Field id="cd-rcat" label="Kategorie">
                            <ItemPicker
                                id="cd-rcat"
                                items={allCats}
                                value={cfg.categoryId == null ? "all" : String(cfg.categoryId)}
                                onPick={(v) => set("categoryId", v === "all" ? null : Number(v))}
                                placeholder="Kategorie suchen …"
                                fallback={<Ic icon={Tag} size={14} />}
                            />
                        </Field>
                        <div className="field">
                            <label className="flabel" htmlFor="cd-count">Anzahl</label>
                            <input className="inp inp-sm" id="cd-count" type="number" min={3} max={25} value={Number(cfg.count)} onChange={(e) => set("count", Math.min(25, Math.max(3, Number(e.target.value) || 8)))} />
                        </div>
                        <label className="check-row">
                            <input type="checkbox" checked={!!cfg.pendingOnly} onChange={(e) => set("pendingOnly", e.target.checked)} />
                            <span>Nur vorgemerkte Umsätze</span>
                        </label>
                    </>
                )}
                {card.type === "balance" && (
                    <>
                        <div className="field">
                            <span className="flabel">Zeitraum</span>
                            <div className="seg" role="group" aria-label="Zeitraum" style={{ justifySelf: "start" }}>
                                <button type="button" aria-pressed={cfg.days === 30} onClick={() => set("days", 30)}>30 Tage</button>
                                <button type="button" aria-pressed={cfg.days === 90} onClick={() => set("days", 90)}>90 Tage</button>
                            </div>
                        </div>
                        <label className="check-row">
                            <input type="checkbox" checked={!!cfg.forecast} onChange={(e) => set("forecast", e.target.checked)} />
                            <span>Vorschau aus Aufträgen</span>
                        </label>
                    </>
                )}
                {card.type === "groups" && (
                    <>
                        <Field id="cd-root" label="Startknoten">
                            <ItemPicker
                                id="cd-root"
                                items={groupItems}
                                value={cfg.rootGroupId == null ? "top" : `group:${String(cfg.rootGroupId)}`}
                                onPick={(v) => set("rootGroupId", v === "top" ? null : Number(v.slice(6)))}
                                placeholder="Gruppe suchen …"
                                fallback={<Ic icon={Folder} size={14} />}
                            />
                        </Field>
                        <div className="field">
                            <label className="flabel" htmlFor="cd-depth">Tiefe</label>
                            <select className="inp inp-sm" id="cd-depth" value={Number(cfg.depth)} onChange={(e) => set("depth", Number(e.target.value))}>
                                {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{d} {d === 1 ? "Ebene" : "Ebenen"}</option>)}
                            </select>
                        </div>
                    </>
                )}
                {has("period") && (
                    <div className="field">
                        <label className="flabel" htmlFor="cd-period">Zeitraum</label>
                        <select className="inp inp-sm" id="cd-period" value={String(cfg.period)} onChange={(e) => set("period", e.target.value)}>
                            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
                        </select>
                    </div>
                )}
                {card.type === "upcoming" && (
                    <div className="field">
                        <label className="flabel" htmlFor="cd-days">Zeitraum (Tage)</label>
                        <input className="inp inp-sm" id="cd-days" type="number" min={7} max={90} value={Number(cfg.days)} onChange={(e) => set("days", Math.min(90, Math.max(7, Number(e.target.value) || 30)))} />
                    </div>
                )}
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Check}>
                        Speichern
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

/** A picker over `items` whose trigger shows the chosen item with its symbol. */
function ItemPicker({ id, items, value, onPick, placeholder, empty = "", fallback }: { id: string; items: PickItem[]; value: string; onPick: (v: string) => void; placeholder: string; empty?: string; fallback: ReactNode }) {
    const item = items.find((x) => x.value === value);
    return (
        <Picker
            items={items}
            value={value}
            onPick={onPick}
            placeholder={placeholder}
            trigger={
                <PickerButton id={id} set={!!item && value !== "all" && value !== "top"} icon={item?.icon ?? fallback}>
                    {item?.label ?? empty}
                </PickerButton>
            }
        />
    );
}
