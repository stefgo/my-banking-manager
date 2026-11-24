import { useState } from "react";
import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { CLIENT_LABELS, ClientKind, routes, Theme, type Me } from "@mbm/shared";
import { call } from "../../lib/api";
import { showSecretError } from "../../lib/accessForm";
import { codeProblem, fieldProps, focusFirstError, type FieldErrors } from "../../lib/fields";
import { saveSetting, useAction, useClientSettings, useDevices, useMe } from "../../lib/queries";
import { THEME_LABELS } from "../../lib/theme";
import { Button, Switch } from "../../components/common";
import { CodeInput, Field } from "../../components/form";
import { SkeletonRows } from "../../components/Skeleton";
import { Ic } from "../../components/icons";
import { ChangePasswordDialog, ChangeTotpDialog } from "./AccessDialogs";
import { DeviceRows } from "./DeviceRows";

/** Everything that concerns only the signed-in user. */
export function ProfileTab() {
    return (
        <>
            <SignInPanel />
            <MyDevicesPanel />
            <AppearancePanels />
        </>
    );
}

function SignInPanel() {
    const [dialog, setDialog] = useState<"password" | "totp" | null>(null);
    return (
        <section className="panel">
            <div className="panel-head"><h3>Anmeldung</h3></div>
            <div className="row-list">
                <div className="row-item">
                    <span>
                        <b>Passwort</b>
                        <small>Deine Bankzugänge bleiben beim Ändern erhalten.</small>
                    </span>
                    <span className="row-actions">
                        <button className="btn btn-sm" onClick={() => setDialog("password")}>
                            <Ic icon={KeyRound} size={14} />
                            Ändern
                        </button>
                    </span>
                </div>
                <div className="row-item">
                    <span>
                        <b>Authenticator</b>
                        <small>Der bisherige gilt, bis du den neuen bestätigt hast.</small>
                    </span>
                    <span className="row-actions">
                        <button className="btn btn-sm" onClick={() => setDialog("totp")}>
                            <Ic icon={Smartphone} size={14} />
                            Wechseln
                        </button>
                    </span>
                </div>
            </div>
            {dialog === "password" && <ChangePasswordDialog onClose={() => setDialog(null)} />}
            {dialog === "totp" && <ChangeTotpDialog onClose={() => setDialog(null)} />}
        </section>
    );
}

function MyDevicesPanel() {
    const devicesQuery = useDevices();
    const me = useMe(true).data as Me | undefined;
    const devices = (devicesQuery.data ?? []).filter((d) => d.userId === me?.id);
    const idleMinutes = me?.sessionIdleMinutes ?? 0;
    const action = useAction();
    const [token, setToken] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    return (
        <section className="panel">
            <div className="panel-head">
                <h3>Meine Geräte</h3>
                <span className="muted small">
                    {idleMinutes > 0 ? `Browser sperren sich nach ${idleMinutes} Minuten ohne Eingabe` : "Browser sperren sich nicht bei Inaktivität"}
                </span>
            </div>
            {devicesQuery.isPending && <SkeletonRows rows={2} plain />}
            <DeviceRows devices={devices} />
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
                            onError: (err) => showSecretError(err, setErrors, { code: { id: "dev-code", clear: () => setCode("") } }),
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

function AppearancePanels() {
    const [client, setClient] = useState<ClientKind>("web");
    const s = useClientSettings(client);
    const label = CLIENT_LABELS[client];
    return (
        <>
            <section className="panel">
                <div className="panel-head">
                    <h3>Geräteklasse</h3>
                    <span className="muted small">Darstellung und Start gelten getrennt</span>
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
