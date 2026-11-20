import { useSyncExternalStore } from "react";

/** From this width the booking details are a panel beside the list instead of an overlay. */
export const INSPECTOR_QUERY = "(min-width: 1280px)";

/** Up to this width the sidebar is hidden and the tab bar shows (as in app.css). */
export const NARROW_QUERY = "(max-width: 860px)";

/** Whether the booking details show as a panel beside the list (outside React). */
export const inspectorMode = (): boolean => matchMedia(INSPECTOR_QUERY).matches;

export function useMedia(query: string): boolean {
    return useSyncExternalStore(
        (changed) => {
            const m = matchMedia(query);
            m.addEventListener("change", changed);
            return () => m.removeEventListener("change", changed);
        },
        () => matchMedia(query).matches,
    );
}
