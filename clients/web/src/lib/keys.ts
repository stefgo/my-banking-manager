// Keyboard shortcuts: one list for the help, the palette, the sidebar and the tooltips, so what
// is shown never drifts from what the keys do (see shell/shortcuts.ts).

/** Pages reached with "G" followed by a letter. */
export const GO_KEYS = {
    o: { to: "/" },
    u: { to: "/transactions" },
    a: { to: "/orders" },
    e: { to: "/settings" },
    r: { to: "/settings", search: { tab: "rules" } },
} as const satisfies Record<string, { to: string; search?: Record<string, string> }>;

export type GoLetter = keyof typeof GO_KEYS;

export interface KeyDef {
    id: string;
    label: string;
    keys: readonly string[];
    /** "global" works on every page, "list" in the transaction list. */
    scope: "global" | "list";
    /** The letter after "G" for page shortcuts. */
    go?: GoLetter;
}

export const KEYS = [
    { id: "palette", label: "Befehlspalette", keys: ["⌘", "K"], scope: "global" },
    { id: "search", label: "Umsätze durchsuchen", keys: ["/"], scope: "global" },
    { id: "sidebar", label: "Seitenleiste ein-/ausblenden", keys: ["⌘", "B"], scope: "global" },
    { id: "goOverview", label: "Zur Übersicht", keys: ["G", "O"], scope: "global", go: "o" },
    { id: "goTransactions", label: "Zu den Umsätzen", keys: ["G", "U"], scope: "global", go: "u" },
    { id: "goOrders", label: "Zu den Aufträgen", keys: ["G", "A"], scope: "global", go: "a" },
    { id: "goRules", label: "Zu den Regeln", keys: ["G", "R"], scope: "global", go: "r" },
    { id: "goSettings", label: "Zu den Einstellungen", keys: ["G", "E"], scope: "global", go: "e" },
    { id: "booking", label: "Buchung erfassen", keys: ["B"], scope: "global" },
    { id: "transfer", label: "Neue Überweisung", keys: ["N"], scope: "global" },
    { id: "privacy", label: "Beträge ausblenden", keys: ["H"], scope: "global" },
    { id: "lock", label: "MBM für alle sperren", keys: ["L"], scope: "global" },
    { id: "help", label: "Tastenkürzel", keys: ["?"], scope: "global" },
    { id: "move", label: "Nächster / voriger Umsatz", keys: ["J", "K"], scope: "list" },
    { id: "open", label: "Umsatz öffnen", keys: ["↵"], scope: "list" },
    { id: "pick", label: "Umsatz auswählen", keys: ["X"], scope: "list" },
    { id: "pickClick", label: "Einzeln / bis hier auswählen", keys: ["⌘-Klick", "⇧-Klick"], scope: "list" },
    { id: "category", label: "Kategorie zuweisen", keys: ["C"], scope: "list" },
    { id: "clearPick", label: "Auswahl aufheben", keys: ["Esc"], scope: "list" },
] as const satisfies readonly KeyDef[];

export type KeyId = (typeof KEYS)[number]["id"];

export function keysOf(id: KeyId): readonly string[] {
    return KEYS.find((k) => k.id === id)!.keys;
}

/** The keys as one short text, e.g. "G E". */
export function keyText(id: KeyId): string {
    return keysOf(id).join(" ");
}

/** A tooltip with the shortcut, e.g. "Sperren (L)". */
export function withKeys(label: string, id: KeyId): string {
    return `${label} (${keyText(id)})`;
}
