import { Component } from "react";
import { getUi } from "../lib/ui";

interface Anchor {
    row: Element;
    top: number;
}

const onScreen = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
};

/** The booking whose details open or close when it is on screen, else the first row on screen. */
function anchorRow(): Element | undefined {
    const id = getUi().drawerTx;
    const open = document.querySelector(id !== null ? `main .tx[data-tx="${id}"]` : "main .tx.sel");
    if (open && onScreen(open)) return open;
    return [...document.querySelectorAll("main .tx")].find(onScreen);
}

/**
 * The details panel narrows the page, so the header and filters above the list can wrap and change
 * height. This holds the row in its place on screen. A class, because only
 * `getSnapshotBeforeUpdate` can read the layout from before the commit.
 */
export class KeepRowInPlace extends Component<{ inspector: boolean }> {
    override getSnapshotBeforeUpdate(prev: { inspector: boolean }): Anchor | null {
        if (prev.inspector === this.props.inspector) return null;
        const row = anchorRow();
        return row ? { row, top: row.getBoundingClientRect().top } : null;
    }

    override componentDidUpdate(_prev: unknown, _state: unknown, anchor: Anchor | null): void {
        if (!anchor?.row.isConnected) return;
        const shift = anchor.row.getBoundingClientRect().top - anchor.top;
        if (shift !== 0) window.scrollBy(0, shift);
    }

    override render() {
        return null;
    }
}
