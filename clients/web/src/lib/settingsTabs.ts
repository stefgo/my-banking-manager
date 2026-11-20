export const SETTINGS_TABS = [
    { id: "accounts", label: "Konten" },
    { id: "rules", label: "Regeln" },
    { id: "users", label: "Benutzer" },
    { id: "devices", label: "Geräte" },
    { id: "profile", label: "Profil" },
    { id: "security", label: "Sicherheit" },
    { id: "imports", label: "Importe" },
    { id: "activity", label: "Protokoll" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
