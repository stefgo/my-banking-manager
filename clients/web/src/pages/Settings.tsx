import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Eye, FileUp, Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import { routes } from "@mbm/shared";
import { settingsRoute } from "../router";
import { SETTINGS_TABS } from "../lib/settingsTabs";
import { call } from "../lib/api";
import { useAccounts, useAction, useActivity, useImportFormats, useImports, useStatus } from "../lib/queries";
import { useConnectorStatus } from "../lib/bank";
import { dateTime, plural } from "../lib/format";
import { copyName } from "../lib/importFormat";
import { openImport } from "../lib/importNav";
import { confirmDeleteAccount } from "../lib/menus";
import { ui } from "../lib/ui";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { Amt, Empty } from "../components/common";
import { BankAccessCards, BankDirectoryRow, BankStatusRows } from "../components/BankAccess";
import { SkeletonRows } from "../components/Skeleton";
import { Ic, Sym, Tile } from "../components/icons";
import { RulesTab } from "./Rules";
import { ProfileTab } from "./settings/ProfileTab";
import { SystemTab } from "./settings/SystemTab";
import { NewUserDialog, UsersTab } from "./settings/UsersTab";

export function SettingsPage() {
    const { tab = "accounts" } = settingsRoute.useSearch();
    const navigate = useNavigate();
    const [addingUser, setAddingUser] = useState(false);
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Einstellungen</h1>
                    <p className="muted">Konten, Regeln, Importe, dein Profil, Benutzer und System</p>
                </div>
                {tab === "accounts" && (
                    <div className="head-actions">
                        <button className="btn btn-primary" onClick={() => ui.open({ kind: "addAccount" })}>
                            <Ic icon={Plus} size={16} />
                            Konto hinzufügen
                        </button>
                    </div>
                )}
                {tab === "rules" && (
                    <div className="head-actions">
                        <button className="btn btn-primary" onClick={() => void navigate({ to: "/settings", search: { tab: "rules", new: true } })}>
                            <Ic icon={Plus} size={16} />
                            Regel hinzufügen
                        </button>
                    </div>
                )}
                {tab === "users" && (
                    <div className="head-actions">
                        <button className="btn btn-primary" onClick={() => setAddingUser(true)}>
                            <Ic icon={Plus} size={16} />
                            Benutzer hinzufügen
                        </button>
                    </div>
                )}
                {tab === "imports" && (
                    <div className="head-actions">
                        <button className="btn btn-primary" onClick={() => openImport()}>
                            <Ic icon={FileUp} size={16} />
                            CSV importieren
                        </button>
                    </div>
                )}
            </div>
            <nav className="settings-nav" aria-label="Bereiche">
                {SETTINGS_TABS.map((t) => (
                    <button key={t.id} className="chip" aria-current={tab === t.id ? "page" : undefined} onClick={() => void navigate({ to: "/settings", search: t.id === "accounts" ? {} : { tab: t.id } })}>
                        {t.label}
                    </button>
                ))}
            </nav>
            {tab === "accounts" && <AccountsTab />}
            {tab === "rules" && <RulesTab />}
            {tab === "imports" && <ImportsTab />}
            {tab === "profile" && <ProfileTab />}
            {tab === "users" && <UsersTab />}
            {tab === "system" && <SystemTab />}
            {tab === "activity" && <ActivityTab />}
            <Versions />
            {addingUser && <NewUserDialog onClose={() => setAddingUser(false)} />}
        </>
    );
}

/** Which versions run: the server and, if configured, the FinTS connector. */
function Versions() {
    const server = useStatus().data?.version;
    const fints = useConnectorStatus().data?.find((s) => s.name === "fints");
    if (!server) return null;
    const connector = !fints ? null : fints.reachable && fints.version ? `FinTS-Konnektor ${fints.version}` : "FinTS-Konnektor nicht erreichbar";
    return <p className="muted small app-version">{[`My Banking Manager ${server}`, connector].filter(Boolean).join(" · ")}</p>;
}

// ---------- Accounts ----------

function AccountsTab() {
    const accounts = useAccounts().data ?? [];
    const offline = accounts.filter((a) => a.kind === "offline");
    const open = useOpenTransactions();
    const action = useAction();
    return (
        <>
            <section className="panel" aria-label="Status der Kontoabfrage">
                <div className="panel-head">
                    <h3>Status der Kontoabfrage</h3>
                </div>
                <div className="fs-list fs-status">
                    <BankStatusRows />
                    {offline.length > 0 && (
                        <div className="fs-row">
                            <span className="dot off" />
                            <span className="fs-main">
                                <b>Offline-Konten</b>
                                <small>{offline.map((a) => a.name).join(", ")}</small>
                            </span>
                            <span className="fs-state">ohne Abruf</span>
                            <span />
                        </div>
                    )}
                    <BankDirectoryRow />
                </div>
            </section>
            <BankAccessCards />
            {offline.length > 0 && (
                <>
                    <h2 className="set-h">Offline-Konten</h2>
                    <section className="panel conn-card">
                        <div className="cc-head">
                            <span className="acc-ic"><Sym name="banknote" size={20} /></span>
                            <div style={{ minWidth: 0 }}>
                                <h3>Offline-Konten</h3>
                                <p className="muted small">Ohne Bankzugang · Buchungen erfasst du selbst oder importierst sie</p>
                            </div>
                            <span />
                        </div>
                        <div className="cc-accs">
                            {offline.map((a) => (
                                <div className="cc-acc" key={a.id}>
                                    <Tile icon={a.icon} color={a.color} size={15} />
                                    <button className="cc-link" onClick={() => void open({ kind: "show", search: { scope: `account:${a.id}` } })}>
                                        <b>{a.name}</b>
                                        <small>
                                            Anfangssaldo <Amt cents={a.openingBalance ?? 0} /> · {plural(a.transactionCount, "Buchung", "Buchungen")}
                                        </small>
                                    </button>
                                    <Amt cents={a.balance} />
                                    <span className="cc-acc-actions">
                                        <button className="mini" aria-label={`Buchungen in „${a.name}“ importieren`} title="Buchungen importieren …" onClick={() => openImport(a.id)}>
                                            <Ic icon={FileUp} size={15} />
                                        </button>
                                        <button className="mini" aria-label={`„${a.name}“ löschen`} title="Konto löschen …" disabled={action.pending} onClick={() => confirmDeleteAccount(a, action)}>
                                            <Ic icon={Trash2} size={14} />
                                        </button>
                                    </span>
                                </div>
                            ))}
                        </div>
                    </section>
                </>
            )}
        </>
    );
}

// ---------- Imports and activity ----------

function ImportsTab() {
    const importsQuery = useImports();
    const imports = importsQuery.data ?? [];
    const accounts = useAccounts().data ?? [];
    const action = useAction();
    return (
        <>
        <ImportFormatsPanel />
        <section className="panel">
            <div className="panel-head"><h3>CSV-Importe</h3></div>
            {importsQuery.isPending && <SkeletonRows rows={3} plain />}
            {importsQuery.isSuccess && imports.length === 0 && <Empty icon={FileUp} title="Noch nichts importiert" text="CSV-Dateien importierst du hier über „CSV importieren“, über das Menü eines Offline-Kontos oder die Befehlspalette (⌘K)." />}
            <div className="row-list">
                {imports.map((i) => (
                    <div className="row-item" key={i.id}>
                        <span>
                            <b>{i.fileName}</b>
                            <small>
                                {accounts.find((a) => a.id === i.accountId)?.name ?? "gelöschtes Konto"} · {dateTime(i.importedAt)}
                                {i.userName ? ` · ${i.userName}` : ""} · {i.imported} neu, {i.skipped} übersprungen
                                {i.remaining !== i.imported ? ` · ${i.remaining} noch vorhanden` : ""}
                            </small>
                        </span>
                        <span className="row-actions">
                            {i.remaining > 0 && (
                                <button
                                    className="btn btn-sm btn-ghost"
                                    onClick={() =>
                                        ui.confirm({
                                            title: `Import „${i.fileName}“ rückgängig machen?`,
                                            text: `${plural(i.remaining, "Buchung", "Buchungen")} aus dieser Datei ${i.remaining === 1 ? "wird" : "werden"} gelöscht. Das lässt sich nicht rückgängig machen.`,
                                            confirm: i.remaining === 1 ? "Buchung löschen" : "Buchungen löschen",
                                            danger: true,
                                            onConfirm: () => action.succeeds(() => call(routes.undoImport, { params: { id: i.id } }), { topics: ["imports", "accounts", "transactions", "categories"], ok: "Import rückgängig gemacht" }),
                                        })
                                    }
                                >
                                    <Ic icon={Undo2} size={14} />
                                    Rückgängig
                                </button>
                            )}
                            {i.remaining === 0 && (
                                <button
                                    className="btn btn-sm btn-ghost"
                                    onClick={() => action.succeeds(() => call(routes.undoImport, { params: { id: i.id } }), { topics: ["imports", "accounts", "transactions", "categories"], ok: "Import aus der Liste entfernt" })}
                                >
                                    <Ic icon={Trash2} size={14} />
                                    Entfernen
                                </button>
                            )}
                        </span>
                    </div>
                ))}
            </div>
        </section>
        </>
    );
}

/** Formats of the app and own ones; editing happens on a page of its own, with or without a file. */
function ImportFormatsPanel() {
    const formatsQuery = useImportFormats();
    const formats = formatsQuery.data ?? [];
    const action = useAction();
    const navigate = useNavigate();
    const open = (key: string) => void navigate({ to: "/import-format", search: { key } });
    return (
        <section className="panel">
            <div className="panel-head">
                <h3>Importformate</h3>
                <button className="btn btn-sm" onClick={() => open("new")}>
                    <Ic icon={Plus} size={14} />
                    Neues Format
                </button>
            </div>
            {formatsQuery.isPending && <SkeletonRows rows={2} plain />}
            <div className="row-list">
                {formats.map((f) => (
                    <div className="row-item" key={f.key}>
                        <span>
                            <b>{f.name}</b>
                            <small>
                                {f.builtin ? "Standardformat" : "Eigenes Format"} · {f.definition.steps.length ? plural(f.definition.steps.length, "Stufe", "Stufen") : "ohne Zerlegung"}
                            </small>
                        </span>
                        <span className="row-actions">
                            <button className="btn btn-sm btn-ghost" onClick={() => open(f.key)}>
                                <Ic icon={f.builtin ? Eye : Pencil} size={14} />
                                {f.builtin ? "Ansehen" : "Bearbeiten"}
                            </button>
                            <button
                                className="btn btn-sm btn-ghost"
                                disabled={action.pending}
                                onClick={async () => {
                                    const copy = await action.run(() => call(routes.createImportFormat, { body: { name: copyName(f.name, formats.map((x) => x.name)), definition: f.definition } }), {
                                        topics: ["importFormats"],
                                        ok: "Format kopiert",
                                    });
                                    if (copy) open(copy.key);
                                }}
                            >
                                <Ic icon={Copy} size={14} />
                                Kopieren
                            </button>
                            {f.id !== null && (
                                <button
                                    className="btn btn-sm btn-ghost"
                                    onClick={() =>
                                        ui.confirm({
                                            title: `Format „${f.name}“ löschen?`,
                                            text: "Bisherige Importe bleiben erhalten.",
                                            confirm: "Format löschen",
                                            danger: true,
                                            onConfirm: () => action.succeeds(() => call(routes.deleteImportFormat, { params: { id: f.id! } }), { topics: ["importFormats"], ok: "Format gelöscht" }),
                                        })
                                    }
                                >
                                    <Ic icon={Trash2} size={14} />
                                    Löschen
                                </button>
                            )}
                        </span>
                    </div>
                ))}
            </div>
        </section>
    );
}

const ACTION_LABELS: Record<string, string> = {
    setup: "Eingerichtet",
    unlock: "Entsperrt",
    lock: "Gesperrt",
    login: "Angemeldet",
    login_failed: "Anmeldung fehlgeschlagen",
    reauth_failed: "Bestätigung fehlgeschlagen",
    password_confirm_failed: "Passwortbestätigung fehlgeschlagen",
    logout: "Abgemeldet",
    totp_set_up: "Authenticator eingerichtet",
    totp_changed: "Authenticator gewechselt",
    totp_reset: "Authenticator zurückgesetzt",
    user_created: "Benutzer angelegt",
    user_renamed: "Benutzer umbenannt",
    user_deleted: "Benutzer entfernt",
    password_changed: "Passwort geändert",
    password_set: "Passwort gesetzt",
    password_recovered: "Passwort mit Wiederherstellungsschlüssel gesetzt",
    recovery_key_replaced: "Wiederherstellungsschlüssel ersetzt",
    session_locked: "Sitzung gesperrt",
    session_unlocked: "Sitzung entsperrt",
    device_created: "Geräte-Token erzeugt",
    device_revoked: "Gerät abgemeldet",
    account_created: "Konto angelegt",
    account_deleted: "Konto gelöscht",
    account_detached: "Konto vom Bankzugang gelöst",
    reconcile: "Saldo abgeglichen",
    counter_booking: "Gegenbuchung angelegt",
    category_deleted: "Kategorie gelöscht",
    import: "CSV importiert",
    import_undone: "Import rückgängig",
    import_removed: "Import aus Liste entfernt",
    sync: "Abgerufen",
    sync_failed: "Abruf fehlgeschlagen",
    transfer_submitted: "An die Bank gesendet",
    transfer_executed: "Von der Bank angenommen",
    transfer_rejected: "Von der Bank abgelehnt",
    transfer_failed: "Nicht gesendet",
    transfer_cancelled: "Abgebrochen",
    transfer_unknown: "Ausgang unbekannt",
};

function ActivityTab() {
    const activity = useActivity();
    const entries = activity.data ?? [];
    return (
        <section className="panel">
            <div className="panel-head"><h3>Aktivitätsprotokoll</h3><span className="muted small">die letzten 200 Einträge</span></div>
            {activity.isPending && <SkeletonRows rows={6} plain />}
            <div className="row-list">
                {entries.map((e) => (
                    <div className="row-item" key={e.id}>
                        <span>
                            <b>{ACTION_LABELS[e.action] ?? e.action}{e.target ? ` · ${e.target}` : ""}</b>
                            <small>{dateTime(e.createdAt)} · {e.userName ?? (e.action === "login_failed" ? "Unbekannt" : "System")}{e.details ? ` · ${e.details}` : ""}</small>
                        </span>
                        <span />
                    </div>
                ))}
            </div>
        </section>
    );
}
