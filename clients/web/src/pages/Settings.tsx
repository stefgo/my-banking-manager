import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Eye, FileUp, Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import { isOffline, routes } from "@mbm/shared";
import { settingsRoute } from "../router";
import { SETTINGS_TABS } from "../lib/settingsTabs";
import { call } from "../lib/api";
import { useAccounts, useAction, useActivity, useGroups, useImportFormats, useImports } from "../lib/queries";
import { useVersions, versionsText } from "../lib/versions";
import { copyText } from "../lib/clipboard";
import { dateTime, plural } from "../lib/format";
import { copyName } from "../lib/importFormat";
import { openImport } from "../lib/importNav";
import { accountsInTreeOrder } from "../lib/tree";
import { ui } from "../lib/ui";
import { Amt, Empty } from "../components/common";
import { AccountRow } from "../components/AccountRow";
import { BankAccessCards, BankDirectoryRow, BankStatusRows } from "../components/BankAccess";
import { SkeletonRows } from "../components/Skeleton";
import { Ic, Sym } from "../components/icons";
import { RulesTab } from "./Rules";
import { DeletedTab } from "./settings/DeletedTab";
import { ProfileTab } from "./settings/ProfileTab";
import { SystemTab } from "./settings/SystemTab";
import { VersionsTab } from "./settings/VersionsTab";
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
                    <p className="muted">Konten, Regeln, Importe, gelöschte Umsätze, dein Profil, Benutzer, System, Protokoll und Versionen</p>
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
                {tab === "versions" && <CopyVersionsButton />}
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
            {tab === "deleted" && <DeletedTab />}
            {tab === "profile" && <ProfileTab />}
            {tab === "users" && <UsersTab />}
            {tab === "system" && <SystemTab />}
            {tab === "activity" && <ActivityTab />}
            {tab === "versions" && <VersionsTab />}
            {addingUser && <NewUserDialog onClose={() => setAddingUser(false)} />}
        </>
    );
}

/** „Versionen kopieren“ in the head of the tab, e.g. for an error report. */
function CopyVersionsButton() {
    const versions = useVersions().data;
    return (
        <div className="head-actions">
            <button className="btn" disabled={!versions} onClick={() => versions && copyText(versionsText(versions))}>
                <Ic icon={Copy} size={16} />
                Versionen kopieren
            </button>
        </div>
    );
}

// ---------- Accounts ----------

function AccountsTab() {
    const accounts = accountsInTreeOrder(useGroups().data ?? [], useAccounts().data ?? []);
    const offline = accounts.filter((a) => isOffline(a));
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
                                <AccountRow
                                    key={a.id}
                                    account={a}
                                    detail={
                                        <small>
                                            Anfangssaldo <Amt cents={a.openingBalance ?? 0} /> · {plural(a.transactionCount, "Buchung", "Buchungen")}
                                        </small>
                                    }
                                />
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
                                            text: `${plural(i.remaining, "Buchung", "Buchungen")} aus dieser Datei ${i.remaining === 1 ? "wird" : "werden"} gelöscht.${i.deleted > 0 ? ` ${deletedGoText(i.deleted)}` : ""} Das lässt sich nicht rückgängig machen.`,
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
                                    onClick={() => {
                                        const remove = () => action.succeeds(() => call(routes.undoImport, { params: { id: i.id } }), { topics: ["imports", "accounts", "transactions", "categories"], ok: "Import aus der Liste entfernt" });
                                        // Deleted bookings keep a new import of the file from bringing them back; removing them is asked first
                                        if (i.deleted === 0) void remove();
                                        else ui.confirm({ title: `Import „${i.fileName}“ entfernen?`, text: deletedGoText(i.deleted), confirm: "Entfernen", danger: true, onConfirm: remove });
                                    }}
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

/** What removing an import does to its deleted bookings. */
function deletedGoText(n: number): string {
    return n === 1
        ? "Die gelöschte Buchung aus dieser Datei wird endgültig gelöscht. Importierst du die Datei noch einmal, kommt sie wieder."
        : `Die ${n} gelöschten Buchungen aus dieser Datei werden endgültig gelöscht. Importierst du die Datei noch einmal, kommen sie wieder.`;
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
    transaction_deleted: "Umsatz gelöscht",
    transaction_restored: "Umsatz wiederhergestellt",
    transaction_purged: "Umsatz endgültig gelöscht",
    category_deleted: "Kategorie gelöscht",
    import: "CSV importiert",
    import_undone: "Import rückgängig",
    import_removed: "Import aus Liste entfernt",
    bank_consent_given: "Freigabe bei der Bank erteilt",
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
