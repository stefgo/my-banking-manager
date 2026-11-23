// The list of bookings: pending ones bundled on top under "Vorgemerkt", booked ones by day.
// Long lists are virtualized against the window scroll.

import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Check } from "lucide-react";
import { routes, type Account, type Transaction } from "@mbm/shared";
import { call } from "../lib/api";
import { useAction, type useCategoryIndex } from "../lib/queries";
import { categoryColor, categoryPath, type CategoryIndex } from "../lib/tree";
import { dayMonth, fmt, fmtSigned, partyName } from "../lib/format";
import { ui } from "../lib/ui";
import { Ic, Sym } from "./icons";
import { Picker } from "./pickers";
import { useCategoryItems } from "./pickItems";
import { buildRows, type ListRow } from "./rows";


interface RowProps {
    tx: Transaction;
    idx: CategoryIndex;
    accountName?: string;
    inPending: boolean;
    focused: boolean;
    selected: boolean;
    picked: boolean;
    catOpen: boolean;
    onCatOpen: (open: boolean) => void;
    onClick: (e: React.MouseEvent, tx: Transaction) => void;
    onLongPress?: (tx: Transaction) => void;
    catItems: ReturnType<typeof useCategoryItems>;
}

/** Holding a finger still this long on a row starts picking (touch and pen only). */
const LONG_PRESS_MS = 500;

export const TxRow = memo(function TxRow({ tx, idx, accountName, inPending, focused, selected, picked, catOpen, onCatOpen, onClick, onLongPress, catItems }: RowProps) {
    const action = useAction();
    // A long press picks the row; the click that follows it must not open the details
    const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
    const endPress = () => {
        if (press.current && !press.current.fired) {
            clearTimeout(press.current.timer);
            press.current = null;
        }
    };
    const c = tx.categoryId !== null ? idx.byId.get(tx.categoryId) : undefined;
    const party = partyName(tx);
    const name = party || tx.remittance || "—";
    return (
        <div
            className={`tx ${tx.status === "pending" ? "pending" : ""} ${tx.unread ? "is-new" : ""} ${selected ? "sel" : ""} ${picked ? "is-picked" : ""} ${focused ? "focus" : ""}`}
            data-tx={tx.id}
            onClick={(e) => {
                const long = press.current?.fired;
                press.current = null;
                if (!long) onClick(e, tx);
            }}
            onPointerDown={(e) => {
                if (!onLongPress || e.pointerType === "mouse") return;
                const timer = window.setTimeout(() => {
                    if (!press.current) return;
                    press.current.fired = true;
                    onLongPress(tx);
                }, LONG_PRESS_MS);
                press.current = { timer, x: e.clientX, y: e.clientY, fired: false };
            }}
            onPointerMove={(e) => {
                const p = press.current;
                if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) endPress();
            }}
            onPointerUp={endPress}
            onPointerCancel={endPress}
            // The system menu of a long press would cover the row
            onContextMenu={(e) => press.current && e.preventDefault()}
        >
            <Picker
                open={catOpen}
                onOpenChange={onCatOpen}
                items={catItems}
                value={tx.categoryId === null ? "none" : String(tx.categoryId)}
                placeholder="Kategorie suchen …"
                onPick={(v) =>
                    void action.run(() => call(routes.assignCategory, { body: { ids: [tx.id], categoryId: v === "none" ? null : Number(v) } }), { topics: ["transactions", "categories"] })
                }
                trigger={
                    <button
                        className={`av ${c ? `k-${categoryColor(idx, c.id)}` : "none"} ${picked ? "picked" : ""}`}
                        aria-label="Kategorie wählen"
                        title={`${c ? `${categoryPath(idx, c.id)} · ` : ""}Kategorie wählen (C)`}
                        onClick={(e) => e.stopPropagation()}
                        style={c ? ({ "--c": `var(--p-${categoryColor(idx, c.id)})` } as React.CSSProperties) : undefined}
                    >
                        {picked ? <Ic icon={Check} size={16} strokeWidth={2.4} /> : c ? <Sym name={c.icon} size={17} /> : "?"}
                    </button>
                }
            />
            <span className="tx-main">
                <span className="tx-name">
                    {tx.unread && (
                        <span className="new-dot" title="Neu">
                            <span className="sr-only">Neu: </span>
                        </span>
                    )}
                    {name}
                    {tx.status === "pending" && !inPending && <span className="pill">vorgemerkt</span>}
                </span>
                <span className="tx-sub">
                    {inPending && (
                        <>
                            <span className="tx-date">{dayMonth(tx.bookingDate)}</span>
                            <span className="sep">·</span>
                        </>
                    )}
                    {c ? (
                        <span className="cchip" style={{ "--c": `var(--p-${categoryColor(idx, c.id)})` } as React.CSSProperties}>
                            <i />
                            {c.name}
                        </span>
                    ) : (
                        <span className="cchip none">
                            <i />
                            Ohne Kategorie
                        </span>
                    )}
                    {(tx.isReturn || tx.returnedById !== null) && (
                        <>
                            <span className="sep">·</span>
                            <span>{tx.isReturn ? "Rückbuchung" : "zurückgegeben"}</span>
                        </>
                    )}
                    {tx.remittance && party && (
                        <>
                            <span className="sep">·</span>
                            <span>{tx.remittance}</span>
                        </>
                    )}
                </span>
            </span>
            <span className="tx-end">
                <span className={`amt ${tx.amount > 0 ? "pos" : ""}`}>{fmtSigned(tx.amount)}</span>
                {accountName && <span className="tx-acc">{accountName}</span>}
            </span>
        </div>
    );
});

export interface TxListProps {
    items: Transaction[];
    /** Balance at the end of each day, shown in the header of the day. */
    balances?: ReadonlyMap<string, number>;
    accounts: Account[];
    cat: ReturnType<typeof useCategoryIndex>["index"];
    showAccount?: boolean;
    focusId?: number | null;
    selectedId?: number | null;
    picked?: ReadonlySet<number>;
    catOpenFor?: number | null;
    onCatOpen?: (id: number | null) => void;
    onClick?: (e: React.MouseEvent, tx: Transaction) => void;
    onLongPress?: (tx: Transaction) => void;
    virtual?: boolean;
}

export function TxList({ items, balances, accounts, cat, showAccount = true, focusId = null, selectedId = null, picked, catOpenFor = null, onCatOpen, onClick, onLongPress, virtual = false }: TxListProps) {
    const rows = useMemo(() => buildRows(items, balances), [items, balances]);
    const names = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
    const catItems = useCategoryItems({ none: true });
    const [localOpen, setLocalOpen] = useState<number | null>(null);
    const openFor = onCatOpen ? catOpenFor : localOpen;
    const setOpen = onCatOpen ?? setLocalOpen;
    const click = onClick ?? ((_e: React.MouseEvent, tx: Transaction) => ui.openTx(tx.id));

    const render = (r: ListRow) =>
        r.type === "head" ? (
            <div className={`day ${r.booked ? "booked" : ""}`}>
                <span>{r.label}</span>
                <span className="day-end">
                    <span className="amt">{fmtSigned(r.sum)}</span>
                    {r.balance !== undefined && (
                        <span className={`day-bal ${r.balance < 0 ? "neg" : ""}`} title="Saldo am Ende des Tages">
                            Saldo <span className="amt">{fmt(r.balance)}</span>
                        </span>
                    )}
                </span>
            </div>
        ) : (
            <TxRow
                tx={r.tx}
                idx={cat}
                accountName={showAccount ? names.get(r.tx.accountId) : undefined}
                inPending={r.inPending}
                focused={focusId === r.tx.id}
                selected={selectedId === r.tx.id}
                picked={picked?.has(r.tx.id) ?? false}
                catOpen={openFor === r.tx.id}
                onCatOpen={(o) => setOpen(o ? r.tx.id : null)}
                onClick={click}
                onLongPress={onLongPress}
                catItems={catItems}
            />
        );

    if (!virtual || rows.length < 150) {
        return (
            <div className="txlist">
                {rows.map((r) => (
                    <Fragment key={r.key}>{render(r)}</Fragment>
                ))}
            </div>
        );
    }
    return <VirtualRows rows={rows} render={render} focusId={focusId} />;
}

function VirtualRows({ rows, render, focusId }: { rows: ListRow[]; render: (r: ListRow) => React.ReactNode; focusId: number | null }) {
    const ref = useRef<HTMLDivElement>(null);
    const [margin, setMargin] = useState(0);
    // The content above the list changes height, for example when the details panel narrows the page
    useLayoutEffect(() => {
        const list = ref.current;
        if (!list) return;
        const update = () => setMargin(list.getBoundingClientRect().top + window.scrollY);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(list.closest("main") ?? document.body);
        return () => observer.disconnect();
    }, []);
    const v = useWindowVirtualizer({
        count: rows.length,
        estimateSize: (i) => (rows[i]!.type === "head" ? 38 : 58),
        overscan: 12,
        scrollMargin: margin,
        getItemKey: (i) => rows[i]!.key,
    });
    // Keep the focused booking in view while moving with J/K
    const focusIndex = focusId === null ? -1 : rows.findIndex((r) => r.type === "tx" && r.tx.id === focusId);
    useLayoutEffect(() => {
        if (focusIndex >= 0) v.scrollToIndex(focusIndex, { align: "auto" });
    }, [focusIndex, v]);
    return (
        <div ref={ref} className="txlist vlist" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((it) => (
                <div key={it.key} className="vrow" data-index={it.index} ref={v.measureElement} style={{ transform: `translateY(${it.start - margin}px)` }}>
                    {render(rows[it.index]!)}
                </div>
            ))}
        </div>
    );
}
