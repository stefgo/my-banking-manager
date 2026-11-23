import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy, Eye, FileUp, Lock, Pencil, Plus, ShieldCheck, Trash2, Undo2, Wand2 } from "lucide-react";
import { CLIENT_LABELS, ClientKind, routes, Theme, type Me } from "@mbm/shared";
import { settingsRoute } from "../router";
import { SETTINGS_TABS } from "../lib/settingsTabs";
import { call, errorText, isSecretError } from "../lib/api";
import { invalidate, saveSetting, useAccounts, useAction, useActivity, useDevices, useClientSettings, useImportFormats, useImports, useMe, useStatus, useUsers } from "../lib/queries";
import { useConnectorStatus } from "../lib/bank";
import { dateTime, plural } from "../lib/format";
import { codeProblem, fieldProps, focusFirstError, type FieldErrors } from "../lib/fields";
import { copyName } from "../lib/importFormat";
import { openImport } from "../lib/importNav";
import { confirmDeleteAccount } from "../lib/menus";
import { openRunRules } from "../lib/rules";
import { THEME_LABELS } from "../lib/theme";
import { ui } from "../lib/ui";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { Amt, Empty, Modal, Switch, Button } from "../components/common";
import { BankAccessCards, BankDirectoryRow, BankStatusRows } from "../components/BankAccess";
import { CodeInput, Field } from "../components/form";
import { SkeletonRows } from "../components/Skeleton";
import { Ic, Sym, Tile } from "../components/icons";
import { lockServer } from "../shell/session";
import { RulesTab } from "./Rules";

export function SettingsPage() {
    const { tab = "accounts" } = settingsRoute.useSearch();
    const navigate = useNavigate();
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Einstellungen</h1>
                    <p className="muted">Kontoabfrage, Konten, Regeln, Benutzer und Sicherheit</p>
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
                        <button className="btn" onClick={() => openRunRules()}>
                            <Ic icon={Wand2} size={16} />
                            Regeln ausführen
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
            {tab === "users" && <UsersTab />}
            {tab === "devices" && <DevicesTab />}
            {tab === "profile" && <ProfileTab />}
            {tab === "security" && <SecurityTab />}
            {tab === "imports" && <ImportsTab />}
            {tab === "activity" && <ActivityTab />}
            <Versions />
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

// ---------- Users ----------

const MIN_PASSWORD = 12;
const PASSWORD_HINT = `Mindestens ${MIN_PASSWORD} Zeichen.`;

function passwordProblem(pw: string): string | undefined {
    if (!pw) return "Bitte ein Passwort eingeben.";
    return pw.length < MIN_PASSWORD ? `Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.` : undefined;
}

/** A wrong or used code shows at its field, which is emptied; true = handled. */
function codeFieldError(err: unknown, id: string, setErrors: (f: (e: FieldErrors) => FieldErrors) => void, setCode: (c: string) => void): boolean {
    if (!isSecretError(err)) return false;
    setErrors((e) => ({ ...e, [id]: errorText(err) }));
    setCode("");
    focusFirstError({ [id]: errorText(err) });
    return true;
}

function UsersTab() {
    const usersQuery = useUsers();
    const users = usersQuery.data ?? [];
    const me = useMe(true).data as Me | undefined;
    const [adding, setAdding] = useState(false);
    const [pwFor, setPwFor] = useState<{ id: number; name: string } | null>(null);
    return (
        <section className="panel">
            <div className="panel-head">
                <h3>Benutzer</h3>
                <button className="btn btn-sm" onClick={() => setAdding(true)}>
                    <Ic icon={Plus} size={14} />
                    Benutzer hinzufügen
                </button>
            </div>
            <p className="muted small" style={{ marginBottom: 8 }}>Alle Benutzer sehen und bedienen alle Konten. Jeder hat ein eigenes Passwort, eine eigene Authenticator-App und ein eigenes Profil.</p>
            {usersQuery.isPending && <SkeletonRows rows={2} plain />}
            <div className="row-list">
                {users.map((u) => (
                    <div className="row-item" key={u.id}>
                        <span>
                            <b>{u.name}{u.id === me?.id ? " (du)" : ""}</b>
                            <small>
                                {u.totpActive ? "Authenticator eingerichtet" : "Authenticator wird bei der ersten Anmeldung eingerichtet"} · {u.lastLoginAt ? `zuletzt ${dateTime(u.lastLoginAt)}` : "noch nie angemeldet"}
                            </small>
                        </span>
                        <span className="row-actions">
                            <button className="btn btn-sm btn-ghost" onClick={() => setPwFor(u)}>Passwort setzen</button>
                            <button
                                className="btn btn-sm btn-ghost"
                                onClick={() =>
                                    ui.confirmSecret({
                                        secret: "password",
                                        title: u.id === me?.id ? "Eigenen Authenticator zurücksetzen?" : `Authenticator von ${u.name} zurücksetzen?`,
                                        text:
                                            u.id === me?.id
                                                ? "Du wirst abgemeldet und richtest die Authenticator-App bei der nächsten Anmeldung neu ein. Bitte bestätige mit deinem Passwort."
                                                : "Bei der nächsten Anmeldung wird die Authenticator-App neu eingerichtet. Laufende Sitzungen werden beendet. Bitte bestätige mit deinem Passwort.",
                                        confirm: "Zurücksetzen",
                                        run: (password) => call(routes.resetUserTotp, { params: { id: u.id }, body: { password } }),
                                        onDone: () => {
                                            invalidate("users", "devices");
                                            ui.toast("Authenticator zurückgesetzt");
                                        },
                                    })
                                }
                            >
                                Authenticator neu
                            </button>
                            {u.id !== me?.id && (
                                <button
                                    className="btn btn-sm btn-ghost btn-danger"
                                    aria-label={`${u.name} entfernen`}
                                    onClick={() =>
                                        ui.confirmSecret({
                                            secret: "code",
                                            title: `„${u.name}“ entfernen?`,
                                            text: "Der Benutzer und sein Profil werden gelöscht, seine Geräte abgemeldet. Konten und Umsätze bleiben. Das lässt sich nicht rückgängig machen.",
                                            confirm: "Entfernen",
                                            danger: true,
                                            run: (code) => call(routes.deleteUser, { params: { id: u.id }, body: { code } }),
                                            onDone: () => {
                                                invalidate("users", "devices");
                                                ui.toast("Benutzer entfernt");
                                            },
                                        })
                                    }
                                >
                                    <Ic icon={Trash2} size={14} />
                                </button>
                            )}
                        </span>
                    </div>
                ))}
            </div>
            {adding && <NewUserDialog onClose={() => setAdding(false)} />}
            {pwFor && <SetPasswordDialog user={pwFor} onClose={() => setPwFor(null)} />}
        </section>
    );
}

function NewUserDialog({ onClose }: { onClose: () => void }) {
    const [name, setName] = useState("");
    const [pw, setPw] = useState("");
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    const action = useAction();
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const next: FieldErrors = {
            "nu-name": name.trim() ? undefined : "Bitte einen Namen eingeben.",
            "nu-pw": passwordProblem(pw),
            "nu-code": codeProblem(code),
        };
        setErrors(next);
        if (focusFirstError(next)) return;
        const r = await action.run(() => call(routes.createUser, { body: { name: name.trim(), password: pw, code } }), {
            topics: ["users"],
            ok: (u) => `${u.name} angelegt`,
            onError: (err) => codeFieldError(err, "nu-code", setErrors, setCode),
        });
        if (r) onClose();
    };
    return (
        <Modal title="Benutzer hinzufügen" onClose={onClose} narrow>
            <form className="form-grid" onSubmit={submit} noValidate>
                <Field id="nu-name" label="Name" error={errors["nu-name"]}>
                    <input className="inp" autoComplete="off" autoFocus value={name} onChange={(e) => setName(e.target.value)} {...fieldProps("nu-name", errors["nu-name"])} />
                </Field>
                <Field id="nu-pw" label="Erstes Passwort" error={errors["nu-pw"]} hint={PASSWORD_HINT}>
                    <input className="inp" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} {...fieldProps("nu-pw", errors["nu-pw"], true)} />
                </Field>
                <p className="hint">Die Authenticator-App richtet der neue Benutzer bei seiner ersten Anmeldung ein.</p>
                <CodeInput id="nu-code" label="Dein Code aus der Authenticator-App" value={code} onChange={setCode} error={errors["nu-code"]} autoFocus={false} />
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending}>Anlegen</Button>
                </div>
            </form>
        </Modal>
    );
}

function SetPasswordDialog({ user, onClose }: { user: { id: number; name: string }; onClose: () => void }) {
    const [pw, setPw] = useState("");
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    const action = useAction();
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const next: FieldErrors = { "sp-pw": passwordProblem(pw), "sp-code": codeProblem(code) };
        setErrors(next);
        if (focusFirstError(next)) return;
        const r = await action.run(() => call(routes.setUserPassword, { params: { id: user.id }, body: { password: pw, code } }), {
            topics: ["devices"],
            ok: "Passwort gesetzt",
            onError: (err) => codeFieldError(err, "sp-code", setErrors, setCode),
        });
        if (r) onClose();
    };
    return (
        <Modal title={`Passwort für ${user.name}`} onClose={onClose} narrow>
            <form className="form-grid" onSubmit={submit} noValidate>
                <Field id="sp-pw" label="Neues Passwort" error={errors["sp-pw"]} hint={PASSWORD_HINT}>
                    <input className="inp" type="password" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} {...fieldProps("sp-pw", errors["sp-pw"], true)} />
                </Field>
                <p className="hint">Andere Sitzungen dieses Benutzers werden beendet.</p>
                <CodeInput id="sp-code" label="Dein Code aus der Authenticator-App" value={code} onChange={setCode} error={errors["sp-code"]} autoFocus={false} />
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending}>Speichern</Button>
                </div>
            </form>
        </Modal>
    );
}

// ---------- Devices ----------

function DevicesTab() {
    const devicesQuery = useDevices();
    const devices = devicesQuery.data ?? [];
    const users = useUsers().data ?? [];
    const idleMinutes = (useMe(true).data as Me | undefined)?.sessionIdleMinutes ?? 0;
    const action = useAction();
    const [token, setToken] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    return (
        <section className="panel">
            <div className="panel-head">
                <h3>Angemeldete Browser und Geräte</h3>
                <span className="muted small">
                    {idleMinutes > 0 ? `Browser sperren sich nach ${idleMinutes} Minuten ohne Eingabe` : "Browser sperren sich nicht bei Inaktivität"}
                </span>
            </div>
            {devicesQuery.isPending && <SkeletonRows rows={2} plain />}
            <div className="row-list">
                {devices.map((d) => (
                    <div className="row-item" key={d.id}>
                        <span>
                            <b>{d.name}{d.current ? " (dieses Gerät)" : ""}</b>
                            <small>
                                {users.find((u) => u.id === d.userId)?.name ?? "?"} · {d.kind === "web" ? "Browser" : "Geräte-Token"} · angemeldet {dateTime(d.createdAt)}
                                {d.lastSeenAt ? ` · zuletzt ${dateTime(d.lastSeenAt)}` : ""}
                            </small>
                        </span>
                        <span className="row-actions">
                            <button
                                className="btn btn-sm btn-ghost btn-danger"
                                onClick={() =>
                                    ui.confirm({
                                        title: `„${d.name}“ abmelden?`,
                                        text: d.current ? "Du wirst auf diesem Gerät abgemeldet." : "Das Gerät muss sich neu anmelden.",
                                        confirm: "Abmelden",
                                        onConfirm: () => action.succeeds(() => call(routes.revokeDevice, { params: { id: d.id } }), { topics: ["devices"], ok: "Abgemeldet" }),
                                    })
                                }
                            >
                                Abmelden
                            </button>
                        </span>
                    </div>
                ))}
            </div>
            <div className="panel-head" style={{ marginTop: 18 }}>
                <h3>Geräte-Token für den macOS-Client</h3>
            </div>
            {token ? (
                <div className="form-grid">
                    <div className="recovery">{token}</div>
                    <p className="hint"><Ic icon={ShieldCheck} size={14} />Nur jetzt sichtbar. Trage es im macOS-Client ein; dort liegt es im Schlüsselbund.</p>
                    <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => setToken(null)}>Fertig</button>
                </div>
            ) : (
                <form
                    className="form-grid"
                    noValidate
                    onSubmit={async (e) => {
                        e.preventDefault();
                        const next: FieldErrors = {
                            "dev-name": name.trim() ? undefined : "Bitte einen Namen für das Gerät eingeben.",
                            "dev-code": codeProblem(code),
                        };
                        setErrors(next);
                        if (focusFirstError(next)) return;
                        const r = await action.run(() => call(routes.createDevice, { body: { name: name.trim(), code } }), {
                            topics: ["devices"],
                            onError: (err) => codeFieldError(err, "dev-code", setErrors, setCode),
                        });
                        if (r) {
                            setToken(r.token);
                            setName("");
                            setCode("");
                        }
                    }}
                >
                    <Field id="dev-name" label="Gerätename" error={errors["dev-name"]}>
                        <input className="inp inp-sm" placeholder="z. B. MacBook Pro" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} {...fieldProps("dev-name", errors["dev-name"])} />
                    </Field>
                    <CodeInput id="dev-code" label="Dein Code aus der Authenticator-App" value={code} onChange={setCode} error={errors["dev-code"]} autoFocus={false} />
                    <Button className="btn-sm" style={{ justifySelf: "start" }} type="submit" busy={action.pending}>Token erzeugen</Button>
                </form>
            )}
        </section>
    );
}

// ---------- Profile ----------

function ProfileTab() {
    const [client, setClient] = useState<ClientKind>("web");
    const s = useClientSettings(client);
    const label = CLIENT_LABELS[client];
    return (
        <>
            <section className="panel">
                <div className="panel-head">
                    <h3>Dein Profil</h3>
                    <span className="muted small">getrennt je Geräteklasse</span>
                </div>
                <div className="seg" role="group" aria-label="Geräteklasse">
                    {ClientKind.options.map((c) => (
                        <button key={c} aria-pressed={client === c} onClick={() => setClient(c)}>
                            {CLIENT_LABELS[c]}
                            {c === "web" ? " · dieses Gerät" : ""}
                        </button>
                    ))}
                </div>
            </section>
            <section className="panel">
                <div className="panel-head">
                    <h3>Nur für {label}</h3>
                    <span className="muted small">
                        {client === "web" ? "gilt in jedem Browser, in dem du dich anmeldest" : "gilt im macOS-Client, nicht in diesem Browser"}
                    </span>
                </div>
                {s ? (
                    <div className="form-grid" style={{ maxWidth: "none", gap: 18 }}>
                        <div className="switch-row">
                            <span>
                                <b>Darstellung</b>
                            </span>
                            <div className="seg" role="group" aria-label={`Darstellung ${label}`}>
                                {Theme.options.map((t) => (
                                    <button key={t} aria-pressed={s.theme === t} onClick={() => void saveSetting("theme", t, client)}>
                                        {THEME_LABELS[t]}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="switch-row">
                            <span>
                                <b>Beträge beim Start ausblenden</b>
                                <small>Mit H jederzeit ein- und ausblenden</small>
                            </span>
                            <Switch
                                checked={s.hideAmountsOnStart}
                                label={`Beträge beim Start ausblenden (${label})`}
                                onChange={(v) => void saveSetting("hideAmountsOnStart", v, client)}
                            />
                        </div>
                    </div>
                ) : (
                    <div aria-busy="true" style={{ minHeight: 80 }} />
                )}
            </section>
        </>
    );
}

// ---------- Security ----------

function SecurityTab() {
    const action = useAction();
    const [cur, setCur] = useState("");
    const [next, setNext] = useState("");
    const [pwErrors, setPwErrors] = useState<FieldErrors>({});
    const [rkPass, setRkPass] = useState("");
    const [rkError, setRkError] = useState<string | undefined>();
    const [recovery, setRecovery] = useState<string | null>(null);
    return (
        <>
            <section className="panel">
                <div className="panel-head"><h3>Dein Passwort</h3></div>
                <form
                    className="form-grid"
                    noValidate
                    onSubmit={async (e) => {
                        e.preventDefault();
                        const errors: FieldErrors = {
                            "pw-cur": cur ? undefined : "Bitte dein bisheriges Passwort eingeben.",
                            "pw-next": passwordProblem(next),
                        };
                        setPwErrors(errors);
                        if (focusFirstError(errors)) return;
                        const r = await action.run(() => call(routes.changePassword, { body: { current: cur, next } }), { ok: "Passwort geändert, andere Sitzungen beendet" });
                        if (r) {
                            setCur("");
                            setNext("");
                        }
                    }}
                >
                    <Field id="pw-cur" label="Bisheriges Passwort" error={pwErrors["pw-cur"]}>
                        <input className="inp inp-sm" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} {...fieldProps("pw-cur", pwErrors["pw-cur"])} />
                    </Field>
                    <Field id="pw-next" label="Neues Passwort" error={pwErrors["pw-next"]} hint={PASSWORD_HINT}>
                        <input className="inp inp-sm" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} {...fieldProps("pw-next", pwErrors["pw-next"], true)} />
                    </Field>
                    <Button className="btn-sm" style={{ justifySelf: "start" }} type="submit" busy={action.pending} icon={Check} iconSize={14}>
                        Passwort ändern
                    </Button>
                </form>
            </section>
            <section className="panel">
                <div className="panel-head"><h3>Wiederherstellungsschlüssel</h3></div>
                {recovery ? (
                    <div className="form-grid">
                        <div className="recovery">{recovery}</div>
                        <p className="hint"><Ic icon={ShieldCheck} size={14} />Der alte Schlüssel gilt nicht mehr. Bewahre den neuen getrennt vom Server auf.</p>
                        <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => setRecovery(null)}>Aufbewahrt</button>
                    </div>
                ) : (
                    <form
                        className="form-grid"
                        noValidate
                        onSubmit={async (e) => {
                            e.preventDefault();
                            const problem = rkPass ? undefined : "Bitte dein Passwort eingeben.";
                            setRkError(problem);
                            if (focusFirstError({ "rk-pw": problem })) return;
                            const r = await action.run(() => call(routes.newRecoveryKey, { body: { password: rkPass } }));
                            if (r) {
                                setRecovery(r.recoveryKey);
                                setRkPass("");
                            }
                        }}
                    >
                        <Field id="rk-pw" label="Dein Passwort" error={rkError} hint="Zur Bestätigung; der alte Schlüssel gilt danach nicht mehr.">
                            <input className="inp inp-sm" type="password" autoComplete="current-password" value={rkPass} onChange={(e) => setRkPass(e.target.value)} {...fieldProps("rk-pw", rkError, true)} />
                        </Field>
                        <Button className="btn-sm" style={{ justifySelf: "start" }} type="submit" busy={action.pending}>Neuen Schlüssel erzeugen</Button>
                    </form>
                )}
            </section>
            <section className="panel">
                <div className="panel-head"><h3>MBM für alle sperren</h3></div>
                <p className="muted small" style={{ marginBottom: 12 }}>Schließt die Datenbank und sperrt alle angemeldeten Benutzer und Geräte, bis sich jemand mit seinem Passwort anmeldet. Nur dieses Gerät beenden: „Abmelden“ im Benutzermenü.</p>
                <button className="btn btn-sm" onClick={() => lockServer()}>
                    <Ic icon={Lock} size={14} />
                    Jetzt für alle sperren
                </button>
            </section>
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
