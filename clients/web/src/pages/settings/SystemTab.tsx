import { useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { routes } from "@mbm/shared";
import { call } from "../../lib/api";
import { showSecretError } from "../../lib/accessForm";
import { codeProblem, fieldProps, focusFirstError, type FieldErrors } from "../../lib/fields";
import { useAction } from "../../lib/queries";
import { Button } from "../../components/common";
import { CodeInput, Field } from "../../components/form";
import { Ic } from "../../components/icons";
import { lockServer } from "../../shell/session";

/** What concerns everybody who uses this installation. */
export function SystemTab() {
    const action = useAction();
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    const [recovery, setRecovery] = useState<string | null>(null);
    return (
        <>
            <section className="panel">
                <div className="panel-head">
                    <h3>Wiederherstellungsschlüssel</h3>
                    <span className="muted small">gilt für alle Benutzer</span>
                </div>
                {recovery ? (
                    <div className="form-grid">
                        <div className="recovery">{recovery}</div>
                        <p className="hint"><Ic icon={ShieldCheck} size={14} />Der alte Schlüssel gilt nicht mehr. Bewahre den neuen getrennt vom Server auf und gib ihn allen, die ihn brauchen.</p>
                        <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => setRecovery(null)}>Aufbewahrt</button>
                    </div>
                ) : (
                    <form
                        className="form-grid"
                        noValidate
                        onSubmit={async (e) => {
                            e.preventDefault();
                            const problems: FieldErrors = { "rk-pw": password ? undefined : "Bitte dein Passwort eingeben.", "rk-code": codeProblem(code) };
                            setErrors(problems);
                            if (focusFirstError(problems)) return;
                            const r = await action.run(() => call(routes.newRecoveryKey, { body: { password, code } }), {
                                onError: (err) =>
                                    showSecretError(err, setErrors, {
                                        password: { id: "rk-pw", clear: () => setPassword("") },
                                        code: { id: "rk-code", clear: () => setCode("") },
                                    }),
                            });
                            if (r) {
                                setRecovery(r.recoveryKey);
                                setPassword("");
                                setCode("");
                            }
                        }}
                    >
                        <p className="muted small">Er öffnet die Datenbank und hilft jedem Benutzer zurück, dem Passwort oder Telefon fehlen. Gespeicherte Bank-PINs öffnet er nicht. Ein neuer Schlüssel macht den bisherigen für alle ungültig.</p>
                        <Field id="rk-pw" label="Dein Passwort" error={errors["rk-pw"]}>
                            <input className="inp inp-sm" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} {...fieldProps("rk-pw", errors["rk-pw"])} />
                        </Field>
                        <CodeInput id="rk-code" label="Dein Code aus der Authenticator-App" value={code} onChange={setCode} error={errors["rk-code"]} autoFocus={false} />
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
