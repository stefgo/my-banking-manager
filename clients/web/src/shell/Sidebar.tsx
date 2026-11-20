import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { DropdownMenu } from "radix-ui";
import { CalendarDays, Check, Home, Keyboard, List, Lock, LogOut, Menu, Monitor, Moon, Eye, EyeOff, RefreshCw, Search, Send, Settings, Sun } from "lucide-react";
import { isActive, startSync, useConnections, useSyncRuns } from "../lib/bank";
import { Theme, type Me } from "@mbm/shared";
import { saveSetting, useSettings, useTransfers } from "../lib/queries";
import { needsUser } from "../lib/transfer";
import { parseTxSearch } from "../lib/search";
import { useTxHome } from "../lib/useTxHome";
import { keyText, withKeys } from "../lib/keys";
import { THEME_LABELS } from "../lib/theme";
import { badgeText, unreadLabel, useUnreadTotal } from "../lib/unread";
import { ui, useUi } from "../lib/ui";
import { Ic, Mark } from "../components/icons";
import { NewBadge } from "../components/common";
import { lockServer, signOut } from "./session";
import { AccountsSection, CategoriesSection } from "./TreeSections";
import { SIDEBAR_TOGGLE_ID, toggleSidebar } from "./sidebarToggle";

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

const NAV = [
    ["/", "Übersicht", Home, "goOverview"],
    ["/transactions", "Umsätze", List, "goTransactions"],
    ["/transfer", "Überweisen", Send, "transfer"],
    ["/orders", "Aufträge", CalendarDays, "goOrders"],
] as const;

/**
 * Full sidebar, or with `collapsed` a column of symbols; on "Umsätze" the trees then stand as a
 * column of their own beside it.
 */
export function Sidebar({ me, collapsed }: { me: Me; collapsed: boolean }) {
    const path = useRouterState({ select: (s) => s.location.pathname });
    const rawSearch = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
    const search = parseTxSearch(rawSearch);
    const trees = path === "/transactions";
    const privacy = useUi((s) => s.privacy);
    // A transfer of this user waits for the confirmation or the approval
    const waits = (useTransfers().data ?? []).some((t) => t.mine && needsUser(t.status));
    const dotFor = (to: string) => (to === "/transfer" && waits ? " has-dot" : "");
    // New bookings of all accounts, on "Umsätze"
    const unread = useUnreadTotal();
    const badgeFor = (to: string) => (to === "/transactions" ? unread : 0);
    const railLabel = (to: string, label: string) => (dotFor(to) ? `${label} – wartet auf dich` : badgeFor(to) ? `${label} – ${unreadLabel(badgeFor(to))}` : label);
    // "Umsätze" returns to the last view shown
    const home = useTxHome();
    const searchFor = (to: string) => (to === "/transactions" ? home : {});

    if (collapsed) {
        return (
            <>
                <aside id="sidebar" className="rail" aria-label="Navigation">
                    <SidebarToggle collapsed />
                    <span className="mark" aria-hidden="true"><Mark size={17} /></span>
                    <button type="button" className="rail-btn" onClick={() => ui.open({ kind: "palette" })} aria-label="Suchen" title={withKeys("Konten, Umsätze und Befehle suchen", "palette")}>
                        <Ic icon={Search} size={17} />
                    </button>
                    <nav className="rail-nav">
                        {NAV.map(([to, label, icon, key]) => (
                            <Link key={to} to={to} search={searchFor(to)} className={`rail-btn${dotFor(to)}${badgeFor(to) ? " has-badge" : ""}`} aria-label={railLabel(to, label)} title={withKeys(label, key)} aria-current={path === to ? "page" : undefined} activeOptions={{ exact: true }}>
                                <Ic icon={icon} size={17} />
                                {badgeFor(to) > 0 && <span className="rail-badge" aria-hidden="true">{badgeText(badgeFor(to))}</span>}
                            </Link>
                        ))}
                    </nav>
                    <div className="rail-foot">
                        <SyncAllButton className="rail-btn" size={17} />
                        <PrivacyButton privacy={privacy} className="rail-btn" />
                        <UserMenu me={me} compact />
                    </div>
                </aside>
                {trees && (
                    <aside className="sb-trees" aria-label="Konten und Kategorien">
                        <div className="sb-scroll">
                            <AccountsSection search={search} />
                            <CategoriesSection search={search} />
                        </div>
                    </aside>
                )}
            </>
        );
    }

    return (
        <aside id="sidebar" className="sidebar" aria-label="Navigation">
            <div className="brand-row">
                <SidebarToggle collapsed={false} />
                <Link className="brand" to="/">
                    <span className="mark"><Mark size={17} /></span>
                    <span>My Banking Manager</span>
                </Link>
            </div>
            <div className="sb-nav">
                <SearchButton />
                <nav className="nav">
                    {NAV.map(([to, label, icon, key]) => (
                        <Link key={to} to={to} search={searchFor(to)} className={[dotFor(to).trim(), badgeFor(to) ? "has-badge" : ""].filter(Boolean).join(" ") || undefined} aria-current={path === to ? "page" : undefined} activeOptions={{ exact: true }}>
                            <Ic icon={icon} />
                            <span>{label}</span>
                            {dotFor(to) && <span className="nav-dot" role="img" aria-label="wartet auf dich" />}
                            <NewBadge count={badgeFor(to)} className="nav-badge" />
                            <span className="kbd">{keyText(key)}</span>
                        </Link>
                    ))}
                </nav>
            </div>

            <div className="sb-scroll">
                {trees && (
                    <>
                        <AccountsSection search={search} />
                        <CategoriesSection search={search} />
                    </>
                )}
            </div>

            <div className="sb-foot">
                <UserMenu me={me} />
                <SyncAllButton className="icon-btn" size={16} />
                <PrivacyButton privacy={privacy} className="icon-btn" />
            </div>
        </aside>
    );
}

/** Fetches all bank accounts the user's logins reach; a click on a running fetch shows it. */
function SyncAllButton({ className, size }: { className: string; size: number }) {
    const connections = useConnections().data ?? [];
    const running = (useSyncRuns().data ?? []).some(isActive);
    if (!connections.some((c) => c.myLogin)) return null;
    const label = running ? "Abruf läuft – anzeigen" : "Alle abrufen";
    return (
        <button type="button" className={className} aria-label={label} title={label} onClick={() => (running ? ui.open({ kind: "sync" }) : void startSync({}))}>
            <Ic icon={RefreshCw} size={size} className={running ? "spin" : undefined} />
        </button>
    );
}

function SidebarToggle({ collapsed }: { collapsed: boolean }) {
    const label = collapsed ? "Seitenleiste einblenden" : "Seitenleiste ausblenden";
    return (
        <button
            type="button"
            id={SIDEBAR_TOGGLE_ID}
            // Same size in both layouts, so the button stays in place when it switches
            className="rail-btn"
            aria-expanded={!collapsed}
            aria-controls="sidebar"
            aria-label={label}
            title={withKeys(label, "sidebar")}
            onClick={() => toggleSidebar(true)}
        >
            <Ic icon={Menu} size={17} />
        </button>
    );
}

function SearchButton() {
    return (
        <button type="button" className="sb-search" onClick={() => ui.open({ kind: "palette" })} title="Konten, Umsätze und Befehle suchen">
            <Ic icon={Search} size={15} />
            <span>Suchen …</span>
            <span className="kbd">{keyText("palette").replace(" ", "")}</span>
        </button>
    );
}

function PrivacyButton({ privacy, className }: { privacy: boolean; className: string }) {
    return (
        <button className={className} aria-pressed={privacy} onClick={() => ui.togglePrivacy()} aria-label="Beträge ausblenden" title={withKeys("Beträge ausblenden", "privacy")}>
            <Ic icon={privacy ? EyeOff : Eye} size={17} />
        </button>
    );
}

/** The signed-in user; the menu holds settings, appearance, help and the ways to end work. */
function UserMenu({ me, compact = false }: { me: Me; compact?: boolean }) {
    const navigate = useNavigate();
    const theme = useSettings()?.theme ?? "system";
    return (
        <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger className={compact ? "sb-user compact" : "sb-user"} aria-label={`Benutzermenü, angemeldet als ${me.name}`} title={compact ? me.name : undefined}>
                <span className="avatar" aria-hidden="true">{me.name.slice(0, 1).toUpperCase()}</span>
                {!compact && <span className="sb-user-name">{me.name}</span>}
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu-content" side={compact ? "right" : "top"} align={compact ? "end" : "start"} sideOffset={6} collisionPadding={12}>
                    <div className="menu-label">Angemeldet als {me.name}</div>
                    <DropdownMenu.Item onSelect={() => void navigate({ to: "/settings" })}>
                        <Ic icon={Settings} size={15} />
                        Einstellungen
                        <span className="menu-kbd">{keyText("goSettings")}</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <div className="menu-label">Darstellung</div>
                    {Theme.options.map((t) => (
                        <DropdownMenu.Item key={t} aria-checked={t === theme} onSelect={() => void saveSetting("theme", t)}>
                            <Ic icon={THEME_ICONS[t]} size={15} />
                            {THEME_LABELS[t]}
                            {t === theme && (
                                <span className="menu-check">
                                    <Ic icon={Check} size={15} />
                                </span>
                            )}
                        </DropdownMenu.Item>
                    ))}
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => ui.open({ kind: "help" })}>
                        <Ic icon={Keyboard} size={15} />
                        Tastenkürzel
                        <span className="menu-kbd">{keyText("help")}</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => signOut()}>
                        <Ic icon={LogOut} size={15} />
                        Abmelden
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => lockServer()}>
                        <Ic icon={Lock} size={15} />
                        MBM für alle sperren
                        <span className="menu-kbd">{keyText("lock")}</span>
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
