import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownUp, BarChart3, CalendarDays, ChartColumn, ChartLine, ChartNoAxesCombined, Check, CheckCheck, ChevronDown, CircleDot, Folder, Landmark, Plus, RefreshCw, Search, Send, Tag, Trash2, Wand2, X } from "lucide-react";
import { isActive, startSync, useConnections, useSyncRuns } from "../lib/bank";
import { addDaysIso, dateBounds, groupCardNumber, groupIban, isOffline, isValidIsoDate, parseTxQuery, routes, todayIso, TxRange, type AccountScope, type Transaction, type TxDateBounds } from "@mbm/shared";
import { transactionsRoute } from "../router";
import { call } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex, useGroups, useRules, useSeries, useTransactions, useTransferAccounts } from "../lib/queries";
import { useStartTransfer } from "../lib/transfer";
import { readLocalSetting, useLocalSetting, writeLocalSetting } from "../lib/localSettings";
import { accountsInScope, categoryColor, categoryPath, categorySubtree, scopeName, sumBalance } from "../lib/tree";
import { dateText, plural } from "../lib/format";
import { withDateRange, withoutDate } from "../lib/dateQuery";
import { fieldProps, focusFirstError, type FieldErrors } from "../lib/fields";
import { catList, catParam, filterOf, isCategoryView, keepsFilters, parseTxSearch, RANGE_LABELS, txViewOf, withFilter, type TxSearch } from "../lib/search";
import { getUi, ui, useUi } from "../lib/ui";
import { Amt, Button, Empty, Kbd, Modal, NoBankAccess } from "../components/common";
import { Field } from "../components/form";
import { Ic, Sym } from "../components/icons";
import { Choice, Picker, PickerButton, StylePicker } from "../components/pickers";
import { useCategoryItems, useScopeItems } from "../components/pickItems";
import { BalanceChart } from "../components/BalanceChart";
import { CHART_STYLE_IDS, CHART_STYLES, SERIES_GROUP_IDS, SERIES_GROUPS, type ChartStyle } from "../lib/seriesGroups";
import { InfoPanel, InfoToggle } from "../components/InfoPanel";
import { QueryHelp } from "../components/QueryHelp";
import { SuggestList } from "../components/SuggestList";
import { usePeekHead } from "../lib/usePeekHead";
import { useStackedHead } from "../lib/useStackedHead";
import { useStickyBar } from "../lib/useStickyBar";
import { useSuggest } from "../lib/useSuggest";
import { TxList } from "../components/TxList";
import { SkeletonRows } from "../components/Skeleton";
import { listOrder } from "../components/rows";
import { isTyping, openBooking, overlayOpen } from "../shell/shortcuts";
import { INSPECTOR_QUERY, NARROW_QUERY, useMedia } from "../lib/media";
import { accountMenu, groupMenu } from "../lib/menus";
import { markTxs, useUnreadByAccount } from "../lib/unread";
import { MenuButton } from "../shell/Trees";

const DIR_OPTIONS: { value: TxSearch["dir"]; label: string }[] = [
    { value: "all", label: "Eingänge und Ausgaben" },
    { value: "in", label: "Eingänge" },
    { value: "out", label: "Ausgaben" },
];

const DELETED_OPTIONS: { value: "live" | "deleted"; label: string }[] = [
    { value: "live", label: "Ohne gelöschte" },
    { value: "deleted", label: "Gelöschte" },
];

/** Range of the list while neither the URL nor the kept filters of the account set one. */
const DEFAULT_RANGE: TxRange = "all";
const RANGE_CHOICES: { value: TxRange | "custom"; label: string }[] = [
    ...TxRange.options.map((value) => ({ value, label: RANGE_LABELS[value] })),
    { value: "custom", label: "Benutzerdefiniert …" },
];

export function TransactionsPage() {
    const raw = transactionsRoute.useSearch();
    return parseTxSearch(raw as Record<string, unknown>).view === "none" ? <NoView /> : <TransactionList />;
}

/** "Umsätze" without a last view (or one that is gone): ask to pick one instead of a list. */
function NoView() {
    const narrow = useMedia(NARROW_QUERY);
    const navigate = useNavigate();
    const accounts = useAccounts();
    // Without a list there is no selected booking
    useEffect(() => ui.openTx(null), []);
    return (
        <>
            <h1 className="sr-only">Umsätze</h1>
            <section className="panel list-panel" aria-label="Umsatzliste">
                {accounts.isPending ? (
                    <SkeletonRows />
                ) : (accounts.data ?? []).length === 0 ? (
                    <NoBankAccess offline />
                ) : (
                    <Empty
                        icon={Landmark}
                        title="Keine Ansicht gewählt"
                        text={`Wähle ${narrow ? "unter „Konten“" : "links"} ein Konto, eine Kontogruppe oder eine Kategorie, um die Umsätze zu sehen.`}
                        action={narrow ? <button className="btn btn-sm btn-primary" onClick={() => void navigate({ to: "/accounts" })}>Zu den Konten</button> : undefined}
                    />
                )}
            </section>
        </>
    );
}

function TransactionList() {
    const raw = transactionsRoute.useSearch();
    const search = parseTxSearch(raw as Record<string, unknown>);
    const navigate = useNavigate();
    const range: TxRange = search.range ?? DEFAULT_RANGE;
    const accounts = useAccounts().data ?? [];
    const { index } = useCategoryIndex();
    // The search text lives in memory, never in the URL (see `ui.search`)
    const searchText = useUi((s) => s.search);
    const [q, setQ] = useState(searchText);
    const [seenQ, setSeenQ] = useState(searchText);
    // Set from elsewhere (palette, rules): take it into the field
    if (searchText !== seenQ) {
        setSeenQ(searchText);
        setQ(searchText);
    }

    const qRef = useRef<HTMLInputElement>(null);
    const toolbar = useStickyBar();
    const hints = useSuggest({ value: q, onChange: setQ, inputRef: qRef });
    /** Replaces the search at once, without waiting for the typing delay. */
    const replaceSearch = (text: string) => {
        setQ(text);
        ui.setSearch(text);
    };

    // Filters per account: only a change in the filter bar is kept, never the filters an entry
    // (rule, overview, link) brings along
    const setFilters = (patch: Partial<TxSearch>) => {
        const next = parseTxSearch({ ...search, ...patch } as Record<string, unknown>);
        if (keepsFilters(next)) {
            const kept = readLocalSetting("txFilters");
            const merged = withFilter(kept, next.scope, filterOf(next));
            if (merged !== kept) writeLocalSetting("txFilters", merged);
        }
        void navigate({ to: "/transactions", search: (s) => ({ ...s, ...patch }) });
    };

    // Coming to an account without filters in the URL (bookmark, back, "/transactions") brings
    // back the ones this browser kept for it; the ways into the list bring them along already
    const keptScope = useRef<string | null>(null);
    const viewScope = keepsFilters(search) ? search.scope : null;
    const hasFilter = !!filterOf(search);
    useEffect(() => {
        if (viewScope === keptScope.current) return;
        keptScope.current = viewScope;
        const stored = viewScope === null ? undefined : readLocalSetting("txFilters")[viewScope];
        if (!hasFilter && stored) void navigate({ to: "/transactions", search: (s) => ({ ...s, ...stored }), replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewScope]);

    // "Umsätze" in the navigation returns to the last view the sidebar marks (see `txHome`)
    const view = txViewOf(search);
    useEffect(() => {
        if (view && readLocalSetting("lastTxView") !== view) writeLocalSetting("lastTxView", view);
    }, [view]);

    // Typing waits a moment before it becomes a request
    useEffect(() => {
        if (q === searchText) return;
        const t = setTimeout(() => ui.setSearch(q), 220);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q]);

    // An invalid search is not sent; the last valid one stays in effect
    const parsed = useMemo(() => parseTxQuery(searchText), [searchText]);
    const [validQ, setValidQ] = useState(parsed.ok ? searchText : "");
    if (parsed.ok && validQ !== searchText) setValidQ(searchText);
    const valid = useMemo(() => parseTxQuery(validQ), [validQ]);
    // A date condition in the search replaces the range filter
    const dateInSearch = valid.ok && valid.hasDate;
    const listRange: TxRange = dateInSearch ? "all" : range;
    // The balance chart covers the days the search can match
    const span = useMemo(() => (valid.ok && valid.hasDate ? dateBounds(valid.query) : undefined), [valid]);

    const list = useTransactions({
        scope: search.scope,
        range: listRange,
        q: validQ || undefined,
        category: search.cat,
        dir: search.dir,
        ...(search.deleted ? { deleted: "true" as const } : {}),
        limit: 20000,
    });
    const items = useMemo(() => list.data?.items ?? [], [list.data]);
    // Balance at the end of each day for the headers of the days; same request as the daily balance chart
    const series = useSeries(search.scope, 90, range, span);
    const balances = useMemo(() => new Map(series.data?.points.map((p) => [p.date, p.balance])), [series.data]);

    // ---------- Filters ----------

    const catView = isCategoryView(search);
    const rangeSet = !dateInSearch && range !== DEFAULT_RANGE;
    const filtersSet = (catView ? search.scope !== "all" : search.cat !== "all") || search.dir !== "all" || rangeSet || !!search.deleted;
    // The search counts as soon as something is typed, also a period of own choice
    const searching = q.trim() !== "" || searchText.trim() !== "";
    const [customRange, setCustomRange] = useState(false);
    // Back to the view alone: the account (or category) stays, search and filters go
    const resetAll = () => {
        if (searching) replaceSearch("");
        if (filtersSet) setFilters(catView ? { scope: undefined, dir: undefined, range: undefined, deleted: undefined } : { cat: undefined, dir: undefined, range: undefined, deleted: undefined });
    };
    const pickRange = (v: TxRange | "custom") => {
        if (v === "custom") return setCustomRange(true);
        // A preset replaces a period of own choice
        if (dateInSearch) replaceSearch(withoutDate(q));
        setFilters({ range: v });
    };
    // What narrows the list, for the empty list
    const narrowedBy = [
        searching && "Suche",
        catView ? search.scope !== "all" && "Konto" : search.cat !== "all" && "Kategorie",
        search.dir !== "all" && "Richtung",
        search.deleted && "Gelöschte",
        !dateInSearch && listRange !== "all" && `Zeitraum „${RANGE_LABELS[range]}“`,
    ].filter((x): x is string => !!x);
    const order = useMemo(() => listOrder(items), [items]);

    // ---------- Selection and keyboard ----------

    const picked = useUi((s) => s.picked);
    const drawer = useUi((s) => s.drawerTx);
    const [focus, setFocus] = useState<number | null>(null);
    const [catFor, setCatFor] = useState<number | null>(null);
    const [bulkCat, setBulkCat] = useState(false);
    const anchor = useRef<number | null>(null);
    const action = useAction();

    const panel = useMedia(INSPECTOR_QUERY);
    // The row of the open booking is the focused one, also after the details close
    const [seenDrawer, setSeenDrawer] = useState(drawer);
    if (drawer !== seenDrawer) {
        setSeenDrawer(drawer);
        if (drawer !== null) setFocus(drawer);
    }

    useEffect(() => () => ui.clearPick(), []);
    useEffect(() => ui.clearPick(), [search.scope, search.cat, validQ, search.dir, search.deleted, listRange]);

    // A new view or filter whose loaded list lacks the open booking ends its details. Within one
    // view they stay: a counter booking is not in the list, and a booking that just left it by a
    // new category still shows the offer of a rule.
    const listView = JSON.stringify([search.scope, search.cat, validQ, search.dir, search.deleted, listRange]);
    const checkedView = useRef(listView);
    useEffect(() => {
        if (!list.data || list.isPlaceholderData || checkedView.current === listView) return;
        checkedView.current = listView;
        const open = getUi().drawerTx;
        if (open !== null && !list.data.items.some((t) => t.id === open)) ui.openTx(null);
    }, [listView, list.data, list.isPlaceholderData]);

    // Picking by touch: a long press starts it, then a tap picks or unpicks; it ends with nothing picked
    const [selecting, setSelecting] = useState(false);
    if (selecting && picked.size === 0) setSelecting(false);
    const onLongPress = (tx: Transaction) => {
        if (!picked.has(tx.id)) ui.togglePick(tx.id);
        setSelecting(true);
        navigator.vibrate?.(10);
    };

    const onRowClick = (e: React.MouseEvent, tx: Transaction) => {
        if (selecting && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
            ui.togglePick(tx.id);
            return;
        }
        if (e.shiftKey && anchor.current !== null) {
            const a = order.findIndex((t) => t.id === anchor.current);
            const b = order.findIndex((t) => t.id === tx.id);
            const [from, to] = a < b ? [a, b] : [b, a];
            ui.pick([...picked, ...order.slice(from, to + 1).map((t) => t.id)]);
            return;
        }
        if (e.metaKey || e.ctrlKey) {
            ui.togglePick(tx.id);
            anchor.current = tx.id;
            return;
        }
        anchor.current = tx.id;
        setFocus(tx.id);
        ui.openTx(tx.id);
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // As an overlay the details own the keyboard; as a panel J/K switch the booking shown
            const inPanel = drawer !== null && panel;
            // Keys a tree or another control already handled are not the list's
            if (e.defaultPrevented || (e.target as Element | null)?.closest?.('[role="tree"]')) return;
            if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || overlayOpen() || (drawer !== null && !panel)) return;
            const at = focus === null ? -1 : order.findIndex((t) => t.id === focus);
            const k = e.key.toLowerCase();
            const moveTo = (t: Transaction | undefined) => {
                if (!t) return;
                setFocus(t.id);
                if (inPanel) ui.openTx(t.id);
                // A virtual list follows the focus itself
                document.querySelector(`main .txlist:not(.vlist) .tx[data-tx="${t.id}"]`)?.scrollIntoView({ block: "nearest" });
            };
            if (k === "j" || e.key === "ArrowDown") {
                e.preventDefault();
                moveTo(order[Math.min(order.length - 1, at + 1)]);
            } else if (k === "k" || e.key === "ArrowUp") {
                e.preventDefault();
                moveTo(order[Math.max(0, at - 1)]);
            } else if (e.key === "Enter" && focus !== null) {
                // Opens the booking; when it is open in the panel already, Enter moves into the panel
                if (inPanel && drawer === focus) document.querySelector<HTMLElement>(".drawer.panel")?.focus();
                else ui.openTx(focus);
            } else if (k === "x" && focus !== null) {
                ui.togglePick(focus);
                anchor.current = focus;
            } else if (k === "c") {
                e.preventDefault();
                if (picked.size) setBulkCat(true);
                else if (focus !== null) setCatFor(focus);
            } else if (e.key === "Escape" && picked.size && !inPanel) {
                ui.clearPick();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [focus, order, picked, drawer, panel]);

    const catItems = useCategoryItems({ none: true });
    // Several bookings at once: ask first, and say how many lose a category they already have
    const assignBulk = (v: string) => {
        const ids = [...picked];
        const categoryId = v === "none" ? null : Number(v);
        const target = categoryId === null ? "Ohne Kategorie" : categoryPath(index, categoryId);
        const byId = new Map(items.map((t) => [t.id, t]));
        const replaced = ids.filter((id) => {
            const t = byId.get(id);
            return !!t && t.categoryId !== null && t.categoryId !== categoryId;
        }).length;
        const one = ids.length === 1;
        const what = categoryId === null ? (one ? "verliert seine Kategorie" : "verlieren ihre Kategorie") : `${one ? "bekommt" : "bekommen"} die Kategorie „${target}“`;
        ui.confirm({
            title: `${plural(ids.length, "Umsatz", "Umsätze")} → „${target}“ zuordnen?`,
            text:
                `${one ? "Der ausgewählte Umsatz" : `Die ${ids.length} ausgewählten Umsätze`} ${what}.` +
                (replaced && categoryId !== null ? ` ${replaced === 1 ? "Einer hat" : `${replaced} haben`} schon eine andere Kategorie, sie wird ersetzt.` : ""),
            confirm: "Zuordnen",
            onConfirm: async () => {
                const ok = await action.succeeds(() => call(routes.assignCategory, { body: { ids, categoryId } }), {
                    topics: ["transactions", "categories"],
                    ok: (r) => `${plural(r.changed, "Umsatz", "Umsätze")} zugeordnet`,
                });
                if (ok) ui.clearPick();
                return ok;
            },
        });
    };

    return (
        <>
            <ContextHeader search={search} range={range} span={span} rangeLabel={dateInSearch ? "Zeitraum aus Suche" : RANGE_LABELS[range]} total={list.data?.total ?? 0} />
            <div className="toolbar" ref={toolbar}>
                <label className="search">
                    <Ic icon={Search} />
                    <input
                        id="q"
                        type="search"
                        placeholder="Gegenseite, Verwendungszweck, IBAN, Betrag oder Kategorie"
                        value={q}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="Umsätze durchsuchen"
                        aria-invalid={!parsed.ok}
                        aria-describedby={parsed.ok ? undefined : "q-error"}
                        ref={qRef}
                        {...hints.inputProps}
                        onChange={(e) => {
                            setQ(e.target.value);
                            hints.onInput();
                        }}
                        onKeyDown={(e) => {
                            if (hints.onKeyDown(e)) return;
                            // Esc: the suggestions close first, then the field is cleared, then left
                            if (e.key !== "Escape") return;
                            if (q) replaceSearch("");
                            else e.currentTarget.blur();
                        }}
                    />
                    {q && (
                        <button
                            type="button"
                            className="search-clear"
                            aria-label="Suche leeren"
                            title="Suche leeren (Esc)"
                            onClick={() => {
                                replaceSearch("");
                                qRef.current?.focus();
                            }}
                        >
                            <Ic icon={X} size={15} strokeWidth={2.2} />
                        </button>
                    )}
                    <QueryHelp />
                    <Kbd>/</Kbd>
                    <SuggestList list={hints.list} />
                </label>
                {!parsed.ok && (
                    <p id="q-error" className="hint bad" role="status">
                        {parsed.error} – die Liste zeigt das letzte gültige Ergebnis.
                    </p>
                )}
                <div className="filters" role="group" aria-label="Filter">
                    {catView ? (
                        <Removable label="Kontofilter" onClear={search.scope !== "all" ? () => setFilters({ scope: undefined }) : undefined}>
                            <AccountFilter value={search.scope} onPick={(v) => setFilters({ scope: v === "all" ? undefined : v })} />
                        </Removable>
                    ) : (
                        <Removable label="Kategoriefilter" onClear={search.cat !== "all" ? () => setFilters({ cat: undefined }) : undefined}>
                            <CategoryFilter value={search.cat} onChange={(cat) => setFilters({ cat, ctx: undefined })} />
                        </Removable>
                    )}
                    <Removable label="Richtungsfilter" onClear={search.dir !== "all" ? () => setFilters({ dir: undefined }) : undefined}>
                        <Choice
                            icon={ArrowDownUp}
                            label="Richtung"
                            options={DIR_OPTIONS}
                            value={search.dir}
                            set={search.dir !== "all"}
                            onPick={(v) => setFilters({ dir: v === "all" ? undefined : v })}
                        />
                    </Removable>
                    {/* A period of own choice is a date condition in the search; it shows in the same menu */}
                    <Removable
                        label="Zeitraumfilter"
                        onClear={dateInSearch ? () => replaceSearch(withoutDate(q)) : rangeSet ? () => setFilters({ range: undefined }) : undefined}
                    >
                        <Choice
                            icon={CalendarDays}
                            label="Zeitraum"
                            options={RANGE_CHOICES}
                            value={dateInSearch ? "custom" : range}
                            display={dateInSearch ? (span?.from && span.to ? `${dateText(span.from)} – ${dateText(span.to)}` : "Zeitraum aus der Suche") : undefined}
                            set={dateInSearch || rangeSet}
                            onPick={pickRange}
                        />
                    </Removable>
                    <Removable label="Filter „Gelöschte“" onClear={search.deleted ? () => setFilters({ deleted: undefined }) : undefined}>
                        <Choice
                            icon={Trash2}
                            label="Gelöschte Umsätze"
                            options={DELETED_OPTIONS}
                            value={search.deleted ? "deleted" : "live"}
                            set={!!search.deleted}
                            onPick={(v) => setFilters({ deleted: v === "deleted" ? true : undefined })}
                        />
                    </Removable>
                </div>
                {customRange && (
                    <CustomRangeDialog
                        initial={span?.from && span.to ? { from: span.from, to: span.to } : undefined}
                        onApply={(from, to) => replaceSearch(withDateRange(q, from, to))}
                        onClose={() => setCustomRange(false)}
                    />
                )}
            </div>
            <section className="panel list-panel" aria-label="Umsatzliste" aria-busy={list.isFetching}>
                {items.length ? (
                    <TxList
                        items={items}
                        balances={catView ? undefined : balances}
                        accounts={accounts}
                        cat={index}
                        virtual
                        focusId={focus}
                        selectedId={drawer}
                        picked={picked}
                        catOpenFor={catFor}
                        onCatOpen={setCatFor}
                        onClick={onRowClick}
                        onLongPress={onLongPress}
                    />
                ) : list.isPending ? (
                    <SkeletonRows />
                ) : accounts.length === 0 ? (
                    <NoBankAccess offline />
                ) : (
                    <Empty
                        title={searchText ? `Keine Umsätze für „${searchText}“` : search.deleted ? "Keine gelöschten Umsätze" : "Keine Umsätze mit diesen Filtern"}
                        text={
                            (narrowedBy.length ? `Die Liste ist eingeschränkt durch: ${narrowedBy.join(", ")}. ` : "") +
                            "Probiere eine andere Schreibweise, einen längeren Zeitraum oder weniger Filter. Die Suchsyntax steht hinter dem Info-Symbol im Suchfeld."
                        }
                        action={
                            filtersSet || searching ? (
                                <button className="btn btn-sm" onClick={resetAll}>
                                    {filtersSet && searching ? "Suche und Filter zurücksetzen" : searching ? "Suche leeren" : "Filter zurücksetzen"}
                                </button>
                            ) : undefined
                        }
                    />
                )}
            </section>
            <p className="hint center">
                <Kbd>J</Kbd>
                <Kbd>K</Kbd> bewegen · <Kbd>X</Kbd> oder <Kbd>⌘</Kbd>-Klick auswählen · Symbol oder <Kbd>C</Kbd> Kategorie · <Kbd>↵</Kbd> Details
            </p>
            {picked.size > 0 && (
                <div className="bulk" role="toolbar" aria-label="Auswahl">
                    <span>{picked.size} ausgewählt</span>
                    <Picker
                        open={bulkCat}
                        onOpenChange={setBulkCat}
                        items={catItems}
                        onPick={assignBulk}
                        placeholder="Kategorie suchen …"
                        trigger={
                            <button>
                                <Ic icon={Tag} size={15} />
                                Kategorie
                                <Kbd>C</Kbd>
                            </button>
                        }
                    />
                    <ReadToggle txs={order.filter((t) => picked.has(t.id))} />
                    <button onClick={() => ui.pick(order.map((t) => t.id))}>Alle</button>
                    {selecting ? (
                        <button onClick={() => ui.clearPick()}>
                            <Ic icon={Check} size={15} />
                            Fertig
                        </button>
                    ) : (
                        <button onClick={() => ui.clearPick()}>
                            <Ic icon={X} size={15} />
                            Aufheben
                        </button>
                    )}
                </div>
            )}
        </>
    );
}

/** Marks the picked bookings as read, or as new again when all of them are read. */
function ReadToggle({ txs }: { txs: Transaction[] }) {
    const anyNew = txs.some((t) => t.unread);
    return (
        <button onClick={() => void markTxs(txs, !anyNew)}>
            <Ic icon={anyNew ? CheckCheck : CircleDot} size={15} />
            {anyNew ? "Gelesen" : "Als neu"}
        </button>
    );
}

/** In the view of a category the accounts are the filter; the view stays. */
function AccountFilter({ value, onPick }: { value: AccountScope; onPick: (v: AccountScope) => void }) {
    const items = useScopeItems();
    const label = items.find((x) => x.value === value)?.label ?? "Alle Konten";
    return (
        <Picker
            items={items}
            value={value}
            onPick={(v) => onPick(v as AccountScope)}
            placeholder="Konto suchen …"
            trigger={
                <PickerButton set={value !== "all"} icon={<Ic icon={Folder} size={15} />}>
                    {label}
                </PickerButton>
            }
        />
    );
}

/** Names of the picked categories, or their number when there are more than `max`. */
function catNames(list: string[], nameOf: (v: string) => string, max: number): string {
    return list.length > max ? `${list.length} Kategorien` : list.map(nameOf).join(", ");
}

/** Several categories at once; "Alle Kategorien" clears the choice, any other item toggles. */
function CategoryFilter({ value, onChange }: { value: string; onChange: (cat: string | undefined) => void }) {
    const items = useCategoryItems({ all: true, none: true });
    const list = catList(value);
    const label = list.length ? catNames(list, (v) => items.find((x) => x.value === v)?.label ?? "?", 1) : "Alle Kategorien";
    const toggle = (v: string) => onChange(v === "all" ? undefined : catParam(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]));
    return (
        <Picker
            items={items}
            selected={list.length ? list : ["all"]}
            onPick={toggle}
            placeholder="Kategorie suchen …"
            trigger={
                <PickerButton set={list.length > 0} icon={<Ic icon={Tag} size={15} />}>
                    {label}
                </PickerButton>
            }
        />
    );
}

// ---------- Header of the selected node ----------

function ContextHeader({
    search,
    range,
    span,
    rangeLabel,
    total,
}: {
    search: TxSearch;
    range: TxRange;
    span?: TxDateBounds;
    rangeLabel: string;
    total: number;
}) {
    const groups = useGroups().data ?? [];
    const accounts = useAccounts().data ?? [];
    const { index } = useCategoryIndex();
    const rules = useRules().data ?? [];
    const action = useAction();
    const navigate = useNavigate();
    const chart = useLocalSetting("showBalanceChart");
    const setChart = (on: boolean) => writeLocalSetting("showBalanceChart", on);
    const chartGroup = useLocalSetting("balanceChartGroup");
    const chartStyle = useLocalSetting("balanceChartStyle");
    const infoOpen = useLocalSetting("showInfo");
    const toggleInfo = () => writeLocalSetting("showInfo", !infoOpen);
    const [styleOpen, setStyleOpen] = useState(false);
    const syncRuns = useSyncRuns().data;
    const connections = useConnections().data;
    const transferAccounts = useTransferAccounts().data;
    const startTransfer = useStartTransfer();
    const unreadOf = useUnreadByAccount();
    const stackedHead = useStackedHead();
    const peekHead = usePeekHead();

    // The view of one category; the filter of several always shows the account view
    if (isCategoryView(search)) {
        const none = search.cat === "none";
        const c = none ? undefined : index.byId.get(Number(search.cat));
        const top = !c || c.parentId === null;
        const ids = c ? categorySubtree(index, c.id) : [];
        const ruleN = rules.filter((r) => r.categoryId !== null && ids.includes(r.categoryId)).length;
        const kids = c ? (index.children.get(c.id) ?? []) : [];
        const color = c ? categoryColor(index, c.id) : "neutral";
        const kindName = top ? "Kategorie" : `Unterkategorie von ${categoryPath(index, c!.parentId)}`;
        return (
            <section className="hero ctx peek" ref={peekHead}>
                <HeadPeek
                    icon={c ? <Sym name={c.icon} size={13} /> : "?"}
                    color={c ? color : undefined}
                    name={none ? "Ohne Kategorie" : (c?.name ?? "")}
                >
                    <Amt cents={total} signed />
                </HeadPeek>
                <div className="ctx-top">
                    {c ? (
                        <StylePicker
                            trigger={
                                <button className={`ctx-ic tone k-${color}`} title="Symbol und Farbe ändern" aria-label="Symbol und Farbe ändern">
                                    <Sym name={c.icon} size={22} />
                                </button>
                            }
                            name={c.name}
                            kindName={kindName}
                            icon={c.icon}
                            color={c.color}
                            inheritColor={c.parentId !== null ? categoryColor(index, c.parentId) : undefined}
                            onChange={(patch) => void action.run(() => call(routes.updateCategory, { params: { id: c.id }, body: patch }), { topics: ["categories"] })}
                        />
                    ) : (
                        <span className="ctx-ic sym-none" aria-hidden="true">?</span>
                    )}
                    <div className="ctx-title">
                        <span className="label">{none ? "Umsätze" : kindName}</span>
                        <h1>{none ? "Ohne Kategorie" : c?.name}</h1>
                        <p className="muted small">
                            {rangeLabel} · {scopeName(search.scope, groups, accounts)}
                            {kids.length ? ` · ${plural(kids.length, "Unterkategorie", "Unterkategorien")}` : ""}
                            {c?.excludedFromStats ? " · zählt nicht in Auswertungen" : ""}
                        </p>
                    </div>
                    <div className="ctx-fig">
                        <span className="label">Summe</span>
                        <Amt cents={total} signed as="b" />
                    </div>
                </div>
                <div className="ctx-actions">
                    {none ? (
                        <span className="muted small">
                            Umsätze mit <Kbd>X</Kbd> auswählen und mit <Kbd>C</Kbd> zuordnen.
                        </span>
                    ) : (
                        <button className="btn btn-sm" onClick={() => void navigate({ to: "/settings", search: { tab: "rules" } })}>
                            <Ic icon={Wand2} size={14} />
                            Regeln<span className="muted">{ruleN}</span>
                        </button>
                    )}
                    {c && <InfoToggle info={c.info} open={infoOpen} onToggle={toggleInfo} />}
                </div>
                {c && infoOpen && <InfoPanel info={c.info} onEdit={() => ui.open({ kind: "info", target: "category", id: c.id })} />}
            </section>
        );
    }

    const scope = search.scope;
    const ids = accountsInScope(scope, groups, accounts);
    const account = scope.startsWith("account:") ? accounts.find((a) => a.id === Number(scope.slice(8))) : undefined;
    const group = scope.startsWith("group:") ? groups.find((g) => g.id === Number(scope.slice(6))) : undefined;
    const pendingN = ids.reduce((s, a) => s + a.pendingCount, 0);
    const pendingSum = ids.reduce((s, a) => s + a.pendingSum, 0);
    const node = account ?? group;
    const offline = !!account && isOffline(account);
    const connection = account?.connectionId != null ? connections?.find((c) => c.id === account.connectionId) : undefined;
    const bankName = connection?.bankName;
    // A group is fetched when it holds at least one bank account, in it or in a subgroup
    const bankIds = account ? (offline ? [] : [account.id]) : group ? ids.filter((a) => !isOffline(a)).map((a) => a.id) : [];
    const syncing = (syncRuns ?? []).some((r) => isActive(r) && r.accountIds.some((id) => bankIds.includes(id)));

    return (
        <section className="hero ctx peek" ref={peekHead}>
            <HeadPeek icon={node ? <Sym name={node.icon} size={13} /> : <Ic icon={Folder} size={13} />} color={node?.color} name={scopeName(scope, groups, accounts)}>
                <Amt cents={sumBalance(ids)} />
            </HeadPeek>
            <div className="ctx-top" ref={stackedHead}>
                {node ? (
                    <StylePicker
                        open={styleOpen}
                        onOpenChange={setStyleOpen}
                        trigger={
                            <button className={`ctx-ic tone k-${node.color}`} title="Symbol und Farbe ändern" aria-label="Symbol und Farbe ändern" onClick={() => setStyleOpen(true)}>
                                <Sym name={node.icon} size={22} />
                            </button>
                        }
                        name={node.name}
                        kindName={account ? (offline ? "Offline-Konto" : "Konto") : "Kontogruppe"}
                        icon={node.icon}
                        color={node.color}
                        onChange={(patch) =>
                            void action.run<unknown>(
                                () =>
                                    account
                                        ? call(routes.updateAccount, { params: { id: account.id }, body: { icon: patch.icon, color: patch.color ?? undefined } })
                                        : call(routes.updateGroup, { params: { id: group!.id }, body: { icon: patch.icon, color: patch.color ?? undefined } }),
                                { topics: ["accounts", "groups"] },
                            )
                        }
                    />
                ) : (
                    <span className="ctx-ic">
                        <Ic icon={Folder} size={22} />
                    </span>
                )}
                <div className="ctx-title">
                    <span className="label">{account ? "Konto" : group ? "Kontogruppe" : "Alle Konten"}</span>
                    <h1>{scopeName(scope, groups, accounts)}</h1>
                    {account && !offline ? (
                        <>
                            <p className="iban-line">{account.kind === "credit_card" ? (account.cardNumber ? groupCardNumber(account.cardNumber) : "Kreditkarte") : account.iban ? groupIban(account.iban) : connection?.kind === "psd2" ? "PSD2 über Enable Banking" : "Ohne IBAN"}</p>
                            {bankName && <p className="bank-line">{bankName}</p>}
                        </>
                    ) : (
                        <p className="iban-line">
                            {account ? (
                                <>
                                    Offline-Konto
                                    {!!account.openingBalance && (
                                        <>
                                            {" · "}
                                            <button className="link" title="Anfangssaldo ändern" onClick={() => ui.open({ kind: "openingBalance", accountId: account.id })}>
                                                Anfangssaldo&nbsp;<Amt cents={account.openingBalance} />
                                            </button>
                                        </>
                                    )}
                                </>
                            ) : (
                                plural(ids.length, "Konto", "Konten")
                            )}
                        </p>
                    )}
                </div>
                <div className="ctx-fig">
                    <span className="label">{account ? "Kontostand" : "Saldo"}</span>
                    <Amt cents={sumBalance(ids)} as="b" />
                    {pendingN > 0 && (
                        <small>
                            davon vorgemerkt <Amt cents={pendingSum} signed /> · {plural(pendingN, "Buchung", "Buchungen")}
                        </small>
                    )}
                </div>
            </div>
            <div className="ctx-actions">
                {account && offline && (
                    <button className="btn btn-sm btn-primary" onClick={() => openBooking(account.id)}>
                        <Ic icon={Plus} size={14} />
                        Buchung erfassen
                        <Kbd>B</Kbd>
                    </button>
                )}
                {bankIds.length > 0 && (
                    <button className="btn btn-sm" aria-busy={syncing || undefined} onClick={() => !syncing && void startSync(account ? { accountId: account.id } : { groupId: group!.id })}>
                        <Ic icon={RefreshCw} size={14} className={syncing ? "spin" : undefined} />
                        Abrufen
                    </button>
                )}
                {account && transferAccounts?.some((a) => a.id === account.id) && (
                    <button className="btn btn-sm" onClick={() => startTransfer({ accountId: account.id })}>
                        <Ic icon={Send} size={14} />
                        Überweisen
                    </button>
                )}
                {ids.length > 0 && (
                    <button className="btn btn-sm" aria-pressed={chart} onClick={() => setChart(!chart)}>
                        <Ic icon={BarChart3} size={14} />
                        Verlauf
                    </button>
                )}
                {node && <InfoToggle info={node.info} open={infoOpen} onToggle={toggleInfo} />}
                {node && (
                    <MenuButton
                        items={account ? accountMenu(account, action, () => setStyleOpen(true), undefined, unreadOf.get(account.id) ?? 0) : groupMenu(group!, action, () => setStyleOpen(true))}
                        label={account ? "Weitere Aktionen für das Konto" : "Weitere Aktionen für die Gruppe"}
                        className="btn btn-sm btn-more"
                    />
                )}
            </div>
            {chart && (
                <div className="chart-row">
                    <div className="chart-head">
                        <div className="seg" role="group" aria-label="Verlauf darstellen">
                            {CHART_STYLE_IDS.map((s) => (
                                <button key={s} className="seg-icon" aria-pressed={chartStyle === s} aria-label={CHART_STYLES[s]} title={CHART_STYLES[s]} onClick={() => writeLocalSetting("balanceChartStyle", s)}>
                                    <Ic icon={STYLE_ICON[s]} size={15} />
                                </button>
                            ))}
                        </div>
                        <div className="seg" role="group" aria-label="Verlauf gruppieren">
                            {SERIES_GROUP_IDS.map((g) => (
                                <button key={g} aria-pressed={chartGroup === g} aria-label={SERIES_GROUPS[g].label} title={SERIES_GROUPS[g].label} onClick={() => writeLocalSetting("balanceChartGroup", g)}>
                                    {SERIES_GROUPS[g].short}
                                </button>
                            ))}
                        </div>
                    </div>
                    <BalanceChart scope={scope} range={range} span={span} group={chartGroup} chartStyle={chartStyle} />
                </div>
            )}
            {node && infoOpen && <InfoPanel info={node.info} onEdit={() => ui.open({ kind: "info", target: account ? "account" : "group", id: node.id })} />}
        </section>
    );
}

/**
 * The slim bar the head leaves at the top once it has scrolled away (usePeekHead): small symbol,
 * name and figure. Hovering or tapping it brings the whole head in.
 */
function HeadPeek({ icon, color, name, children }: { icon: React.ReactNode; color?: string; name: string; children: React.ReactNode }) {
    return (
        <button type="button" className="ctx-peek" title="Kopf einblenden">
            <span className="ctx-peek-bar">
                <span className={color ? `ctx-peek-ic tone k-${color}` : "ctx-peek-ic"} aria-hidden="true">
                    {icon}
                </span>
                <span className="ctx-peek-name">{name}</span>
                <span className="ctx-peek-fig">{children}</span>
                <Ic icon={ChevronDown} size={14} />
            </span>
        </button>
    );
}

/** Symbol of each way to draw the chart in the switch above it. */
const STYLE_ICON: Record<ChartStyle, typeof ChartLine> = { bar: ChartColumn, line: ChartLine, flow: ChartNoAxesCombined };

/** A set filter with × to remove it; unset filters show the picker alone. */
function Removable({ label, onClear, children }: { label: string; onClear?: () => void; children: React.ReactNode }) {
    if (!onClear) return <>{children}</>;
    return (
        <span className="fchip">
            {children}
            <button type="button" className="fchip-x" aria-label={`${label} entfernen`} title={`${label} entfernen`} onClick={onClear}>
                <Ic icon={X} size={13} strokeWidth={2.2} />
            </button>
        </span>
    );
}

/** A period of own choice; it becomes a date condition in the search text. */
function CustomRangeDialog({ initial, onApply, onClose }: { initial?: { from: string; to: string }; onApply: (from: string, to: string) => void; onClose: () => void }) {
    const [from, setFrom] = useState(initial?.from ?? addDaysIso(todayIso(), -30));
    const [to, setTo] = useState(initial?.to ?? todayIso());
    const [errors, setErrors] = useState<FieldErrors>({});
    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        const next: FieldErrors = {
            "cr-from": isValidIsoDate(from) ? undefined : "Bitte ein Datum wählen.",
            "cr-to": !isValidIsoDate(to) ? "Bitte ein Datum wählen." : isValidIsoDate(from) && to < from ? "Das Ende liegt vor dem Anfang." : undefined,
        };
        setErrors(next);
        if (focusFirstError(next)) return;
        onApply(from, to);
        onClose();
    };
    return (
        <Modal title="Zeitraum wählen" onClose={onClose} narrow>
            <form className="form-grid" style={{ gap: 16 }} onSubmit={submit} noValidate>
                <div className="bk-row">
                    <Field id="cr-from" label="Von" error={errors["cr-from"]}>
                        <input className="inp" type="date" autoFocus value={from} onChange={(e) => setFrom(e.target.value)} {...fieldProps("cr-from", errors["cr-from"])} />
                    </Field>
                    <Field id="cr-to" label="Bis" error={errors["cr-to"]}>
                        <input className="inp" type="date" value={to} onChange={(e) => setTo(e.target.value)} {...fieldProps("cr-to", errors["cr-to"])} />
                    </Field>
                </div>
                <p className="hint">Beide Tage zählen mit. Der Zeitraum steht danach als Bedingung im Suchfeld.</p>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" icon={Check}>Übernehmen</Button>
                </div>
            </form>
        </Modal>
    );
}
