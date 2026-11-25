import { useCallback } from "react";

/**
 * Ref for a bar that sticks to the top of the page: publishes its height as `--sticky-bar` on the
 * root, so the sticky day heads of the list stop below it and the page's scroll padding leaves room
 * for it. The height changes with the error line and wrapping filters.
 */
export function useStickyBar() {
    return useCallback((bar: HTMLDivElement | null) => {
        if (!bar) return;
        const root = document.documentElement.style;
        const resized = new ResizeObserver(() => root.setProperty("--sticky-bar", `${bar.offsetHeight}px`));
        resized.observe(bar);
        return () => {
            resized.disconnect();
            root.removeProperty("--sticky-bar");
        };
    }, []);
}
