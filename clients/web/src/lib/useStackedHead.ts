import { useCallback } from "react";

/**
 * Ref for the head of an account: sets `data-stacked` while its `.iban-line` does not fit on one
 * line in the regular layout. Whether it fits depends on the length of the IBAN and the width of
 * the balance, so no fixed breakpoint can tell. Each check measures the regular layout; observers
 * run before paint, so the switch does not flicker.
 */
export function useStackedHead() {
    return useCallback((head: HTMLDivElement | null) => {
        if (!head) return;
        const measure = () => {
            delete head.dataset.stacked;
            const line = head.querySelector<HTMLElement>(".iban-line");
            if (line && line.scrollWidth > line.clientWidth) head.dataset.stacked = "";
        };
        // The switch changes the height only; reacting to that would measure in a loop
        let width = head.clientWidth;
        const resized = new ResizeObserver(() => {
            if (head.clientWidth === width) return;
            width = head.clientWidth;
            measure();
        });
        const changed = new MutationObserver(measure);
        let active = true;

        measure();
        resized.observe(head);
        changed.observe(head, { childList: true, characterData: true, subtree: true });
        void document.fonts.ready.then(() => {
            if (active) measure();
        });
        return () => {
            active = false;
            resized.disconnect();
            changed.disconnect();
        };
    }, []);
}
