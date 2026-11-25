// Menus of accounts and groups: the same entries in the sidebar tree (right click, "…") and in
// the header of the transaction list.

import { ArrowDown, ArrowUp, CheckCheck, Coins, FileUp, FolderPlus, MoveRight, NotebookPen, Palette, Pencil, Plus, Scale, Trash2 } from "lucide-react";
import { isOffline, routes, type Account, type AccountGroup } from "@mbm/shared";
import { call } from "./api";
import type { useAction } from "./queries";
import { plural } from "./format";
import { openImport } from "./importNav";
import { createGroupAndRename } from "./treeCreate";
import { ui } from "./ui";
import { markAccountsRead } from "./unread";

export interface MenuEntry {
    label?: string;
    /** Shows a tick in front of the entry: a switch that is on. */
    checked?: boolean;
    icon?: typeof Pencil;
    danger?: boolean;
    disabled?: boolean;
    separator?: boolean;
    run?: () => void;
}

type Action = ReturnType<typeof useAction>;

/** Moving a row in its tree; `up`/`down` are missing at the ends. Only the tree passes it. */
export interface TreeOrder {
    up?: () => void;
    down?: () => void;
    moveTo: () => void;
}

/** "Nach oben", "Nach unten", "Verschieben nach …": the same in every tree and list. */
export function orderEntries(order: TreeOrder | undefined): MenuEntry[] {
    if (!order) return [];
    return [
        { separator: true },
        { label: "Nach oben", icon: ArrowUp, disabled: !order.up, run: order.up },
        { label: "Nach unten", icon: ArrowDown, disabled: !order.down, run: order.down },
        { label: "Verschieben nach …", icon: MoveRight, run: order.moveTo },
    ];
}

/** `unread`: new bookings of the account, for "Alle als gelesen markieren". */
export function accountMenu(a: Account, action: Action, openStyle: () => void, order?: TreeOrder, unread = 0): MenuEntry[] {
    const key = `account:${a.id}`;
    const offline = isOffline(a);
    return [
        { label: "Alle als gelesen markieren", icon: CheckCheck, disabled: unread === 0, run: () => void markAccountsRead(`account:${a.id}`, [a.id]) },
        { separator: true },
        { label: "Umbenennen", icon: Pencil, run: () => { ui.setEditing("acc", true); ui.setRenaming(key); } },
        { label: "Symbol und Farbe …", icon: Palette, run: openStyle },
        { label: "Infos bearbeiten …", icon: NotebookPen, run: () => ui.open({ kind: "info", target: "account", id: a.id }) },
        ...orderEntries(order),
        ...(offline
            ? [
                  ...(order ? [{ separator: true }] : []),
                  { label: "Buchung erfassen", icon: Plus, run: () => ui.open({ kind: "booking", accountId: a.id }) },
                  { label: "Saldo abgleichen", icon: Scale, run: () => ui.open({ kind: "reconcile", accountId: a.id }) },
                  { label: "Anfangssaldo ändern …", icon: Coins, run: () => ui.open({ kind: "openingBalance", accountId: a.id }) },
                  { label: "Importieren …", icon: FileUp, run: () => openImport(a.id) },
                  { separator: true },
                  {
                      label: "Konto löschen",
                      icon: Trash2,
                      danger: true,
                      run: () => confirmDeleteAccount(a, action),
                  },
              ]
            : []),
    ];
}

/** Asks before deleting an offline account with all its bookings. */
export function confirmDeleteAccount(a: Account, action: Action) {
    ui.confirm({
        title: `„${a.name}“ löschen?`,
        text: `Das Offline-Konto und ${a.transactionCount === 1 ? "seine Buchung wird" : `seine ${plural(a.transactionCount, "Buchung", "Buchungen")} werden`} gelöscht. Das lässt sich nicht rückgängig machen.`,
        confirm: "Konto löschen",
        danger: true,
        onConfirm: () => action.succeeds(() => call(routes.deleteAccount, { params: { id: a.id } }), { topics: ["accounts", "transactions", "categories"], ok: "Konto gelöscht" }),
    });
}

export function groupMenu(g: AccountGroup, action: Action, openStyle: () => void, order?: TreeOrder): MenuEntry[] {
    const key = `group:${g.id}`;
    return [
        { label: "Umbenennen", icon: Pencil, run: () => { ui.setEditing("acc", true); ui.setRenaming(key); } },
        { label: "Symbol und Farbe …", icon: Palette, run: openStyle },
        { label: "Infos bearbeiten …", icon: NotebookPen, run: () => ui.open({ kind: "info", target: "group", id: g.id }) },
        { label: "Neue Untergruppe", icon: FolderPlus, run: () => void createGroupAndRename(action, g.id) },
        ...orderEntries(order),
        { separator: true },
        {
            label: "Gruppe auflösen",
            icon: Trash2,
            danger: true,
            run: () =>
                ui.confirm({
                    title: `„${g.name}“ auflösen?`,
                    text: "Die Konten und Untergruppen rücken eine Ebene nach oben. Es geht nichts verloren.",
                    confirm: "Auflösen",
                    onConfirm: () => action.succeeds(() => call(routes.deleteGroup, { params: { id: g.id } }), { topics: ["groups", "accounts"], ok: "Gruppe aufgelöst" }),
                }),
        },
    ];
}
