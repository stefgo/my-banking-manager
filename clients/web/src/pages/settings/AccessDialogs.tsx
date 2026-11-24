import { useState } from "react";
import { Check, KeyRound } from "lucide-react";
import { routes } from "@mbm/shared";
import { ApiFailure, call } from "../../lib/api";
import { PASSWORD_HINT, passwordProblem, showSecretError } from "../../lib/accessForm";
import { codeProblem, fieldProps, focusFirstError, type FieldErrors } from "../../lib/fields";
import { useAction } from "../../lib/queries";
import { Button, Modal } from "../../components/common";
import { CodeInput, Field } from "../../components/form";
import { QrCode } from "../../components/QrCode";

const required = (value: string, message: string) => (value ? undefined : message);

// ---------- Own password ----------

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    const action = useAction();
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const problems: FieldErrors = {
            "pw-cur": required(current, "Bitte dein bisheriges Passwort eingeben."),
            "pw-next": passwordProblem(next),
            "pw-code": codeProblem(code),
        };
        setErrors(problems);
        if (focusFirstError(problems)) return;
        const r = await action.run(() => call(routes.changePassword, { body: { current, next, code } }), {
            topics: ["devices"],
            ok: "Passwort geändert, andere Sitzungen beendet",
            onError: (err) =>
                showSecretError(err, setErrors, {
                    password: { id: "pw-cur", clear: () => setCurrent("") },
                    code: { id: "pw-code", clear: () => setCode("") },
                }),
        });
        if (r) onClose();
    };
    return (
        <Modal title="Passwort ändern" onClose={onClose} narrow>
            <form className="form-grid" onSubmit={submit} noValidate>
                <Field id="pw-cur" label="Bisheriges Passwort" error={errors["pw-cur"]}>
                    <input className="inp" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} {...fieldProps("pw-cur", errors["pw-cur"])} />
                </Field>
                <Field id="pw-next" label="Neues Passwort" error={errors["pw-next"]} hint={PASSWORD_HINT}>
                    <input className="inp" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} {...fieldProps("pw-next", errors["pw-next"], true)} />
                </Field>
                <CodeInput id="pw-code" label="Dein Code aus der Authenticator-App" value={code} onChange={setCode} error={errors["pw-code"]} autoFocus={false} />
                <p className="hint">Deine Bankzugänge bleiben erhalten. Deine anderen Sitzungen werden beendet.</p>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Check} iconSize={14}>Passwort ändern</Button>
                </div>
            </form>
        </Modal>
    );
}

// ---------- Own second factor ----------

interface TotpSetup {
    setupToken: string;
    secret: string;
    uri: string;
}

/** The old app stays valid until the new one is confirmed, so closing this at any step is safe. */
export function ChangeTotpDialog({ onClose }: { onClose: () => void }) {
    const [setup, setSetup] = useState<TotpSetup | null>(null);
    return (
        <Modal title="Authenticator wechseln" onClose={onClose} narrow>
            {setup ? <TotpScanForm setup={setup} onExpired={() => setSetup(null)} onClose={onClose} /> : <TotpProofForm onStarted={setSetup} onClose={onClose} />}
        </Modal>
    );
}

function TotpProofForm({ onStarted, onClose }: { onStarted: (setup: TotpSetup) => void; onClose: () => void }) {
    const [password, setPassword] = useState("");
    const [withKey, setWithKey] = useState(false);
    const [code, setCode] = useState("");
    const [recoveryKey, setRecoveryKey] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    const action = useAction();
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const problems: FieldErrors = {
            "tc-pw": required(password, "Bitte dein Passwort eingeben."),
            ...(withKey ? { "tc-key": required(recoveryKey.trim(), "Bitte den Wiederherstellungsschlüssel eingeben.") } : { "tc-code": codeProblem(code) }),
        };
        setErrors(problems);
        if (focusFirstError(problems)) return;
        const r = await action.run(() => call(routes.startTotpChange, { body: withKey ? { password, recoveryKey } : { password, code } }), {
            onError: (err) =>
                showSecretError(err, setErrors, {
                    password: { id: "tc-pw", clear: () => setPassword("") },
                    code: { id: "tc-code", clear: () => setCode("") },
                    recoveryKey: { id: "tc-key", clear: () => setRecoveryKey("") },
                }),
        });
        if (r) onStarted(r);
    };
    return (
        <form className="form-grid" onSubmit={submit} noValidate>
            <p className="muted">Bestätige zuerst, dass du es bist. Dein bisheriger Authenticator gilt, bis du den neuen bestätigt hast.</p>
            <Field id="tc-pw" label="Dein Passwort" error={errors["tc-pw"]}>
                <input className="inp" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} {...fieldProps("tc-pw", errors["tc-pw"])} />
            </Field>
            {withKey ? (
                <Field id="tc-key" label="Wiederherstellungsschlüssel" error={errors["tc-key"]}>
                    <input className="inp mono" autoComplete="off" placeholder="XXXX-XXXX-…" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} {...fieldProps("tc-key", errors["tc-key"])} />
                </Field>
            ) : (
                <CodeInput id="tc-code" label="Code aus deiner bisherigen App" value={code} onChange={setCode} error={errors["tc-code"]} autoFocus={false} />
            )}
            <button
                type="button"
                className="link"
                style={{ justifySelf: "start" }}
                onClick={() => {
                    setWithKey(!withKey);
                    setErrors({});
                }}
            >
                <KeyRound size={14} aria-hidden="true" />
                {withKey ? "Doch mit dem Code bestätigen" : "Telefon nicht zur Hand? Mit Wiederherstellungsschlüssel"}
            </button>
            <div className="actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
                <Button className="btn-primary" type="submit" busy={action.pending}>Weiter</Button>
            </div>
        </form>
    );
}

function TotpScanForm({ setup, onExpired, onClose }: { setup: TotpSetup; onExpired: () => void; onClose: () => void }) {
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    const action = useAction();
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const problems: FieldErrors = { "tc-new": codeProblem(code) };
        setErrors(problems);
        if (focusFirstError(problems)) return;
        const r = await action.run(() => call(routes.confirmTotpChange, { body: { setupToken: setup.setupToken, code } }), {
            topics: ["users", "devices"],
            ok: "Authenticator gewechselt, andere Sitzungen beendet",
            onError: (err) => {
                // Too slow: the toast says so, and the first step starts again
                if (err instanceof ApiFailure && err.code === "setup_expired") {
                    onExpired();
                    return false;
                }
                return showSecretError(err, setErrors, { code: { id: "tc-new", clear: () => setCode("") } });
            },
        });
        if (r) onClose();
    };
    return (
        <form className="form-grid" onSubmit={submit} noValidate>
            <p className="muted">Scanne den Code mit der neuen Authenticator-App und gib den angezeigten Code ein.</p>
            <div style={{ display: "grid", justifyItems: "center", gap: 8 }}>
                <QrCode uri={setup.uri} />
                <p className="secret">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
            </div>
            <CodeInput id="tc-new" label="Code aus der neuen App" value={code} onChange={setCode} error={errors["tc-new"]} />
            <div className="actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
                <Button className="btn-primary" type="submit" busy={action.pending} icon={Check} iconSize={14}>Neuen Authenticator bestätigen</Button>
            </div>
        </form>
    );
}

// ---------- Password of another user ----------

export function ResetPasswordDialog({ user, onClose }: { user: { id: number; name: string }; onClose: () => void }) {
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
            ok: "Passwort zurückgesetzt",
            onError: (err) => showSecretError(err, setErrors, { code: { id: "sp-code", clear: () => setCode("") } }),
        });
        if (r) onClose();
    };
    return (
        <Modal title={`Passwort von ${user.name} zurücksetzen`} onClose={onClose} narrow>
            <form className="form-grid" onSubmit={submit} noValidate>
                <p className="muted">
                    {user.name} wird überall abgemeldet und muss Anmeldename und PIN der eigenen Bankzugänge neu eingeben. Konten und Umsätze bleiben.
                </p>
                <Field id="sp-pw" label="Neues Passwort" error={errors["sp-pw"]} hint={PASSWORD_HINT}>
                    <input className="inp" type="password" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} {...fieldProps("sp-pw", errors["sp-pw"], true)} />
                </Field>
                <CodeInput id="sp-code" label="Dein Code aus der Authenticator-App" value={code} onChange={setCode} error={errors["sp-code"]} autoFocus={false} />
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
                    <Button className="btn-danger" type="submit" busy={action.pending}>Zurücksetzen</Button>
                </div>
            </form>
        </Modal>
    );
}
