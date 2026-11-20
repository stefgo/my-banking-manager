// Keyboard of the account and category trees (WAI-ARIA tree pattern, flat rows with aria-level):
// one tab stop per tree; arrows move, open and close; Enter picks; F2 renames; Shift+F10 opens the
// row's menu. Rows are elements with role="treeitem" and these data attributes:
//   data-key    "group:3", "account:5", "category:12" or "none" (no rename)
//   data-tree   "acc" or "cat" (which edit mode F2 turns on)

import { useState, type FocusEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ui } from "./ui";

const ROW = '[role="treeitem"]';

function rowsOf(tree: HTMLElement): HTMLElement[] {
    return [...tree.querySelectorAll<HTMLElement>(ROW)];
}

const level = (row: HTMLElement) => Number(row.getAttribute("aria-level") ?? 1);

/** The row to land on when tabbing into the tree: the selected one, else the first. */
function entryRow(tree: HTMLElement): HTMLElement | undefined {
    const rows = rowsOf(tree);
    return rows.find((r) => r.getAttribute("aria-selected") === "true") ?? rows[0];
}

/** Props for the element around the rows. */
export function useTreeKeys(label: string) {
    // While a row has the focus the tree itself is no tab stop, so Shift+Tab leaves the tree
    const [inside, setInside] = useState(false);
    return {
        role: "tree" as const,
        "aria-label": label,
        tabIndex: inside ? -1 : 0,
        onFocus: (e: FocusEvent<HTMLElement>) => {
            if (e.target === e.currentTarget) entryRow(e.currentTarget)?.focus();
            else if (e.target.matches(ROW)) setInside(true);
        },
        onBlur: (e: FocusEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false);
        },
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
            const row = e.target as HTMLElement;
            // Keys inside a row (rename field, buttons) belong to them
            if (!row.matches(ROW)) return;
            const rows = rowsOf(e.currentTarget);
            const i = rows.indexOf(row);
            const go = (r: HTMLElement | undefined) => {
                if (!r) return;
                e.preventDefault();
                r.focus();
            };
            const expanded = row.getAttribute("aria-expanded");
            switch (e.key) {
                case "ArrowDown":
                    return go(rows[i + 1]);
                case "ArrowUp":
                    return go(rows[i - 1]);
                case "Home":
                    return go(rows[0]);
                case "End":
                    return go(rows.at(-1));
                case "ArrowRight":
                    e.preventDefault();
                    if (expanded === "false") row.querySelector<HTMLElement>(".tw")?.click();
                    else if (expanded === "true" && rows[i + 1] && level(rows[i + 1]!) > level(row)) rows[i + 1]!.focus();
                    return;
                case "ArrowLeft": {
                    e.preventDefault();
                    if (expanded === "true") {
                        row.querySelector<HTMLElement>(".tw")?.click();
                        return;
                    }
                    const parent = rows.slice(0, i).reverse().find((r) => level(r) < level(row));
                    parent?.focus();
                    return;
                }
                case "Enter":
                case " ":
                    e.preventDefault();
                    row.click();
                    return;
                case "F2": {
                    const key = row.dataset.key;
                    const tree = row.dataset.tree as "acc" | "cat" | undefined;
                    if (!key || key === "none" || !tree) return;
                    e.preventDefault();
                    ui.setEditing(tree, true);
                    ui.setRenaming(key);
                    return;
                }
                case "F10":
                    if (!e.shiftKey) return;
                    e.preventDefault();
                    openMenu(row);
                    return;
            }
        },
    };
}

/** Opens the context menu of a row as a right click below its name would. */
function openMenu(row: HTMLElement): void {
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom - 4 }));
}

// A row's own controls; a click on them does not pick the row
const CONTROL = "button:not(.tr-name):not(.ph), [role=button], input, a:not(.tr-link)";

/**
 * Props of a row; inner controls take tabIndex -1, the row is the stop. A click anywhere on the row
 * picks it, except on its controls and in what opens from them (menus and pickers live in portals,
 * whose React events still bubble through the row).
 */
export function treeRowProps({ key, tree, level, expanded, selected, pick }: { key: string; tree: "acc" | "cat"; level: number; expanded?: boolean; selected: boolean; pick: () => void }) {
    return {
        role: "treeitem" as const,
        tabIndex: -1,
        "aria-level": level,
        "aria-expanded": expanded,
        "aria-selected": selected,
        "data-key": key,
        "data-tree": tree,
        onClick: (e: ReactMouseEvent<HTMLElement>) => {
            const target = e.target as Element;
            if (!e.currentTarget.contains(target)) return;
            const control = target.closest(CONTROL);
            if (control && e.currentTarget.contains(control)) return;
            pick();
        },
    };
}
