import { useNavigate } from "@tanstack/react-router";
import { Dialog as RDialog } from "radix-ui";
import { Lock, LogOut, Settings, Wand2, X, type LucideIcon } from "lucide-react";
import { Theme } from "@mbm/shared";
import { saveSetting, useMe, useSettings } from "../lib/queries";
import { THEME_LABELS } from "../lib/theme";
import { ui } from "../lib/ui";
import { Ic } from "../components/icons";
import { lockServer, signOut } from "./session";

/** The gear in the top bar of the phone: what the user menu of the sidebar holds on wider screens. */
export function SettingsSheet() {
    const navigate = useNavigate();
    const theme = useSettings()?.theme ?? "system";
    const me = useMe(true).data;
    // Close first, then act: the next dialog or page must not open below this one
    const run = (fn: () => void) => {
        ui.close();
        setTimeout(fn, 0);
    };
    const go = (to: string, search: Record<string, unknown> = {}) => run(() => void navigate({ to, search }));
    const item = (icon: LucideIcon, label: string, onClick: () => void) => (
        <button type="button" className="more-item" onClick={onClick}>
            <Ic icon={icon} size={19} />
            <span>{label}</span>
        </button>
    );
    return (
        <RDialog.Root open onOpenChange={(o) => !o && ui.close()}>
            <RDialog.Portal>
                <RDialog.Overlay className="scrim" />
                <RDialog.Content className="drawer sheet" aria-describedby={undefined}>
                    <div className="d-top">
                        <RDialog.Title className="label">Einstellungen</RDialog.Title>
                        <RDialog.Close className="icon-btn" aria-label="Schließen">
                            <Ic icon={X} />
                        </RDialog.Close>
                    </div>
                    {me && (
                        <div className="sheet-user">
                            <span className="avatar" aria-hidden="true">{me.name.slice(0, 1).toUpperCase()}</span>
                            <span>
                                Angemeldet als <b>{me.name}</b>
                            </span>
                        </div>
                    )}
                    <nav className="more-list" aria-label="Einstellungen">
                        {item(Settings, "Alle Einstellungen", () => go("/settings"))}
                        {item(Wand2, "Regeln", () => go("/settings", { tab: "rules" }))}
                    </nav>
                    <div className="more-settings">
                        <div className="switch-row">
                            <span>
                                <b>Darstellung</b>
                            </span>
                            <div className="seg" role="group" aria-label="Darstellung">
                                {Theme.options.map((t) => (
                                    <button key={t} aria-pressed={theme === t} onClick={() => void saveSetting("theme", t)}>
                                        {THEME_LABELS[t]}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    <nav className="more-list" aria-label="Sitzung">
                        {item(LogOut, "Abmelden", () => run(() => signOut()))}
                        {item(Lock, "MBM für alle sperren", () => run(() => lockServer()))}
                    </nav>
                </RDialog.Content>
            </RDialog.Portal>
        </RDialog.Root>
    );
}
