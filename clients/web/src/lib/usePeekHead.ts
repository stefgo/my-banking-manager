import { useCallback } from "react";

/** Height of the slim bar that stays of the head once it has scrolled away. */
const PEEK = 34;
/** Scrolling this far closes a head opened by a tap. */
const CLOSE_AFTER = 24;

/**
 * Ref for the head of the transaction list. The head sticks with a negative `top`, so only its
 * last `--ctx-peek` pixels stay in view, where the `.ctx-peek` bar covers it. The ref publishes
 * the head's height as `--ctx-h`, the bar's height as `--ctx-peek` on the root (the search bar and
 * the day heads stop below it), and sets `data-stuck` while the head is stuck.
 *
 * Hovering, keyboard focus or an open menu bring the whole head in (CSS). A tap on the bar sets
 * `data-open` for devices without hover; scrolling, a tap elsewhere and Esc take it away again.
 */
export function usePeekHead() {
    return useCallback((head: HTMLElement | null) => {
        if (!head) return;
        const root = document.documentElement.style;
        root.setProperty("--ctx-peek", `${PEEK}px`);

        let openedAt = 0;
        const close = () => delete head.dataset.open;
        const check = () => {
            const style = getComputedStyle(head);
            const top = parseFloat(style.top) || 0;
            // The open head slides down by a transform; its place in the layout is without it
            const shift = style.transform === "none" ? 0 : new DOMMatrix(style.transform).m42;
            const stuck = head.getBoundingClientRect().top - shift <= top + 0.5;
            if (stuck) head.dataset.stuck = "";
            else {
                delete head.dataset.stuck;
                close();
            }
            if (head.dataset.open !== undefined && Math.abs(window.scrollY - openedAt) > CLOSE_AFTER) close();
        };
        const resized = new ResizeObserver(() => {
            head.style.setProperty("--ctx-h", `${head.offsetHeight}px`);
            check();
        });
        const onClick = (e: MouseEvent) => {
            if (!(e.target as Element).closest(".ctx-peek")) return;
            if (head.dataset.open !== undefined) close();
            else {
                head.dataset.open = "";
                openedAt = window.scrollY;
            }
        };
        const onPointerDown = (e: PointerEvent) => {
            if (head.dataset.open !== undefined && !head.contains(e.target as Node)) close();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") close();
        };

        resized.observe(head);
        window.addEventListener("scroll", check, { passive: true });
        window.addEventListener("resize", check);
        head.addEventListener("click", onClick);
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKey);
        return () => {
            resized.disconnect();
            window.removeEventListener("scroll", check);
            window.removeEventListener("resize", check);
            head.removeEventListener("click", onClick);
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKey);
            root.removeProperty("--ctx-peek");
        };
    }, []);
}
