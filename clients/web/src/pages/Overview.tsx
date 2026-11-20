import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowDownRight, ArrowUp, ArrowUpRight, Check, ChevronRight, Folder, GripVertical, List, Minus, MoveDiagonal2, Pencil, Plus, RotateCcw } from "lucide-react";
import { CARD_LABELS, clampCardSize, routes, todayIso, toIsoDate, type AccountScope, type Card } from "@mbm/shared";
import { call } from "../lib/api";
import { setCardsInCache, useAccounts, useAction, useCashflow, useCategoryIndex, useCategorySums, useGroups, useProfile, useSeries, useTransactions, useUpcomingOrders } from "../lib/queries";
import { accountTree, accountsInScope, categorySubtree, childRows, scopeName, subtreeHasNone, sumBalance, type TreeNode } from "../lib/tree";
import { plural } from "../lib/format";
import { ui, useUi } from "../lib/ui";
import { useMedia } from "../lib/media";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { Amt, BigAmount, Empty, Kbd, NoBankAccess } from "../components/common";
import { CatTile, Ic, Tile } from "../components/icons";
import { BalanceChart } from "../components/BalanceChart";
import { OrderRow } from "../components/OrderRow";
import { upcomingKey } from "../lib/orders";
import { TxList } from "../components/TxList";
import { SkeletonCard, SkeletonRows } from "../components/Skeleton";
import { MenuButton } from "../shell/Trees";
import type { MenuEntry } from "../lib/menus";
import { PERIOD_LABELS, periodBounds, type Period } from "./overview/period";
import { dragSize, FULL_GRID_QUERY, pxToRows, rowsToPx, sizeLabel, spanOfSix, unitSpan } from "./overview/grid";

interface Size {
    width: number;
    height: number | null;
}

export function OverviewPage() {
    const profile = useProfile();
    const cards = profile.data?.cards ?? [];
    const editing = useUi((s) => s.cardsEditing);
    const accounts = useAccounts();
    const action = useAction();
    const [dragId, setDragId] = useState<number | null>(null);
    const [overId, setOverId] = useState<number | null>(null);
    // Size of the card being resized, shown live and saved when the handle is let go
    const [draft, setDraft] = useState<(Size & { id: number }) | null>(null);
    const resizing = useRef(false);
    const gridRef = useRef<HTMLDivElement>(null);
    const fullGrid = useMedia(FULL_GRID_QUERY);
    useCardSpans(gridRef, cards.map((c) => c.id).join(","));

    const move = (from: number, to: number) => {
        const ids = cards.map((c) => c.id);
        const [moved] = ids.splice(ids.indexOf(from), 1);
        ids.splice(ids.indexOf(to), 0, moved!);
        setCardsInCache((cs) => ids.map((id, i) => ({ ...cs.find((c) => c.id === id)!, position: i })));
        void action.run(() => call(routes.orderCards, { body: { ids } }));
    };

    const draftOf = (card: Card) => (size: Size | null) => {
        resizing.current = size !== null;
        setDraft(size && { id: card.id, ...size });
    };
    const overviewMenu: MenuEntry[] = [
        {
            label: "Standard wiederherstellen …",
            icon: RotateCcw,
            run: () =>
                ui.confirm({
                    title: "Standard wiederherstellen?",
                    text: "Deine Karten und ihre Einstellungen werden durch die Standard-Übersicht ersetzt. Das lässt sich nicht rückgängig machen.",
                    confirm: "Wiederherstellen",
                    onConfirm: async () => {
                        const cs = await action.run(() => call(routes.resetCards), { ok: "Übersicht zurückgesetzt" });
                        if (cs) setCardsInCache(() => cs);
                        return !!cs;
                    },
                }),
        },
    ];

    const commitSize = (card: Card) => (size: Size) => {
        resizing.current = false;
        setDraft(null);
        if (size.width !== card.width || size.height !== card.height) resizeCard(card, size, action);
    };

    return (
        <>
            <h1 className="sr-only">Übersicht</h1>
            {accounts.data && accounts.data.length === 0 && (
                <section className="panel">
                    <NoBankAccess offline />
                </section>
            )}
            {profile.isPending && (
                <div className="card-grid">
                    <div className="card-cell" style={{ "--w": 8, "--w6": 6 } as React.CSSProperties}><SkeletonCard tall /></div>
                    <div className="card-cell" style={{ "--w": 4, "--w6": 6 } as React.CSSProperties}><SkeletonCard tall /></div>
                    <div className="card-cell" style={{ "--w": 8, "--w6": 6 } as React.CSSProperties}><SkeletonCard /></div>
                    <div className="card-cell" style={{ "--w": 4, "--w6": 6 } as React.CSSProperties}><SkeletonCard /></div>
                </div>
            )}
            <div ref={gridRef} className={`card-grid ${editing ? "editing" : ""} ${draft ? "resizing" : ""}`}>
                {cards.map((card) => {
                    const size = draft?.id === card.id ? draft : card;
                    return (
                        <div
                            key={card.id}
                            className={`card-cell ${size.height !== null ? "fixed" : ""} ${overId === card.id && dragId !== card.id ? "drop-before" : ""}`}
                            style={{ "--w": size.width, "--w6": spanOfSix(size.width), "--h": size.height !== null ? `${rowsToPx(size.height)}px` : undefined } as React.CSSProperties}
                            data-card={card.id}
                            // In "Anordnen" a card takes the focus; Alt + arrows move it
                            tabIndex={editing ? 0 : undefined}
                            aria-label={editing ? `Karte „${card.title || CARD_LABELS[card.type]}“, Alt und Pfeiltasten verschieben` : undefined}
                            onKeyDown={(e) => {
                                if (!editing || !e.altKey || e.target !== e.currentTarget) return;
                                const delta = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
                                if (!delta) return;
                                e.preventDefault();
                                shiftCard(cards, card.id, delta, action);
                                requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-card="${card.id}"]`)?.focus());
                            }}
                            draggable={editing}
                            onDragStart={(e) => {
                                if (resizing.current) {
                                    e.preventDefault();
                                    return;
                                }
                                setDragId(card.id);
                                e.dataTransfer.setData("mbm/card", String(card.id));
                            }}
                            onDragOver={(e) => {
                                if (dragId !== null) {
                                    e.preventDefault();
                                    setOverId(card.id);
                                }
                            }}
                            onDragEnd={() => {
                                setDragId(null);
                                setOverId(null);
                            }}
                            onDrop={(e) => {
                                e.preventDefault();
                                if (dragId !== null && dragId !== card.id) move(dragId, card.id);
                                setDragId(null);
                                setOverId(null);
                            }}
                        >
                            <CardView card={card} fixed={size.height !== null} />
                            {editing && fullGrid && <SizeControls card={card} size={size} gridRef={gridRef} onDraft={draftOf(card)} onCommit={commitSize(card)} />}
                        </div>
                    );
                })}
            </div>
            {editing && cards.length > 1 && (
                <p className="hint center">Karten ziehen oder mit <Kbd>Alt</Kbd> + Pfeiltasten verschieben; die Ecke unten rechts ändert die Größe.</p>
            )}
            <div className="overview-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => ui.open({ kind: "addCard" })}>
                    <Ic icon={Plus} size={15} />
                    Karte hinzufügen
                </button>
                <button className="btn btn-ghost btn-sm" aria-pressed={editing} onClick={() => ui.setCardsEditing(!editing)} title={editing ? "Anordnen beenden" : "Karten verschieben und in der Größe ändern"}>
                    <Ic icon={editing ? Check : Pencil} size={15} />
                    {editing ? "Fertig" : "Anordnen"}
                </button>
                <MenuButton items={overviewMenu} label="Weitere Aktionen" className="icon-btn" />
            </div>
        </>
    );
}

/**
 * Lets each card span as many fine grid rows as it is high, so a card fills the space under a
 * shorter neighbour instead of waiting for the tallest card of the row. Written to the element
 * directly: it changes with the content and needs no render.
 */
function useCardSpans(gridRef: React.RefObject<HTMLDivElement | null>, key: string) {
    useLayoutEffect(() => {
        const grid = gridRef.current;
        if (!grid) return;
        const fit = (el: HTMLElement, px: number) => {
            el.style.gridRowEnd = `span ${unitSpan(px)}`;
        };
        const observer = new ResizeObserver((entries) => {
            for (const e of entries) fit(e.target as HTMLElement, e.borderBoxSize[0]?.blockSize ?? e.target.getBoundingClientRect().height);
        });
        for (const el of grid.querySelectorAll<HTMLElement>(":scope > .card-cell")) {
            fit(el, el.getBoundingClientRect().height);
            observer.observe(el);
        }
        return () => observer.disconnect();
    }, [gridRef, key]);
}

function resizeCard(card: Card, size: Size, action: ReturnType<typeof useAction>) {
    const next = clampCardSize(card.type, size.width, size.height);
    setCardsInCache((cs) => cs.map((c) => (c.id === card.id ? { ...c, ...next } : c)));
    void action.run(() => call(routes.updateCard, { params: { id: card.id }, body: next }));
}

// ---------- Resizing in "Anordnen" ----------

function SizeControls({
    card,
    size,
    gridRef,
    onDraft,
    onCommit,
}: {
    card: Card;
    size: Size;
    gridRef: React.RefObject<HTMLDivElement | null>;
    onDraft: (size: Size | null) => void;
    onCommit: (size: Size) => void;
}) {
    const start = useRef<{ x: number; y: number; gridPx: number; base: Size & { measuredRows: number } } | null>(null);
    const measuredRows = (el: Element) => pxToRows(el.closest(".card-cell")?.getBoundingClientRect().height ?? 0);
    const at = (e: React.PointerEvent) => {
        const s = start.current!;
        return dragSize(card.type, s.base, e.clientX - s.x, e.clientY - s.y, s.gridPx);
    };
    const step = (dw: number, dh: number, el: Element) => {
        const height = dh === 0 ? card.height : (card.height ?? measuredRows(el)) + dh;
        onCommit(clampCardSize(card.type, card.width + dw, height));
    };
    return (
        <>
            <div className="card-size" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" className="mini" aria-label="Schmaler" title="Schmaler" onClick={(e) => step(-1, 0, e.currentTarget)}>
                    <Ic icon={Minus} size={14} />
                </button>
                <b aria-live="polite">{sizeLabel(size.width, size.height)}</b>
                <button type="button" className="mini" aria-label="Breiter" title="Breiter" onClick={(e) => step(1, 0, e.currentTarget)}>
                    <Ic icon={Plus} size={14} />
                </button>
                {card.height !== null && (
                    <button type="button" className="mini auto" title="Höhe nach Inhalt" onClick={() => onCommit({ width: card.width, height: null })}>
                        auto
                    </button>
                )}
            </div>
            <button
                type="button"
                className="card-resize"
                aria-label={`Größe ändern, ${size.width} von 12 Spalten, Höhe ${size.height ?? "automatisch"}`}
                title="Ziehen ändert die Größe; Pfeiltasten ebenso"
                onPointerDown={(e) => {
                    if (e.button !== 0 || !gridRef.current) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    start.current = { x: e.clientX, y: e.clientY, gridPx: gridRef.current.clientWidth, base: { width: card.width, height: card.height, measuredRows: measuredRows(e.currentTarget) } };
                    onDraft({ width: card.width, height: card.height });
                }}
                onPointerMove={(e) => start.current && onDraft(at(e))}
                onPointerUp={(e) => {
                    if (!start.current) return;
                    const next = at(e);
                    start.current = null;
                    onCommit(next);
                }}
                onPointerCancel={() => {
                    start.current = null;
                    onDraft(null);
                }}
                onKeyDown={(e) => {
                    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
                    if (!d) return;
                    e.preventDefault();
                    step(d[0]!, d[1]!, e.currentTarget);
                }}
            >
                <Ic icon={MoveDiagonal2} size={12} />
            </button>
        </>
    );
}

// ---------- One card ----------

/** Moves a card one place to the front (-1) or back (1). */
function shiftCard(cards: Card[], id: number, delta: number, action: ReturnType<typeof useAction>): void {
    const ids = cards.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setCardsInCache((cs) => ids.map((cid, position) => ({ ...cs.find((c) => c.id === cid)!, position })));
    void action.run(() => call(routes.orderCards, { body: { ids } }));
}

function cardMenu(card: Card, action: ReturnType<typeof useAction>, cards: Card[]): MenuEntry[] {
    const title = card.title || CARD_LABELS[card.type];
    const at = cards.findIndex((c) => c.id === card.id);
    return [
        { label: "Einstellen …", run: () => ui.open({ kind: "cardSettings", cardId: card.id }) },
        { separator: true },
        { label: "Nach vorne", icon: ArrowUp, disabled: at <= 0, run: () => shiftCard(cards, card.id, -1, action) },
        { label: "Nach hinten", icon: ArrowDown, disabled: at < 0 || at >= cards.length - 1, run: () => shiftCard(cards, card.id, 1, action) },
        { separator: true },
        {
            label: "Entfernen …",
            danger: true,
            run: () =>
                ui.confirm({
                    title: `Karte „${title}“ entfernen?`,
                    text: "Die Einstellungen der Karte gehen verloren. Das lässt sich nicht rückgängig machen.",
                    confirm: "Entfernen",
                    danger: true,
                    onConfirm: async () => {
                        const ok = await action.succeeds(() => call(routes.deleteCard, { params: { id: card.id } }), { ok: "Karte entfernt" });
                        if (ok) setCardsInCache((cs) => cs.filter((c) => c.id !== card.id));
                        return ok;
                    },
                }),
        },
    ];
}

function CardHead({ card, title, extra }: { card: Card; title: string; extra?: React.ReactNode }) {
    const action = useAction();
    const cards = useProfile().data?.cards ?? [];
    const editing = useUi((s) => s.cardsEditing);
    return (
        <div className="panel-head">
            <h3 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {editing && <Ic icon={GripVertical} size={14} />}
                {card.title || title}
            </h3>
            <span className="card-tools">
                {extra}
                <MenuButton items={cardMenu(card, action, cards)} label="Karte einstellen" />
            </span>
        </div>
    );
}

function CardView({ card, fixed }: { card: Card; fixed: boolean }) {
    switch (card.type) {
        case "balance":
            return <BalanceCard card={card} fixed={fixed} />;
        case "recent":
            return <RecentCard card={card} />;
        case "groups":
            return <GroupsCard card={card} />;
        case "cashflow":
            return <CashflowCard card={card} />;
        case "upcoming":
            return <UpcomingCard card={card} />;
        case "category":
            return <CategoryCard card={card} />;
        default:
            return (
                <section className="panel">
                    <div className="card-ph">Diese Karte kennt der Web-Client noch nicht.</div>
                </section>
            );
    }
}

function useScopeLabel(scope: AccountScope) {
    const groups = useGroups().data ?? [];
    const accounts = useAccounts().data ?? [];
    return { label: scopeName(scope, groups, accounts), ids: accountsInScope(scope, groups, accounts), groups, accounts };
}

function BalanceCard({ card, fixed }: { card: Card; fixed: boolean }) {
    const cards = useProfile().data?.cards ?? [];
    const cfg = card.config as { scope: AccountScope; days: 30 | 90; forecast: boolean };
    const { label, ids } = useScopeLabel(cfg.scope);
    const total = sumBalance(ids);
    const series = useSeries(cfg.scope, cfg.days);
    const today = todayIso();
    const monthStart = toIsoDate(new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1));
    const before = series.data?.points.find((p) => p.date >= monthStart);
    const delta = before ? total - before.balance : 0;
    const action = useAction();
    const open = useOpenTransactions();
    const setDays = (days: 30 | 90) => {
        setCardsInCache((cs) => cs.map((c) => (c.id === card.id ? { ...c, config: { ...c.config, days } } : c)));
        void action.run(() => call(routes.updateCard, { params: { id: card.id }, body: { config: { days } } }));
    };
    return (
        <section className="hero" aria-label="Saldo">
            <div className="hero-top">
                <button className={`picker-btn ${cfg.scope !== "all" ? "set" : ""}`} onClick={() => void open({ kind: "show", search: { scope: cfg.scope } })}>
                    <Ic icon={Folder} size={15} />
                    {card.title || label}
                    <Ic icon={ChevronRight} size={14} />
                </button>
                <span className="card-tools">
                    <span className="status">{plural(ids.length, "Konto", "Konten")}</span>
                    <MenuButton items={cardMenu(card, action, cards)} label="Karte einstellen" />
                </span>
            </div>
            <BigAmount cents={total} className="hero-amount" />
            <div className="hero-sub">
                <span className="muted">
                    <span className={`delta ${delta >= 0 ? "" : "down"}`}>
                        <Ic icon={delta >= 0 ? ArrowUpRight : ArrowDownRight} size={14} strokeWidth={2.2} />
                        <Amt cents={delta} signed />
                    </span>
                    &nbsp; seit Monatsbeginn
                </span>
                <div className="seg" role="group" aria-label="Zeitraum">
                    <button aria-pressed={cfg.days === 30} onClick={() => setDays(30)}>30 Tage</button>
                    <button aria-pressed={cfg.days === 90} onClick={() => setDays(90)}>90 Tage</button>
                </div>
            </div>
            <BalanceChart scope={cfg.scope} days={cfg.days} height={fixed ? "fill" : 210} forecastDays={cfg.forecast ? cfg.days : 0} />
            <div className="legend">
                <span><i className="lg-line" />Verlauf</span>
                {cfg.forecast && <span title="Zieht nur die bekannten Dauer- und Terminaufträge ab; Lastschriften und Eingänge fehlen"><i className="lg-line dashed" />Vorschau aus Aufträgen</span>}
            </div>
        </section>
    );
}

function RecentCard({ card }: { card: Card }) {
    const cfg = card.config as { scope: AccountScope; categoryId: number | null; pendingOnly: boolean; count: number };
    const accounts = useAccounts().data ?? [];
    const { index } = useCategoryIndex();
    const open = useOpenTransactions();
    const list = useTransactions({
        scope: cfg.scope,
        range: "all",
        category: cfg.categoryId ? String(cfg.categoryId) : "all",
        pending: cfg.pendingOnly ? "true" : undefined,
        limit: cfg.count,
    });
    return (
        <section className="panel list-panel" aria-label="Letzte Umsätze">
            <div style={{ padding: "6px 12px 0" }}>
                <CardHead
                    card={card}
                    title={CARD_LABELS.recent}
                    extra={
                        <button className="link" onClick={() => void open({ kind: "show", search: { scope: cfg.scope, cat: cfg.categoryId ? String(cfg.categoryId) : undefined, range: "all" } })}>
                            Alle Umsätze <Ic icon={ChevronRight} size={14} />
                        </button>
                    }
                />
            </div>
            <div className="card-body">
                {list.data?.items.length ? <TxList items={list.data.items} accounts={accounts} cat={index} /> : list.isPending ? <SkeletonRows rows={Math.min(cfg.count, 6)} /> : <Empty icon={List} title="Noch keine Umsätze" />}
            </div>
        </section>
    );
}

function GroupsCard({ card }: { card: Card }) {
    const cfg = card.config as { rootGroupId: number | null; depth: number };
    const groups = useGroups().data ?? [];
    const accounts = useAccounts().data ?? [];
    const open = useOpenTransactions();
    const root = cfg.rootGroupId ? groups.find((g) => g.id === cfg.rootGroupId) : undefined;
    const nodes = accountTree(groups, accounts, root?.id ?? null);
    const rows: React.ReactNode[] = [];
    const walk = (ns: TreeNode[], d: number) => {
        for (const n of ns) {
            if (n.kind === "group") {
                const ids = accountsInScope(`group:${n.group.id}`, groups, accounts);
                rows.push(
                    <button key={`g${n.group.id}`} className="grp-row" style={{ "--d": d } as React.CSSProperties} onClick={() => void open({ kind: "show", search: { scope: `group:${n.group.id}` } })}>
                        <Tile icon={n.group.icon} color={n.group.color} size={15} />
                        <span>
                            <b>{n.group.name}</b>
                            <small>{plural(ids.length, "Konto", "Konten")}</small>
                        </span>
                        <Amt cents={sumBalance(ids)} />
                    </button>,
                );
                if (d + 1 < cfg.depth) walk(n.children, d + 1);
            } else {
                const a = n.account;
                rows.push(
                    <button key={`a${a.id}`} className="grp-row acc" style={{ "--d": d } as React.CSSProperties} onClick={() => void open({ kind: "show", search: { scope: `account:${a.id}` } })}>
                        <Tile icon={a.icon} color={a.color} size={15} />
                        <span>
                            <b>{a.name}</b>
                            <small>{a.kind === "offline" ? "Offline-Konto" : (a.iban ?? "")}</small>
                        </span>
                        <Amt cents={a.balance} />
                    </button>,
                );
            }
        }
    };
    walk(nodes, 0);
    return (
        <section className="panel" aria-label="Kontogruppen">
            <CardHead card={card} title={root ? root.name : CARD_LABELS.groups} />
            <div className="card-body">{rows.length ? <div className="grp-rows">{rows}</div> : <p className="muted small">Noch keine Konten.</p>}</div>
        </section>
    );
}

function CashflowCard({ card }: { card: Card }) {
    const cfg = card.config as { scope: AccountScope; period: Period };
    const { from, to } = periodBounds(cfg.period);
    const flow = useCashflow(cfg.scope, from, to);
    const { label } = useScopeLabel(cfg.scope);
    return (
        <section className="panel" aria-label="Eingänge und Ausgaben">
            <CardHead card={card} title={PERIOD_LABELS[cfg.period]} />
            <div className="card-body">
                <div className="io">
                    <div>
                        <span className="label">Eingänge</span>
                        <Amt cents={flow.data?.income ?? 0} signed as="b" />
                    </div>
                    <div>
                        <span className="label">Ausgaben</span>
                        <Amt cents={flow.data?.expenses ?? 0} as="b" />
                    </div>
                </div>
                <p className="muted small" style={{ marginTop: 10 }}>
                    {label} · ohne Umbuchungen
                </p>
            </div>
        </section>
    );
}

function UpcomingCard({ card }: { card: Card }) {
    const cfg = card.config as { scope: AccountScope; count: number; days: number };
    const upcoming = useUpcomingOrders(cfg.scope, cfg.days, cfg.count);
    const accounts = useAccounts().data ?? [];
    const navigate = useNavigate();
    const items = upcoming.data?.items ?? [];
    const several = new Set(items.map((i) => i.accountId)).size > 1;
    const openOrder = (key: string | null) => {
        ui.openOrder(key);
        void navigate({ to: "/orders" });
    };
    return (
        <section className="panel" aria-label="Demnächst">
            <CardHead
                card={card}
                title={CARD_LABELS.upcoming}
                extra={
                    <button className="link" onClick={() => openOrder(null)}>
                        Alle Aufträge <Ic icon={ChevronRight} size={14} />
                    </button>
                }
            />
            <div className="card-body">
                {items.length > 0 ? (
                    <div className="up-list">
                        {items.map((i) => (
                            <OrderRow
                                key={`${upcomingKey(i)}:${i.date}`}
                                date={i.date}
                                name={i.payeeName}
                                detail={[i.remittance, several ? (accounts.find((a) => a.id === i.accountId)?.name ?? "") : ""].filter(Boolean).join(" · ")}
                                amount={i.amount}
                                internal={i.payeeAccountId !== null}
                                onClick={() => openOrder(upcomingKey(i))}
                            />
                        ))}
                    </div>
                ) : upcoming.isPending ? (
                    <SkeletonRows rows={Math.min(cfg.count, 4)} />
                ) : (
                    <p className="muted small" style={{ padding: "4px 0" }}>
                        In den nächsten {cfg.days} Tagen steht kein Dauer- oder Terminauftrag an. Aufträge kommen mit dem Abruf von der Bank.
                    </p>
                )}
            </div>
        </section>
    );
}

function CategoryCard({ card }: { card: Card }) {
    const cfg = card.config as { categoryId: number | null; scope: AccountScope; period: Period };
    const { index } = useCategoryIndex();
    const { from, to } = periodBounds(cfg.period);
    const sums = useCategorySums(cfg.scope, from, to).data?.sums ?? [];
    const open = useOpenTransactions();
    const c = cfg.categoryId ? index.byId.get(cfg.categoryId) : undefined;
    if (!c) {
        return (
            <section className="panel">
                <CardHead card={card} title={CARD_LABELS.category} />
                <div className="card-ph card-body">
                    Noch keine Kategorie gewählt.
                    <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => ui.open({ kind: "cardSettings", cardId: card.id })}>
                        Kategorie wählen
                    </button>
                </div>
            </section>
        );
    }
    const of = (id: number | null) => sums.find((s) => s.categoryId === id)?.amount ?? 0;
    // A subtree's sum; bookings without a category count where "Ohne Kategorie" sits
    const sumOf = (id: number) => categorySubtree(index, id).reduce((s, x) => s + of(x), 0) + (subtreeHasNone(index, id) ? of(null) : 0);
    const total = sumOf(c.id);
    // Each child stands for its whole subtree
    const kids = childRows(index, c.id)
        .map((k) => (k === "none" ? { key: "none", name: "Ohne Kategorie", v: of(null) } : { key: String(k.id), name: k.name, v: sumOf(k.id) }))
        .filter((x) => x.v !== 0)
        .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const max = Math.max(1, ...kids.map((x) => Math.abs(x.v)));
    return (
        <section className="panel">
            <CardHead card={card} title={c.name} />
            <div className="card-body">
                <button className="grp-row" onClick={() => void open({ kind: "show", search: { cat: String(c.id), ctx: "cat" } })}>
                    <CatTile idx={index} id={c.id} size={15} />
                    <span>
                        <b>{PERIOD_LABELS[cfg.period]}</b>
                        <small>{c.name}{kids.length ? ` und Unterkategorien` : ""}</small>
                    </span>
                    <Amt cents={total} signed />
                </button>
                {kids.map(({ key, name, v }) => (
                    <div key={key} style={{ display: "grid", gap: 4, marginTop: 8 }}>
                        <div className="small" style={{ display: "flex", justifyContent: "space-between" }}>
                            <span className="muted">{name}</span>
                            <Amt cents={v} signed />
                        </div>
                        <div className="limit" style={{ maxWidth: "none", marginTop: 0 }}>
                            <span style={{ width: `${(Math.abs(v) / max) * 100}%` }} />
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
