// Account tree and category tree. Both are edited the same way: drag & drop in edit mode, and a
// menu (button in edit mode, right click or Shift+F10 always) with the same entries for moving.
// The keyboard follows the tree pattern (lib/treeKeys.ts): the rows are the stops, not their buttons.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMenu, DropdownMenu } from "radix-ui";
import { Check, ChevronDown, GripVertical, MoreHorizontal, NotebookPen, Palette, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { routes, type Account, type AccountGroup, type AccountScope, type Category } from "@mbm/shared";
import { call } from "../lib/api";
import { useIsSyncing } from "../lib/bank";
import { useAction } from "../lib/queries";
import { readLocalSetting, useLocalSetting, writeLocalSetting } from "../lib/localSettings";
import {
    accountsInScope,
    categoryAncestors,
    categoryColor,
    categoryPath,
    categorySubtree,
    dropPosition,
    inScope,
    isInSubtree,
    MAX_INDENT,
    childRows,
    subtreeHasNone,
    sumBalance,
    type CategoryIndex,
    type TreeNode,
} from "../lib/tree";
import { isCategoryView, type TxSearch } from "../lib/search";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { ui, useUi } from "../lib/ui";
import { CatTile, Ic, Tile } from "../components/icons";
import { Amt, NewBadge } from "../components/common";
import { useUnreadByAccount } from "../lib/unread";
import { Picker, StylePicker } from "../components/pickers";
import { useCategoryItems, useScopeItems } from "../components/pickItems";
import { useCategoryMove } from "../lib/categoryMove";
import { plural } from "../lib/format";
import { createCategoryAndRename } from "../lib/treeCreate";
import { accountMenu, groupMenu, orderEntries, type MenuEntry, type TreeOrder } from "../lib/menus";
import { treeRowProps } from "../lib/treeKeys";

// ---------- Menus ----------

/**
 * After an entry ran, the menu must not hand the focus back to its trigger: Radix does that
 * asynchronously on close and would steal it from what the entry opened (e.g. the rename input,
 * which then blurs and closes at once).
 */
function useKeepFocusAfterSelect() {
    const selected = useRef(false);
    return {
        onSelected: () => {
            selected.current = true;
        },
        onCloseAutoFocus: (e: Event) => {
            if (selected.current) e.preventDefault();
            selected.current = false;
        },
    };
}

function Items({ M, items, onSelected }: { M: typeof ContextMenu | typeof DropdownMenu; items: MenuEntry[]; onSelected: () => void }) {
    return (
        <>
            {items.map((it, i) =>
                it.separator ? (
                    <M.Separator key={i} />
                ) : (
                    <M.Item
                        key={i}
                        className={it.danger ? "danger" : ""}
                        disabled={it.disabled}
                        onSelect={() => {
                            onSelected();
                            setTimeout(() => it.run?.(), 0);
                        }}
                    >
                        {it.checked !== undefined ? <Ic icon={Check} size={15} style={it.checked ? undefined : { visibility: "hidden" }} /> : it.icon && <Ic icon={it.icon} size={15} />}
                        {it.label}
                    </M.Item>
                ),
            )}
        </>
    );
}

/** Wraps a row: right click opens the menu. */
export function WithContextMenu({ items, children }: { items: MenuEntry[]; children: ReactNode }) {
    const focus = useKeepFocusAfterSelect();
    return (
        <ContextMenu.Root modal={false}>
            <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
            <ContextMenu.Portal>
                <ContextMenu.Content className="menu-content" onCloseAutoFocus={focus.onCloseAutoFocus}>
                    <Items M={ContextMenu} items={items} onSelected={focus.onSelected} />
                </ContextMenu.Content>
            </ContextMenu.Portal>
        </ContextMenu.Root>
    );
}

export function MenuButton({ items, label = "Aktionen", className = "mini", tabIndex }: { items: MenuEntry[]; label?: string; className?: string; tabIndex?: number }) {
    const focus = useKeepFocusAfterSelect();
    return (
        <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger className={className} aria-label={label} title={label} tabIndex={tabIndex}>
                <Ic icon={MoreHorizontal} size={16} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu-content" align="end" sideOffset={4} onCloseAutoFocus={focus.onCloseAutoFocus}>
                    <Items M={DropdownMenu} items={items} onSelected={focus.onSelected} />
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

// ---------- Inline rename ----------

function RenameInput({ value, onSave }: { value: string; onSave: (name: string) => void }) {
    const [v, setV] = useState(value);
    const done = (save: boolean) => {
        ui.setRenaming(null);
        if (save && v.trim() && v.trim() !== value) onSave(v.trim());
    };
    return (
        <input
            className="rename"
            value={v}
            aria-label="Name"
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setV(e.target.value)}
            onBlur={() => done(true)}
            onKeyDown={(e) => {
                if (e.key === "Enter") done(true);
                if (e.key === "Escape") done(false);
            }}
        />
    );
}

// ---------- Drag & drop ----------

/** `none` is the row "Ohne Kategorie" (id 0). */
type DragNode = { kind: "group" | "account" | "category" | "none"; id: number; parentId: number | null; index: number; hasChildren?: boolean };

// Browsers hide the drag data during dragover; rows that know what is dragged mark it here
let dragging: DragNode | null = null;

function startDrag(e: React.DragEvent<HTMLElement>, type: "acc" | "cat", node: DragNode) {
    e.dataTransfer.setData(`mbm/${type}`, JSON.stringify(node));
    dragging = node;
}

const endDrag = () => {
    dragging = null;
};

/**
 * Drop target of a tree row. `canInto` decides about dropping into the row, `canBeside`
 * about dropping before or after it; both get the dragged node.
 */
function useDrop(
    type: "acc" | "cat",
    canInto: (n: DragNode) => boolean,
    onDrop: (n: DragNode, pos: "into" | "before" | "after") => void,
    canBeside: (n: DragNode) => boolean = () => true,
) {
    const [pos, setPos] = useState<"into" | "before" | "after" | null>(null);
    return {
        cls: pos === "into" ? "drop-into" : pos === "before" ? "drop-before" : "",
        handlers: {
            onDragOver: (e: React.DragEvent<HTMLElement>) => {
                if (!e.dataTransfer.types.includes(`mbm/${type}`)) return;
                // Without a known node, allow "into" when the row can take children; the drop checks again
                const n = dragging ?? { kind: "group", id: 0, parentId: null, index: 0 };
                const r = e.currentTarget.getBoundingClientRect();
                const p = dropPosition(e.clientY - r.top, r.height, canInto(n));
                if (p !== "into" && !canBeside(n)) {
                    setPos(null);
                    return;
                }
                e.preventDefault();
                setPos(p);
            },
            onDragLeave: () => setPos(null),
            onDrop: (e: React.DragEvent<HTMLElement>) => {
                const p = pos;
                setPos(null);
                const raw = e.dataTransfer.getData(`mbm/${type}`);
                if (!raw || !p) return;
                e.preventDefault();
                const n = JSON.parse(raw) as DragNode;
                if (p === "into" ? !canInto(n) : !canBeside(n)) return;
                onDrop(n, p);
            },
        },
    };
}

/** Index in the target parent's order after the node was taken out of its old place. */
function targetIndex(n: DragNode, parentId: number | null, index: number, pos: "before" | "after"): number {
    let i = pos === "before" ? index : index + 1;
    if (n.parentId === parentId && n.index < i) i--;
    return i;
}

// ---------- Account tree ----------

/** Shown on a row while a fetch updates its account. */
function SyncingMark({ label }: { label: string }) {
    return (
        <span className="tr-sync" title={label}>
            <Ic icon={RefreshCw} size={13} className="spin" />
            <span className="sr-only">{label}</span>
        </span>
    );
}

export function AccountTreeRows({
    nodes,
    depth,
    groups,
    accounts,
    search,
    parentId = null,
}: {
    nodes: TreeNode[];
    depth: number;
    groups: AccountGroup[];
    accounts: Account[];
    search: TxSearch;
    parentId?: number | null;
}) {
    return (
        <>
            {nodes.map((n, i) =>
                n.kind === "group" ? (
                    <GroupRow key={`g${n.group.id}`} node={n} depth={depth} index={i} count={nodes.length} parentId={parentId} groups={groups} accounts={accounts} search={search} />
                ) : (
                    <AccountRow key={`a${n.account.id}`} account={n.account} depth={depth} index={i} count={nodes.length} parentId={parentId} groups={groups} accounts={accounts} search={search} />
                ),
            )}
        </>
    );
}

/** The category picked in the sidebar; one set by the filter of the transaction view is not marked. */
function sidebarCategory(search: TxSearch): string {
    return isCategoryView(search) ? search.cat : "all";
}

/** The accounts picked in the sidebar; in the view of a category they are a filter and not marked. */
function sidebarScope(search: TxSearch): AccountScope {
    return isCategoryView(search) ? "all" : search.scope;
}

/** Picking an account clears the category and vice versa; the search stays (see `txEntry`). */
function useSelect() {
    const open = useOpenTransactions();
    return {
        account: (scope: AccountScope) => void open({ kind: "account", scope }),
        category: (cat: string) => void open({ kind: "category", cat }),
    };
}

/** Moving a group or an account: one step among its siblings, or into another group. */
function useTreeOrder(kind: "group" | "account", id: number, parentId: number | null, index: number, count: number, openMoveTo: () => void): TreeOrder {
    const action = useAction();
    const to = (i: number) => () => void action.run(() => call(routes.moveTreeNode, { body: { kind, id, parentId, index: i } }), { topics: ["groups", "accounts"] });
    return { up: index > 0 ? to(index - 1) : undefined, down: index < count - 1 ? to(index + 1) : undefined, moveTo: openMoveTo };
}

function GroupRow({ node, depth, index, count, parentId, groups, accounts, search }: {
    node: Extract<TreeNode, { kind: "group" }>;
    depth: number;
    index: number;
    count: number;
    parentId: number | null;
    groups: AccountGroup[];
    accounts: Account[];
    search: TxSearch;
}) {
    const g = node.group;
    const key = `group:${g.id}` as AccountScope;
    const editing = useUi((s) => s.editing.acc);
    const renaming = useUi((s) => s.renaming === key);
    const collapsedGroups = useLocalSetting("collapsedGroups");
    const collapsed = collapsedGroups.includes(g.id);
    const [styleOpen, setStyleOpen] = useState(false);
    const select = useSelect();
    const action = useAction();
    const move = (n: DragNode, pos: "into" | "before" | "after") => {
        const body = pos === "into"
            ? { kind: n.kind as "group" | "account", id: n.id, parentId: g.id, index: 9999 }
            : { kind: n.kind as "group" | "account", id: n.id, parentId, index: targetIndex(n, parentId, index, pos) };
        if (n.kind === "group" && n.id === g.id) return;
        void action.run(() => call(routes.moveTreeNode, { body }), { topics: ["groups", "accounts"] });
    };
    const drop = useDrop("acc", () => true, move);
    const toggle = () => {
        writeLocalSetting("collapsedGroups", collapsed ? collapsedGroups.filter((x) => x !== g.id) : [...collapsedGroups, g.id]);
    };
    const [moveOpen, setMoveOpen] = useState(false);
    const order = useTreeOrder("group", g.id, parentId, index, count, () => setMoveOpen(true));
    const items = groupMenu(g, action, () => setStyleOpen(true), order);
    const picked = sidebarScope(search);
    const current = picked === key;
    // A closed group stands in for the accounts it hides
    const syncing = useIsSyncing(collapsed ? accountsInScope(key, groups, accounts).map((x) => x.id) : []);
    return (
        <>
            <WithContextMenu items={items}>
                <div
                    {...treeRowProps({ key, tree: "acc", level: depth + 1, expanded: !collapsed, selected: current, pick: () => select.account(key) })}
                    className={`tr tr-g ${editing ? "edit" : ""} ${current ? "current" : inScope(key, picked, groups, accounts) ? "inscope" : ""} ${drop.cls}`}
                    style={{ "--d": Math.min(depth, MAX_INDENT) } as React.CSSProperties}
                    draggable={editing && !renaming}
                    onDragStart={(e) => e.dataTransfer.setData("mbm/acc", JSON.stringify({ kind: "group", id: g.id, parentId, index } satisfies DragNode))}
                    {...(editing ? drop.handlers : {})}
                >
                    {editing && <span className="grip" aria-hidden="true"><Ic icon={GripVertical} size={14} /></span>}
                    <span className="tr-main">
                        <button className="tw" aria-expanded={!collapsed} aria-label="Auf- oder zuklappen" onClick={toggle} tabIndex={-1}>
                            <Ic icon={ChevronDown} size={14} />
                        </button>
                        <StylePicker
                            side="right"
                            open={styleOpen}
                            onOpenChange={setStyleOpen}
                            trigger={<span role="button" tabIndex={-1} style={{ display: "grid" }}><Tile icon={g.icon} color={g.color} /></span>}
                            name={g.name}
                            kindName="Kontogruppe"
                            icon={g.icon}
                            color={g.color}
                            onChange={(patch) => void action.run(() => call(routes.updateGroup, { params: { id: g.id }, body: { icon: patch.icon, color: patch.color ?? undefined } }), { topics: ["groups"] })}
                        />
                        {renaming ? (
                            <RenameInput value={g.name} onSave={(name) => void action.run(() => call(routes.updateGroup, { params: { id: g.id }, body: { name } }), { topics: ["groups"] })} />
                        ) : (
                            <button className="tr-name" tabIndex={-1} onDoubleClick={() => editing && ui.setRenaming(key)}>
                                {g.name}
                            </button>
                        )}
                    </span>
                    <span className="tr-end">
                        {syncing && <SyncingMark label="Konten werden aktualisiert" />}
                        <Amt cents={sumBalance(accountsInScope(key, groups, accounts))} className="tr-sum" />
                        {moveOpen && <MoveTreePicker kind="group" id={g.id} name={g.name} parentId={parentId} groups={groups} onClose={() => setMoveOpen(false)} />}
                        {editing && <MenuButton items={items} tabIndex={-1} />}
                    </span>
                </div>
            </WithContextMenu>
            {!collapsed && <AccountTreeRows nodes={node.children} depth={depth + 1} groups={groups} accounts={accounts} search={search} parentId={g.id} />}
        </>
    );
}

function AccountRow({ account: a, depth, index, count, parentId, groups, accounts, search }: {
    account: Account;
    depth: number;
    index: number;
    count: number;
    parentId: number | null;
    groups: AccountGroup[];
    accounts: Account[];
    search: TxSearch;
}) {
    const key = `account:${a.id}` as AccountScope;
    const editing = useUi((s) => s.editing.acc);
    const renaming = useUi((s) => s.renaming === key);
    const [styleOpen, setStyleOpen] = useState(false);
    const select = useSelect();
    const action = useAction();
    const drop = useDrop("acc", () => false, (n, pos) => {
        if (n.kind === "account" && n.id === a.id) return;
        void action.run(() => call(routes.moveTreeNode, { body: { kind: n.kind as "group" | "account", id: n.id, parentId, index: targetIndex(n, parentId, index, pos === "into" ? "after" : pos) } }), {
            topics: ["groups", "accounts"],
        });
    });
    const [moveOpen, setMoveOpen] = useState(false);
    const order = useTreeOrder("account", a.id, parentId, index, count, () => setMoveOpen(true));
    // New bookings: on accounts only, never on groups
    const unread = useUnreadByAccount().get(a.id) ?? 0;
    const syncing = useIsSyncing([a.id]);
    const items = accountMenu(a, action, () => setStyleOpen(true), order, unread);
    const picked = sidebarScope(search);
    return (
        <WithContextMenu items={items}>
            <div
                {...treeRowProps({ key, tree: "acc", level: depth + 1, selected: picked === key, pick: () => select.account(key) })}
                className={`tr tr-a ${editing ? "edit" : ""} ${picked === key ? "current" : inScope(key, picked, groups, accounts) ? "inscope" : ""} ${drop.cls}`}
                style={{ "--d": Math.min(depth, MAX_INDENT) } as React.CSSProperties}
                draggable={editing && !renaming}
                onDragStart={(e) => e.dataTransfer.setData("mbm/acc", JSON.stringify({ kind: "account", id: a.id, parentId, index } satisfies DragNode))}
                {...(editing ? drop.handlers : {})}
            >
                {editing && <span className="grip" aria-hidden="true"><Ic icon={GripVertical} size={14} /></span>}
                <span className="tr-main">
                    {/* With groups around, the symbol lines up with theirs behind the toggle */}
                    {groups.length > 0 && <span className="tw ph" aria-hidden="true" />}
                    <StylePicker
                        side="right"
                        open={styleOpen}
                        onOpenChange={setStyleOpen}
                        trigger={<span role="button" tabIndex={-1} title={a.kind === "offline" ? "Offline-Konto, ohne Abruf" : undefined} style={{ display: "grid" }}><Tile icon={a.icon} color={a.color} /></span>}
                        name={a.name}
                        kindName={a.kind === "offline" ? "Offline-Konto" : "Konto"}
                        icon={a.icon}
                        color={a.color}
                        onChange={(patch) => void action.run(() => call(routes.updateAccount, { params: { id: a.id }, body: { icon: patch.icon, color: patch.color ?? undefined } }), { topics: ["accounts"] })}
                    />
                    {renaming ? (
                        <RenameInput value={a.name} onSave={(name) => void action.run(() => call(routes.updateAccount, { params: { id: a.id }, body: { name } }), { topics: ["accounts"] })} />
                    ) : (
                        <a
                            className="tr-link"
                            href="/transactions"
                            tabIndex={-1}
                            draggable={false}
                            // The row picks the account
                            onClick={(e) => e.preventDefault()}
                        >
                            <span className="tr-txt">
                                <b>{a.name}</b>
                            </span>
                        </a>
                    )}
                </span>
                <span className="tr-end">
                    {syncing && <SyncingMark label="Konto wird aktualisiert" />}
                    {!editing && <NewBadge count={unread} />}
                    <Amt cents={a.balance} />
                    {moveOpen && <MoveTreePicker kind="account" id={a.id} name={a.name} parentId={parentId} groups={groups} onClose={() => setMoveOpen(false)} />}
                    {editing && <MenuButton items={items} tabIndex={-1} />}
                </span>
            </div>
        </WithContextMenu>
    );
}

// ---------- Category tree ----------

export function CategoryTreeRows({ index, search }: { index: CategoryIndex; search: TxSearch; onChange?: () => void }) {
    return <CategoryLevel idx={index} parentId={null} depth={0} search={search} />;
}

/** The rows below a parent (`null` = top level); `position` counts "Ohne Kategorie" where it sits. */
function CategoryLevel({ idx, parentId, depth, search }: { idx: CategoryIndex; parentId: number | null; depth: number; search: TxSearch }) {
    return (
        <>
            {childRows(idx, parentId).map((r, i, all) =>
                r === "none" ? (
                    <UncategorizedRow key="none" idx={idx} depth={depth} position={i} search={search} />
                ) : (
                    <CategoryRow key={r.id} c={r} idx={idx} depth={depth} position={i} count={all.length} search={search} />
                ),
            )}
        </>
    );
}

/**
 * "Ohne Kategorie": no real category, but it has a place in the tree. Below a category its
 * bookings belong to that category like a subcategory's.
 */
function UncategorizedRow({ idx, depth, position, search }: { idx: CategoryIndex; depth: number; position: number; search: TxSearch }) {
    const editing = useUi((s) => s.editing.cat);
    const select = useSelect();
    const moves = useCategoryMove();
    const parentId = idx.none.parentId;
    // Categories beside it, but never into their own subtree
    const drop = useDrop(
        "cat",
        () => false,
        (n, pos) => {
            if (n.kind === "none") return;
            void moves.category(n.id, parentId, targetIndex(n, parentId, position, pos === "before" ? "before" : "after"));
        },
        (n) => n.kind !== "none" && (parentId === null || !isInSubtree(idx, n.id, parentId)),
    );
    const picked = sidebarCategory(search);
    const inSelected = /^\d+$/.test(picked) && subtreeHasNone(idx, Number(picked));
    return (
        <div
            {...treeRowProps({ key: "none", tree: "cat", level: depth + 1, selected: picked === "none", pick: () => select.category("none") })}
            className={`tr tr-c ${editing ? "edit" : ""} ${picked === "none" ? "current" : inSelected ? "inscope" : ""} ${drop.cls}`}
            style={{ "--d": Math.min(depth, MAX_INDENT) } as React.CSSProperties}
            draggable={editing}
            onDragStart={(e) => startDrag(e, "cat", { kind: "none", id: 0, parentId, index: position })}
            onDragEnd={endDrag}
            {...(editing ? drop.handlers : {})}
        >
            {editing && <span className="grip" aria-hidden="true"><Ic icon={GripVertical} size={14} /></span>}
            <span className="tr-main">
                <span className="tw ph" aria-hidden="true" />
                <CatTile idx={idx} id={null} />
                <button className="tr-name" tabIndex={-1}>
                    Ohne Kategorie
                </button>
            </span>
            <span className="tr-end" />
        </div>
    );
}

function CategoryRow({ c, idx, depth, position, count, search }: { c: Category; idx: CategoryIndex; depth: number; position: number; count: number; search: TxSearch }) {
    const key = `category:${c.id}`;
    const top = c.parentId === null;
    const kids = idx.children.get(c.id) ?? [];
    // "Ohne Kategorie" below it also makes it unfold
    const hasRows = kids.length > 0 || idx.none.parentId === c.id;
    const editing = useUi((s) => s.editing.cat);
    const renaming = useUi((s) => s.renaming === key);
    const expanded = useLocalSetting("expandedCategories");
    const open = expanded.includes(c.id);
    const [styleOpen, setStyleOpen] = useState(false);
    const [moveOpen, setMoveOpen] = useState(false);
    const select = useSelect();
    const action = useAction();
    const moves = useCategoryMove();
    const toggle = () => writeLocalSetting("expandedCategories", open ? expanded.filter((x) => x !== c.id) : [...expanded, c.id]);
    // Never into the dragged category's own subtree; "Ohne Kategorie" anywhere
    const drop = useDrop(
        "cat",
        (n) => n.kind === "none" || !isInSubtree(idx, n.id, c.id),
        (n, pos) => {
            if (n.kind !== "none" && n.id === c.id) return;
            const [parentId, index] = pos === "into" ? [c.id, 9999] : [c.parentId, targetIndex(n, c.parentId, position, pos)];
            void (n.kind === "none" ? moves.none(parentId, index) : moves.category(n.id, parentId, index));
            // Show where the dropped row went
            if (pos === "into" && !open) toggle();
        },
        (n) => n.kind === "none" || c.parentId === null || !isInSubtree(idx, n.id, c.parentId),
    );
    const subtree = categorySubtree(idx, c.id);
    const parentPath = c.parentId !== null ? categoryPath(idx, c.parentId) : "";
    const kindName = top ? "Kategorie" : `Unterkategorie von ${parentPath}`;
    const items: MenuEntry[] = [
        { label: "Umbenennen", icon: Pencil, run: () => { ui.setEditing("cat", true); ui.setRenaming(key); } },
        { label: "Symbol und Farbe …", icon: Palette, run: () => setStyleOpen(true) },
        { label: "Infos bearbeiten …", icon: NotebookPen, run: () => ui.open({ kind: "info", target: "category", id: c.id }) },
        { label: "Neue Unterkategorie", icon: Plus, run: () => void createCategoryAndRename(action, c.id) },
        ...orderEntries({
            up: position > 0 ? () => void moves.category(c.id, c.parentId, position - 1) : undefined,
            down: position < count - 1 ? () => void moves.category(c.id, c.parentId, position + 1) : undefined,
            moveTo: () => setMoveOpen(true),
        }),
        { separator: true },
        {
            label: "Zählt in Auswertungen",
            checked: !c.excludedFromStats,
            run: () =>
                void action.run(() => call(routes.updateCategory, { params: { id: c.id }, body: { excludedFromStats: !c.excludedFromStats } }), {
                    topics: ["categories", "transactions"],
                    ok: c.excludedFromStats ? `„${c.name}“ zählt wieder in Auswertungen` : `„${c.name}“ zählt nicht mehr in Auswertungen`,
                }),
        },
        {
            label: "Vorbelegung für Gegenbuchungen",
            checked: c.counterDefault,
            run: () =>
                void action.run(() => call(routes.updateCategory, { params: { id: c.id }, body: { counterDefault: !c.counterDefault } }), {
                    topics: ["categories"],
                    ok: c.counterDefault ? "Gegenbuchungen haben keine Vorbelegung mehr" : `Gegenbuchungen sind mit „${c.name}“ vorbelegt`,
                }),
        },
        { separator: true },
        {
            label: "Löschen",
            icon: Trash2,
            danger: true,
            run: () => {
                const n = subtree.reduce((s, id) => s + (idx.byId.get(id)?.count ?? 0), 0);
                const below = subtree.length - 1;
                const also = below ? ` ${below === 1 ? "Die Unterkategorie wird" : `Die ${below} Unterkategorien werden`} mit gelöscht.` : "";
                const target = c.parentId;
                ui.confirm({
                    title: `„${c.name}“ löschen?`,
                    text: `${n ? `${plural(n, "Umsatz", "Umsätze")} ${target ? `${n === 1 ? "wandert" : "wandern"} in „${parentPath}“` : `${n === 1 ? "verliert seine" : "verlieren ihre"} Kategorie`}.` : "Die Kategorie hat keine Umsätze."}${also} Das lässt sich nicht rückgängig machen.`,
                    confirm: "Löschen",
                    danger: true,
                    onConfirm: () =>
                        action.succeeds(() => call(routes.deleteCategory, { params: { id: c.id }, query: { moveTo: target ?? undefined } }), {
                            topics: ["categories", "transactions", "rules"],
                            ok: "Kategorie gelöscht",
                        }),
                });
            },
        },
    ];
    const parentColor = c.parentId !== null ? categoryColor(idx, c.parentId) : undefined;
    const picked = sidebarCategory(search);
    const inSelected = picked !== String(c.id) && categoryAncestors(idx, c.id).some((a) => picked === String(a.id));
    return (
        <>
            <WithContextMenu items={items}>
                <div
                    {...treeRowProps({ key, tree: "cat", level: depth + 1, expanded: hasRows ? open : undefined, selected: picked === String(c.id), pick: () => select.category(String(c.id)) })}
                    className={`tr tr-c ${editing ? "edit" : ""} ${picked === String(c.id) ? "current" : inSelected ? "inscope" : ""} ${drop.cls}`}
                    style={{ "--d": Math.min(depth, MAX_INDENT) } as React.CSSProperties}
                    draggable={editing && !renaming}
                    onDragStart={(e) => startDrag(e, "cat", { kind: "category", id: c.id, parentId: c.parentId, index: position, hasChildren: kids.length > 0 })}
                    onDragEnd={endDrag}
                    {...(editing ? drop.handlers : {})}
                >
                    {editing && <span className="grip" aria-hidden="true"><Ic icon={GripVertical} size={14} /></span>}
                    <span className="tr-main">
                        <button className={`tw ${hasRows ? "" : "ph"}`} aria-expanded={open} aria-label="Auf- oder zuklappen" onClick={hasRows ? toggle : undefined} tabIndex={-1}>
                            <Ic icon={ChevronDown} size={14} />
                        </button>
                        <StylePicker
                            side="right"
                            open={styleOpen}
                            onOpenChange={setStyleOpen}
                            trigger={<span role="button" tabIndex={-1} style={{ display: "grid" }}><CatTile idx={idx} id={c.id} /></span>}
                            name={c.name}
                            kindName={kindName}
                            icon={c.icon}
                            color={c.color}
                            inheritColor={parentColor}
                            onChange={(patch) => void action.run(() => call(routes.updateCategory, { params: { id: c.id }, body: patch }), { topics: ["categories"] })}
                        />
                        {renaming ? (
                            <RenameInput value={c.name} onSave={(name) => void action.run(() => call(routes.updateCategory, { params: { id: c.id }, body: { name } }), { topics: ["categories"] })} />
                        ) : (
                            <button className="tr-name" tabIndex={-1} onDoubleClick={() => editing && ui.setRenaming(key)}>
                                {c.name}
                            </button>
                        )}
                    </span>
                    <span className="tr-end">
                        {moveOpen && <MoveCategoryPicker c={c} idx={idx} onClose={() => setMoveOpen(false)} onPick={(parentId) => void moves.category(c.id, parentId, 9999)} />}
                        {editing && <MenuButton items={items} tabIndex={-1} />}
                    </span>
                </div>
            </WithContextMenu>
            {open && <CategoryLevel idx={idx} parentId={c.id} depth={depth + 1} search={search} />}
        </>
    );
}

/** Picks the new parent of a category: the top level or any category outside its own subtree. */
function MoveCategoryPicker({ c, idx, onClose, onPick }: { c: Category; idx: CategoryIndex; onClose: () => void; onPick: (parentId: number | null) => void }) {
    const all = useCategoryItems();
    const items = useMemo(
        () => [
            { value: "top", label: "Oberste Ebene (Hauptkategorie)", top: true },
            ...all.filter((x) => {
                const t = idx.byId.get(Number(x.value));
                return !!t && !isInSubtree(idx, c.id, t.id);
            }),
        ],
        [all, idx, c.id],
    );
    return (
        <Picker
            open
            onOpenChange={(o) => !o && onClose()}
            trigger={<span className="move-anchor" aria-hidden="true" />}
            items={items}
            value={c.parentId === null ? "top" : String(c.parentId)}
            placeholder={`„${c.name}“ verschieben nach …`}
            onPick={(v) => {
                const parentId = v === "top" ? null : Number(v);
                if (parentId !== c.parentId) onPick(parentId);
            }}
        />
    );
}

/** Is group `id` the group `root` or below it? */
function groupInSubtree(groups: AccountGroup[], id: number, root: number): boolean {
    for (let g: number | null = id; g !== null; g = groups.find((x) => x.id === g)?.parentId ?? null) if (g === root) return true;
    return false;
}

/** Picks the new group of a group or account: the top level or any group outside its own subtree. */
function MoveTreePicker({ kind, id, name, parentId, groups, onClose }: { kind: "group" | "account"; id: number; name: string; parentId: number | null; groups: AccountGroup[]; onClose: () => void }) {
    const scope = useScopeItems(false);
    const action = useAction();
    const items = useMemo(
        () => [
            { value: "top", label: "Oberste Ebene", top: true },
            ...scope.filter((x) => x.value.startsWith("group:") && !(kind === "group" && groupInSubtree(groups, Number(x.value.slice(6)), id))),
        ],
        [scope, groups, kind, id],
    );
    return (
        <Picker
            open
            onOpenChange={(o) => !o && onClose()}
            trigger={<span className="move-anchor" aria-hidden="true" />}
            items={items}
            value={parentId === null ? "top" : `group:${parentId}`}
            placeholder={`„${name}“ verschieben nach …`}
            onPick={(v) => {
                const target = v === "top" ? null : Number(v.slice(6));
                if (target === parentId) return;
                void action.run(() => call(routes.moveTreeNode, { body: { kind, id, parentId: target, index: 9999 } }), { topics: ["groups", "accounts"] });
                // Show where it went
                if (target !== null) writeLocalSetting("collapsedGroups", readLocalSetting("collapsedGroups").filter((x) => x !== target));
            }}
        />
    );
}
