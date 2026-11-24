// Profile: what concerns only me. Users: what concerns someone else. System: what concerns everybody.
export const SETTINGS_TABS = [
    { id: "accounts", label: "Konten" },
    { id: "rules", label: "Regeln" },
    { id: "imports", label: "Importe" },
    { id: "profile", label: "Profil" },
    { id: "users", label: "Benutzer" },
    { id: "system", label: "System" },
    { id: "activity", label: "Protokoll" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** Tabs of earlier versions, so that saved links keep working. */
const MOVED_TABS = new Map<unknown, SettingsTab>([
    ["security", "system"],
    ["devices", "profile"],
]);

/** The tab a link asks for; undefined when there is no such tab. */
export function settingsTabFrom(raw: unknown): SettingsTab | undefined {
    const id = MOVED_TABS.get(raw) ?? raw;
    return SETTINGS_TABS.find((t) => t.id === id)?.id;
}
