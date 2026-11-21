import { useMemo } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Command } from "cmdk";
import { parseTxQuery } from "@mbm/shared";
import { Dialog as RDialog } from "radix-ui";
import { CalendarDays, Eye, EyeOff, Home, Keyboard, List, Lock, LogOut, Menu, Plus, Search, Settings, Tag, Wand2, FolderOpen, Send, FileUp } from "lucide-react";
import { useAccounts, useCategoryIndex, useGroups, useTransactions } from "../lib/queries";
import { ui, useUi } from "../lib/ui";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { fmtSigned, dayMonth, partyName } from "../lib/format";
import { categoryPath } from "../lib/tree";
import { ConfirmDialog, Kbd, Modal } from "../components/common";
import { Ic, Sym } from "../components/icons";
import { BookingDialog, ReconcileDialog } from "../dialogs/Booking";
import { CounterBookingDialog } from "../dialogs/CounterBooking";
import { openImport } from "../lib/importNav";
import { ApplyRulesDialog } from "../dialogs/ApplyRules";
import { InfoDialog } from "../dialogs/InfoDialog";
import { AddAccountDialog, OpeningBalanceDialog } from "../dialogs/AddAccount";
import { BankSetupDialog } from "../dialogs/BankSetup";
import { SyncDialog } from "../dialogs/Sync";
import { DetachAccountDialog } from "../dialogs/DetachAccount";
import { ConfirmSecretDialog } from "../dialogs/ConfirmSecret";
import { AddCardDialog, CardSettingsDialog } from "../pages/overview/CardDialogs";
import { KEYS, keyText } from "../lib/keys";
import { lockServer, signOut } from "./session";
import { SettingsSheet } from "./SettingsSheet";
import { openBooking } from "./shortcuts";
import { toggleSidebar } from "./sidebarToggle";
import { useLocalSetting } from "../lib/localSettings";
import { NARROW_QUERY, useMedia } from "../lib/media";
import { useState } from "react";

export function DialogHost() {
    const d = useUi((s) => s.dialog);
    if (!d) return null;
    switch (d.kind) {
        case "palette":
            return <Palette />;
        case "help":
            return <Help />;
        case "settings":
            return <SettingsSheet />;
        case "confirm":
            return <ConfirmDialog {...d} />;
        case "booking":
            return <BookingDialog accountId={d.accountId} txId={d.txId} />;
        case "reconcile":
            return <ReconcileDialog accountId={d.accountId} />;
        case "counterBooking":
            return <CounterBookingDialog txId={d.txId} />;
        case "addAccount":
            return <AddAccountDialog offline={d.offline} />;
        case "bankSetup":
            return <BankSetupDialog connectionId={d.connectionId} />;
        case "detachAccount":
            return <DetachAccountDialog accountId={d.accountId} />;
        case "sync":
            return <SyncDialog />;
        case "openingBalance":
            return <OpeningBalanceDialog accountId={d.accountId} />;
        case "addCard":
            return <AddCardDialog />;
        case "cardSettings":
            return <CardSettingsDialog cardId={d.cardId} />;
        case "applyRules":
            return <ApplyRulesDialog ruleId={d.ruleId} created={d.created} preview={d.preview} />;
        case "info":
            return <InfoDialog target={d.target} id={d.id} />;
        case "confirmSecret":
            return <ConfirmSecretDialog {...d} />;
    }
}

const HELP_SECTIONS = [
    ["global", "Überall"],
    ["list", "In der Umsatzliste"],
] as const;

function Help() {
    return (
        <Modal title="Tastenkürzel" onClose={() => ui.close()}>
            {HELP_SECTIONS.map(([scope, title]) => (
                <section key={scope} className="help-sec">
                    <h3 className="label">{title}</h3>
                    <div className="help-grid">
                        {KEYS.filter((k) => k.scope === scope).map((k) => (
                            <div key={k.id}>
                                <span>{k.label}</span>
                                <span>{k.keys.map((x) => <Kbd key={x}>{x}</Kbd>)}</span>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </Modal>
    );
}

function Palette() {
    const navigate = useNavigate();
    const accounts = useAccounts().data ?? [];
    const groups = useGroups().data ?? [];
    const { index } = useCategoryIndex();
    const privacy = useUi((s) => s.privacy);
    const narrow = useMedia(NARROW_QUERY);
    const collapsed = useLocalSetting("sidebarCollapsed");
    const [q, setQ] = useState("");
    const hits = useTransactions({ q, range: "all", limit: 6 }, q.trim().length >= 2 && parseTxQuery(q.trim()).ok);
    const run = (fn: () => void) => {
        ui.close();
        setTimeout(fn, 0);
    };
    const go = (to: string, search?: Record<string, unknown>) => run(() => void navigate({ to, search: search ?? {} }));
    // Hits and "Alle Umsätze mit …" open the list as this search sees it, so every hit is in it
    const open = useOpenTransactions();
    const cats = useMemo(() => [...index.byId.values()], [index]);
    // The account shown in the transaction list is the default target of an import
    const scope = useRouterState({ select: (st) => (st.location.pathname === "/transactions" ? (st.location.search as { scope?: string }).scope : undefined) });
    const currentAccount = scope?.startsWith("account:") ? Number(scope.slice(8)) : undefined;

    return (
        <RDialog.Root open onOpenChange={(o) => !o && ui.close()}>
            <RDialog.Portal>
                <div className="modal-wrap">
                    <RDialog.Overlay className="scrim" />
                    <RDialog.Content className="modal palette" aria-describedby={undefined}>
                        <RDialog.Title className="sr-only">Befehlspalette</RDialog.Title>
                        <Command label="Befehlspalette" loop>
                            <div className="pal-in">
                                <Ic icon={Search} />
                                <Command.Input autoFocus placeholder="Suchen oder Befehl eingeben …" value={q} onValueChange={setQ} />
                                <Kbd>Esc</Kbd>
                            </div>
                            <Command.List className="pal-list">
                                <Command.Empty>Nichts gefunden. Versuch es mit „Bargeld“, „Regeln“ oder einem Namen.</Command.Empty>
                                <Command.Group heading="Gehe zu">
                                    <Item icon={<Ic icon={Home} size={17} />} label="Übersicht" kbd={keyText("goOverview")} onSelect={() => go("/")} />
                                    <Item icon={<Ic icon={List} size={17} />} label="Alle Umsätze" onSelect={() => go("/transactions")} />
                                    <Item icon={<Ic icon={Wand2} size={17} />} label="Regeln" kbd={keyText("goRules")} onSelect={() => go("/settings", { tab: "rules" })} />
                                    <Item icon={<Ic icon={CalendarDays} size={17} />} label="Aufträge" kbd={keyText("goOrders")} onSelect={() => go("/orders")} />
                                    <Item icon={<Ic icon={Settings} size={17} />} label="Einstellungen" kbd={keyText("goSettings")} onSelect={() => go("/settings")} />
                                </Command.Group>
                                <Command.Group heading="Konten">
                                    {accounts.map((a) => (
                                        <Item key={a.id} icon={<Sym name={a.icon} size={17} />} label={a.name} hint={a.kind === "offline" ? "Offline-Konto" : undefined} onSelect={() => go("/transactions", { scope: `account:${a.id}` })} />
                                    ))}
                                    {groups.map((g) => (
                                        <Item key={`g${g.id}`} icon={<Ic icon={FolderOpen} size={17} />} label={g.name} hint="Kontogruppe" onSelect={() => go("/transactions", { scope: `group:${g.id}` })} />
                                    ))}
                                </Command.Group>
                                <Command.Group heading="Kategorien">
                                    {cats.map((c) => (
                                        <Item
                                            key={c.id}
                                            icon={<Ic icon={Tag} size={17} />}
                                            label={c.name}
                                            hint={c.parentId ? categoryPath(index, c.parentId) : undefined}
                                            onSelect={() => go("/transactions", { cat: String(c.id), ctx: "cat" })}
                                        />
                                    ))}
                                </Command.Group>
                                <Command.Group heading="Aktionen">
                                    <Item icon={<Ic icon={Plus} size={17} />} label="Buchung erfassen (Offline-Konto)" kbd={keyText("booking")} onSelect={() => run(() => openBooking())} />
                                    <Item icon={<Ic icon={Plus} size={17} />} label="Konto hinzufügen" onSelect={() => run(() => ui.open({ kind: "addAccount" }))} />
                                    {accounts.length > 0 && (
                                        <Item icon={<Ic icon={FileUp} size={17} />} label="CSV importieren" onSelect={() => run(() => openImport(currentAccount))} />
                                    )}
                                    <Item
                                        icon={<Ic icon={Send} size={17} />}
                                        label="Neue Überweisung"
                                        kbd={keyText("transfer")}
                                        onSelect={() =>
                                            run(() => {
                                                ui.newTransfer();
                                                void navigate({ to: "/transfer" });
                                            })
                                        }
                                    />
                                    {!narrow && (
                                        <Item icon={<Ic icon={Menu} size={17} />} label={collapsed ? "Seitenleiste einblenden" : "Seitenleiste ausblenden"} kbd={keyText("sidebar")} onSelect={() => run(() => toggleSidebar())} />
                                    )}
                                    <Item icon={<Ic icon={privacy ? Eye : EyeOff} size={17} />} label={privacy ? "Beträge einblenden" : "Beträge ausblenden"} kbd={keyText("privacy")} onSelect={() => run(() => ui.togglePrivacy())} />
                                    <Item icon={<Ic icon={LogOut} size={17} />} label="Abmelden" onSelect={() => run(() => signOut())} />
                                    <Item icon={<Ic icon={Lock} size={17} />} label="MBM für alle sperren" kbd={keyText("lock")} onSelect={() => run(() => lockServer())} />
                                    <Item icon={<Ic icon={Keyboard} size={17} />} label="Tastenkürzel anzeigen" kbd={keyText("help")} onSelect={() => run(() => ui.open({ kind: "help" }))} />
                                </Command.Group>
                                {q.trim().length >= 2 && (
                                    <Command.Group heading="Umsätze" forceMount>
                                        {(hits.data?.items ?? []).map((t) => (
                                            <Item
                                                key={t.id}
                                                value={`tx-${t.id} ${q}`}
                                                icon={<Ic icon={List} size={17} />}
                                                label={partyName(t) || t.remittance || "Umsatz"}
                                                hint={`${dayMonth(t.bookingDate)} · ${fmtSigned(t.amount)}`}
                                                onSelect={() => run(() => void open({ kind: "query", q }).then(() => ui.openTx(t.id)))}
                                            />
                                        ))}
                                        <Item
                                            value={`all ${q}`}
                                            icon={<Ic icon={Search} size={17} />}
                                            label={`Alle Umsätze mit „${q.trim()}“`}
                                            onSelect={() => run(() => void open({ kind: "query", q }))}
                                        />
                                    </Command.Group>
                                )}
                            </Command.List>
                            <div className="pal-foot">
                                <span><Kbd>↑</Kbd><Kbd>↓</Kbd> auswählen</span>
                                <span><Kbd>↵</Kbd> ausführen</span>
                                <span><Kbd>Esc</Kbd> schließen</span>
                            </div>
                        </Command>
                    </RDialog.Content>
                </div>
            </RDialog.Portal>
        </RDialog.Root>
    );
}

function Item({ icon, label, hint, kbd, value, onSelect }: { icon: React.ReactNode; label: string; hint?: string; kbd?: string; value?: string; onSelect: () => void }) {
    return (
        <Command.Item className="pal-item" value={value ?? `${label} ${hint ?? ""}`} onSelect={onSelect}>
            {icon}
            <span>
                {label}
                {hint && <small className="amt">{hint}</small>}
            </span>
            {kbd && <Kbd>{kbd}</Kbd>}
        </Command.Item>
    );
}
