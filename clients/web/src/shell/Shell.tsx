import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { CalendarDays, Eye, EyeOff, Home, Landmark, List, Search, Send, Settings } from "lucide-react";
import type { Me } from "@mbm/shared";
import { ROUTE_TITLES } from "../router";
import { useProfile } from "../lib/queries";
import { useTxHome } from "../lib/useTxHome";
import { badgeText, unreadLabel, useUnreadTotal } from "../lib/unread";
import { useLocalSetting, writeLocalSetting } from "../lib/localSettings";
import { useServerEvents } from "../lib/socket";
import { useIdleLock } from "./idle";
import { ui, useUi } from "../lib/ui";
import { Ic, Mark } from "../components/icons";
import { applyTheme } from "../lib/theme";
import { INSPECTOR_QUERY, useMedia } from "../lib/media";
import { Sidebar } from "./Sidebar";
import { DialogHost } from "./DialogHost";
import { KeepRowInPlace } from "./KeepRowInPlace";
import { useShortcuts } from "./shortcuts";
import { TxDrawer } from "../pages/TxDrawer";
import { OrderDrawer } from "../pages/OrderDrawer";
import { TransferDrawer } from "../pages/TransferDrawer";

export function Shell({ me }: { me: Me }) {
    useServerEvents(true);
    useIdleLock(me.sessionIdleMinutes);
    const profile = useProfile();
    const settings = profile.data?.settings;
    const router = useRouter();
    const path = useRouterState({ select: (s) => s.location.pathname });
    const privacy = useUi((s) => s.privacy);
    const panelOpen = useUi((s) => s.drawerTx !== null || s.drawerOrder !== null || s.drawerTransfer !== null);
    const wide = useMedia(INSPECTOR_QUERY);
    const savedWidth = useLocalSetting("sidebarWidth");
    const collapsed = useLocalSetting("sidebarCollapsed");
    // Collapsed, only the trees on "Umsätze" have a width to drag
    const trees = path === "/transactions";
    const resizable = !collapsed || trees;
    const [width, setWidth] = useState<number | null>(null);
    const appliedStart = useRef(false);
    useShortcuts();

    // Theme from the profile; "system" follows the operating system
    useEffect(() => {
        if (settings) applyTheme(settings.theme);
    }, [settings]);

    useEffect(() => {
        if (settings && !appliedStart.current) {
            appliedStart.current = true;
            ui.setPrivacy(settings.hideAmountsOnStart);
        }
    }, [settings]);

    useEffect(() => {
        document.title = `${ROUTE_TITLES[path] ?? "MBM"} · My Banking Manager`;
        // The details of an order belong to the orders page
        if (path !== "/orders") ui.openOrder(null);
        if (path !== "/transfer") {
            ui.openTransfer(null);
            ui.showTransferForm(false);
        }
    }, [path]);

    // A booking's details belong to the page they were opened on. Closed when the navigation
    // starts, so a jump that opens a booking once it has arrived keeps that booking open.
    useEffect(
        () =>
            router.subscribe("onBeforeNavigate", (e) => {
                if (e.pathChanged) ui.openTx(null);
            }),
        [router],
    );

    const sbWidth = width ?? savedWidth;

    return (
        <>
            <div className={appClass(panelOpen && wide, collapsed, trees)} style={{ "--sb-w": `${sbWidth}px` } as React.CSSProperties}>
                <Sidebar me={me} collapsed={collapsed} />
                {resizable && (
                    <ResizeHandle
                        label={collapsed ? "Breite der Konten und Kategorien ändern" : "Breite der Seitenleiste ändern"}
                        width={sbWidth}
                        onDrag={setWidth}
                        onDone={(w) => {
                            setWidth(null);
                            writeLocalSetting("sidebarWidth", w);
                        }}
                    />
                )}
                <Topbar path={path} privacy={privacy} />
                <main id="main" tabIndex={-1}>
                    <Outlet />
                </main>
            </div>
            <KeepRowInPlace inspector={panelOpen && wide} />
            <Tabbar path={path} />
            <TxDrawer />
            <OrderDrawer />
            <TransferDrawer />
            <DialogHost />
        </>
    );
}

function appClass(inspector: boolean, collapsed: boolean, trees: boolean): string {
    return ["app", inspector && "with-inspector", collapsed && "sb-collapsed", collapsed && trees && "with-trees"].filter(Boolean).join(" ");
}

const clampWidth = (w: number) => Math.round(Math.min(440, Math.max(220, w)));

function ResizeHandle({ label, width, onDrag, onDone }: { label: string; width: number; onDrag: (w: number) => void; onDone: (w: number) => void }) {
    const [drag, setDrag] = useState(false);
    return (
        <div
            className={`sb-resize ${drag ? "drag" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuenow={width}
            aria-valuemin={220}
            aria-valuemax={440}
            tabIndex={0}
            title="Ziehen zum Ändern der Breite, Doppelklick setzt sie zurück"
            onDoubleClick={() => onDone(272)}
            onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    onDone(clampWidth(width + (e.key === "ArrowLeft" ? -16 : 16)));
                }
            }}
            onPointerDown={(e) => {
                const startX = e.clientX;
                const start = width;
                let last = start;
                setDrag(true);
                document.body.classList.add("resizing");
                const move = (ev: PointerEvent) => {
                    last = clampWidth(start + ev.clientX - startX);
                    onDrag(last);
                };
                const up = () => {
                    setDrag(false);
                    document.body.classList.remove("resizing");
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    if (last !== start) onDone(last);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
            }}
        />
    );
}

function Topbar({ path, privacy }: { path: string; privacy: boolean }) {
    return (
        <header className="topbar">
            <Link className="mark" to="/" aria-label="Übersicht">
                <Mark size={17} />
            </Link>
            <span className="t-title">{ROUTE_TITLES[path] ?? ""}</span>
            <button className="icon-btn" onClick={() => ui.open({ kind: "palette" })} aria-label="Suchen">
                <Ic icon={Search} size={17} />
            </button>
            <button className="icon-btn" onClick={() => ui.togglePrivacy()} aria-pressed={privacy} aria-label="Beträge ausblenden">
                <Ic icon={privacy ? EyeOff : Eye} size={17} />
            </button>
            <button className="icon-btn" onClick={() => ui.open({ kind: "settings" })} aria-haspopup="dialog" aria-label="Einstellungen">
                <Ic icon={Settings} size={17} />
            </button>
        </header>
    );
}

function Tabbar({ path }: { path: string }) {
    // The areas of the sidebar plus "Konten" (the trees); settings sit behind the gear in the top bar
    const tabs = [
        ["/", "Übersicht", Home],
        ["/transactions", "Umsätze", List],
        ["/accounts", "Konten", Landmark],
        ["/transfer", "Überweisen", Send],
        ["/orders", "Aufträge", CalendarDays],
    ] as const;
    const navigate = useNavigate();
    // "Umsätze" returns to the last view shown
    const home = useTxHome();
    const unread = useUnreadTotal();
    return (
        <nav className="tabbar" aria-label="Navigation">
            {tabs.map(([to, label, icon]) => (
                <a
                    key={to}
                    href={to}
                    aria-current={path === to ? "page" : undefined}
                    onClick={(e) => {
                        e.preventDefault();
                        void navigate({ to, search: to === "/transactions" ? home : {} });
                    }}
                >
                    <span className="tab-ic">
                        <Ic icon={icon} size={21} />
                        {to === "/transactions" && unread > 0 && <span className="rail-badge" aria-hidden="true">{badgeText(unread)}</span>}
                    </span>
                    <span>{label}</span>
                    {to === "/transactions" && unread > 0 && <span className="sr-only">{unreadLabel(unread)}</span>}
                </a>
            ))}
        </nav>
    );
}
