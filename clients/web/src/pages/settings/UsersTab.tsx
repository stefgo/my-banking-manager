import { Fragment, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, Trash2 } from "lucide-react";
import { routes, type Device, type Me, type User } from "@mbm/shared";
import { call } from "../../lib/api";
import { PASSWORD_HINT, passwordProblem, showSecretError } from "../../lib/accessForm";
import { dateTime, plural } from "../../lib/format";
import { codeProblem, fieldProps, focusFirstError, type FieldErrors } from "../../lib/fields";
import { invalidate, useAction, useDevices, useMe, useUsers } from "../../lib/queries";
import { ui } from "../../lib/ui";
import { Button, Modal } from "../../components/common";
import { CodeInput, Field } from "../../components/form";
import { SkeletonRows } from "../../components/Skeleton";
import { Ic } from "../../components/icons";
import { ResetPasswordDialog } from "./AccessDialogs";
import { DeviceRows } from "./DeviceRows";

/** The users of this installation. What concerns the signed-in user is in the profile. */
export function UsersTab() {
    const usersQuery = useUsers();
    const users = usersQuery.data ?? [];
    const devices = useDevices().data ?? [];
    const me = useMe(true).data as Me | undefined;
    const navigate = useNavigate();
    const [pwFor, setPwFor] = useState<User | null>(null);
    return (
        <section className="panel">
            <div className="panel-head">
                <h3>Benutzer</h3>
            </div>
            <p className="muted small" style={{ marginBottom: 8 }}>Alle Benutzer sehen und bedienen alle Konten. Jeder hat ein eigenes Passwort, eine eigene Authenticator-App und ein eigenes Profil.</p>
            {usersQuery.isPending && <SkeletonRows rows={2} plain />}
            <div className="row-list">
                {users.map((u) =>
                    u.id === me?.id ? (
                        <div className="row-item" key={u.id}>
                            <span>
                                <b>{u.name} (du)</b>
                                <small>{u.lastLoginAt ? `zuletzt ${dateTime(u.lastLoginAt)}` : "noch nie angemeldet"}</small>
                            </span>
                            <span className="row-actions">
                                <button className="btn btn-sm btn-ghost" onClick={() => void navigate({ to: "/settings", search: { tab: "profile" } })}>
                                    In deinem Profil verwalten
                                    <Ic icon={ArrowRight} size={14} />
                                </button>
                            </span>
                        </div>
                    ) : (
                        <OtherUserRow key={u.id} user={u} devices={devices.filter((d) => d.userId === u.id)} onResetPassword={() => setPwFor(u)} />
                    ),
                )}
            </div>
            {pwFor && <ResetPasswordDialog user={pwFor} onClose={() => setPwFor(null)} />}
        </section>
    );
}

function OtherUserRow({ user, devices, onResetPassword }: { user: User; devices: Device[]; onResetPassword: () => void }) {
    const [showDevices, setShowDevices] = useState(false);
    const open = showDevices && devices.length > 0;
    return (
        <Fragment>
            <div className="row-item">
                <span>
                    <b>{user.name}</b>
                    <small>
                        {user.totpActive ? "Authenticator eingerichtet" : "Authenticator wird bei der nächsten Anmeldung eingerichtet"} · {user.lastLoginAt ? `zuletzt ${dateTime(user.lastLoginAt)}` : "noch nie angemeldet"}
                    </small>
                </span>
                <span className="row-actions">
                    <button className="btn btn-sm btn-ghost" aria-expanded={open} disabled={devices.length === 0} onClick={() => setShowDevices(!showDevices)}>
                        {plural(devices.length, "Gerät", "Geräte")}
                        {devices.length > 0 && <Ic icon={ChevronDown} size={14} />}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={onResetPassword}>Passwort zurücksetzen</button>
                    <button
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                            ui.confirmSecret({
                                secret: "password",
                                title: `Authenticator von ${user.name} zurücksetzen?`,
                                text: "Bei der nächsten Anmeldung wird die Authenticator-App neu eingerichtet. Laufende Sitzungen werden beendet, die Bankzugänge bleiben. Bitte bestätige mit deinem Passwort.",
                                confirm: "Zurücksetzen",
                                run: (password) => call(routes.resetUserTotp, { params: { id: user.id }, body: { password } }),
                                onDone: () => {
                                    invalidate("users", "devices");
                                    ui.toast("Authenticator zurückgesetzt");
                                },
                            })
                        }
                    >
                        Authenticator zurücksetzen
                    </button>
                    <button
                        className="btn btn-sm btn-ghost btn-danger"
                        aria-label={`${user.name} entfernen`}
                        onClick={() =>
                            ui.confirmSecret({
                                secret: "code",
                                title: `„${user.name}“ entfernen?`,
                                text: "Der Benutzer und sein Profil werden gelöscht, seine Geräte abgemeldet. Konten und Umsätze bleiben. Das lässt sich nicht rückgängig machen.",
                                confirm: "Entfernen",
                                danger: true,
                                run: (code) => call(routes.deleteUser, { params: { id: user.id }, body: { code } }),
                                onDone: () => {
                                    invalidate("users", "devices");
                                    ui.toast("Benutzer entfernt");
                                },
                            })
                        }
                    >
                        <Ic icon={Trash2} size={14} />
                    </button>
                </span>
            </div>
            {open && (
                <div className="row-sub">
                    <DeviceRows devices={devices} />
                </div>
            )}
        </Fragment>
    );
}

export function NewUserDialog({ onClose }: { onClose: () => void }) {
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
            onError: (err) => showSecretError(err, setErrors, { code: { id: "nu-code", clear: () => setCode("") } }),
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
