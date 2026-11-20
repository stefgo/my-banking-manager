import type { Theme } from "@mbm/shared";

export const THEME_LABELS: Record<Theme, string> = { system: "Wie System", light: "Hell", dark: "Dunkel" };

/** Sets the appearance of the page; "system" follows the operating system. */
export function applyTheme(theme: Theme): void {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
}
