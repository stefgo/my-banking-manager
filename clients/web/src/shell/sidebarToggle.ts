import { readLocalSetting, writeLocalSetting } from "../lib/localSettings";
import { NARROW_QUERY } from "../lib/media";

/** The ☰ button exists once: in the head of the sidebar or at the top of the symbol column. */
export const SIDEBAR_TOGGLE_ID = "sb-toggle";

/**
 * Shows or hides the sidebar (wide layout only). The button moves between the two layouts, so
 * the focus follows it when it was on the button or `focus` asks for it.
 */
export function toggleSidebar(focus = false): void {
    if (matchMedia(NARROW_QUERY).matches) return;
    const refocus = focus || document.activeElement?.id === SIDEBAR_TOGGLE_ID;
    writeLocalSetting("sidebarCollapsed", !readLocalSetting("sidebarCollapsed"));
    if (refocus) requestAnimationFrame(() => document.getElementById(SIDEBAR_TOGGLE_ID)?.focus());
}
