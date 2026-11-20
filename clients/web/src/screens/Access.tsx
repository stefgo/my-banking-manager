// Screens before the app: set up, sign in (with TOTP set-up), locked, password lost.
// One password does it all: it signs in, opens a locked session and opens the locked database.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import QRCode from "qrcode";
import { Check, KeyRound, Lock, LogOut, ShieldCheck } from "lucide-react";
import { routes, type Me } from "@mbm/shared";
import { ApiFailure, call, errorText } from "../lib/api";
import { queryClient } from "../lib/queries";
import { codeProblem, fieldProps, focusFirstError, type FieldErrors } from "../lib/fields";
import { Hint, Button } from "../components/common";
import { CodeInput, Field } from "../components/form";
import { Ic, Mark } from "../components/icons";

function Screen({ title, text, children, foot }: { title: string; text?: ReactNode; children: ReactNode; foot?: ReactNode }) {
    return (
        <div className="center-screen">
            <div className="lock-card">
                <span className="mark mark-lg">
                    <Mark size={30} />
                </span>
                <h2>{title}</h2>
                {text && <p className="muted">{text}</p>}
                {children}
                {foot && <p className="faint small">{foot}</p>}
            </div>
        </div>
    );
}

const MIN_PASSWORD = 12;

interface TotpSetup {
    setupToken: string;
    secret: string;
    uri: string;
}

/** After a successful sign-in: forget what was shown before, then let Gate show the app. */
async function signedIn(user: Me): Promise<void> {
    // Keep the status query: Gate observes it, and clear() would detach it
    queryClient.removeQueries({ predicate: (q) => !["status", "me"].includes(String(q.queryKey[0])) });
    await queryClient.refetchQueries({ queryKey: ["status"] });
    queryClient.setQueryData(["me"], user);
}

/** Errors of a new password and its repetition, by field id. */
function checkNewPassword(pw: string, pw2: string, ids: { pw: string; pw2: string }): FieldErrors {
    return {
        [ids.pw]: pw.length < MIN_PASSWORD ? `Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.` : undefined,
        [ids.pw2]: pw.length >= MIN_PASSWORD && pw !== pw2 ? "Die beiden Passwörter stimmen nicht überein." : undefined,
    };
}

const PASSWORD_HINT = `Mindestens ${MIN_PASSWORD} Zeichen.`;


// ---------- Second factor ----------

function QrCode({ uri }: { uri: string }) {
    const [svg, setSvg] = useState("");
    useEffect(() => {
        let alive = true;
        void QRCode.toString(uri, { type: "svg", margin: 0, errorCorrectionLevel: "M" }).then((s) => alive && setSvg(s));
        return () => {
            alive = false;
        };
    }, [uri]);
    // The SVG is generated locally from the otpauth URI; it never leaves the browser
    return <div className="qr" role="img" aria-label="QR-Code für die Authenticator-App" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Shows a new TOTP secret and signs in with the first code. */
function TotpSetupScreen({ setup, onExpired }: { setup: TotpSetup; onExpired: () => void }) {
    const [code, setCode] = useState("");
    const [codeError, setCodeError] = useState<string | undefined>();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setError("");
        const problem = codeProblem(code);
        setCodeError(problem);
        if (focusFirstError({ code: problem })) return;
        setBusy(true);
        try {
            const r = await call(routes.confirmTotp, { body: { setupToken: setup.setupToken, code, client: "web" } });
            if (r.status === "ok") await signedIn(r.user);
        } catch (err) {
            setCode("");
            // Too slow, or the server locked itself meanwhile: start again with the password
            if (err instanceof ApiFailure && (err.code === "setup_expired" || err.code === "locked")) onExpired();
            else setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Screen title="Anmeldung absichern" text="Scanne den Code mit einer Authenticator-App (z. B. Passwörter auf dem iPhone, 2FAS, Aegis) und gib den angezeigten Code ein.">
            <QrCode uri={setup.uri} />
            <p className="secret">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
            <form onSubmit={submit} noValidate>
                <CodeInput value={code} onChange={setCode} error={codeError} />
                <Button className="btn-primary btn-lg" type="submit" busy={busy} icon={Check} iconSize={16}>
                    Bestätigen und anmelden
                </Button>
                {error && <Hint tone="bad">{error}</Hint>}
            </form>
        </Screen>
    );
}

// ---------- Set-up ----------

export function SetupScreen() {
    const [name, setName] = useState("");
    const [pw, setPw] = useState("");
    const [pw2, setPw2] = useState("");
    const [defaultCategories, setDefaultCategories] = useState(true);
    const [defaultAccountGroups, setDefaultAccountGroups] = useState(true);
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ recoveryKey: string; totp: TotpSetup } | null>(null);
    const [kept, setKept] = useState(false);
    const [step, setStep] = useState<"form" | "recovery" | "totp">("form");

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setError("");
        const problems: FieldErrors = { "su-name": name.trim() ? undefined : "Bitte einen Namen eingeben.", ...checkNewPassword(pw, pw2, { pw: "su-pw", pw2: "su-pw2" }) };
        setFieldErrors(problems);
        if (focusFirstError(problems)) return;
        setBusy(true);
        try {
            setResult(await call(routes.setup, { body: { name, password: pw, defaultCategories, defaultAccountGroups } }));
            setPw("");
            setPw2("");
            setStep("recovery");
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    if (step === "totp" && result) {
        // Set up already; when the code comes too late, the sign-in screen starts TOTP again
        return <TotpSetupScreen setup={result.totp} onExpired={() => void queryClient.refetchQueries({ queryKey: ["status"] })} />;
    }

    if (step === "recovery" && result) {
        return (
            <Screen title="Wiederherstellungsschlüssel" text="Wenn du dein Passwort vergisst, öffnet nur dieser Schlüssel deine Daten. MBM zeigt ihn nur jetzt.">
                <div className="recovery" aria-label="Wiederherstellungsschlüssel">{result.recoveryKey}</div>
                <p className="hint">
                    <Ic icon={ShieldCheck} size={14} />
                    Drucke ihn aus oder lege ihn in deinen Passwortmanager, getrennt vom Server.
                </p>
                <label className="check-row">
                    <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
                    <span>Ich habe den Wiederherstellungsschlüssel sicher aufbewahrt.</span>
                </label>
                <button className="btn btn-primary btn-lg" disabled={!kept} onClick={() => setStep("totp")}>
                    Weiter
                </button>
            </Screen>
        );
    }

    return (
        <Screen
            title="MBM einrichten"
            text="Lege den ersten Benutzer an. Sein Passwort verschlüsselt alle Daten und entsperrt MBM nach jedem Neustart."
            foot="Ohne Passwort und Wiederherstellungsschlüssel sind die Daten verloren."
        >
            <form onSubmit={submit} noValidate>
                <Field id="su-name" label="Name" error={fieldErrors["su-name"]}>
                    <input className="inp" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} autoFocus {...fieldProps("su-name", fieldErrors["su-name"])} />
                </Field>
                <Field id="su-pw" label="Passwort" error={fieldErrors["su-pw"]} hint={PASSWORD_HINT}>
                    <input className="inp" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} {...fieldProps("su-pw", fieldErrors["su-pw"], true)} />
                </Field>
                <Field id="su-pw2" label="Passwort wiederholen" error={fieldErrors["su-pw2"]}>
                    <input className="inp" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} {...fieldProps("su-pw2", fieldErrors["su-pw2"])} />
                </Field>
                <label className="check-row">
                    <input type="checkbox" checked={defaultCategories} onChange={(e) => setDefaultCategories(e.target.checked)} />
                    <span>Start-Kategorien anlegen (z. B. Wohnen, Lebensmittel, Einkommen)</span>
                </label>
                <label className="check-row">
                    <input type="checkbox" checked={defaultAccountGroups} onChange={(e) => setDefaultAccountGroups(e.target.checked)} />
                    <span>Start-Kontengruppen anlegen</span>
                </label>
                <Button className="btn-primary btn-lg" type="submit" busy={busy} icon={Lock} iconSize={16}>
                    {busy ? "Verschlüssele …" : "Einrichten"}
                </Button>
                {error && <Hint tone="bad">{error}</Hint>}
            </form>
        </Screen>
    );
}

// ---------- Sign in, also into a locked server or a locked session ----------

/**
 * `lockedAs`: the user of this window, known from before the lock. Then only the password is
 * asked. `serverLocked` changes the wording only; the request is the same in every case.
 */
export function LoginScreen({ lockedAs, serverLocked = false }: { lockedAs?: Me; serverLocked?: boolean }) {
    const [typedName, setTypedName] = useState("");
    const [pw, setPw] = useState("");
    const [pw2, setPw2] = useState("");
    const [recoveryKey, setRecoveryKey] = useState("");
    const [code, setCode] = useState("");
    const [step, setStep] = useState<"password" | "code" | "setup" | "recover">("password");
    const [setup, setSetup] = useState<TotpSetup | null>(null);
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const name = lockedAs?.name ?? typedName;

    const restart = () => {
        setStep("password");
        setSetup(null);
        setCode("");
        setPw("");
        setPw2("");
        setRecoveryKey("");
        setFieldErrors({});
        setError("");
    };

    const login = async (withCode: boolean) => {
        const r = await call(routes.login, { body: { name, password: pw, code: withCode ? code : undefined, client: "web" } });
        if (r.status === "ok") {
            await signedIn(r.user);
            restart();
        } else if (r.status === "code_required") {
            setStep("code");
        } else {
            setSetup(r);
            setStep("setup");
        }
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setError("");
        const nameProblem = name.trim() ? undefined : "Bitte deinen Namen eingeben.";
        const problems: FieldErrors =
            step === "recover"
                ? { "lg-name": nameProblem, "lg-key": recoveryKey.trim() ? undefined : "Bitte den Wiederherstellungsschlüssel eingeben.", ...checkNewPassword(pw, pw2, { pw: "lg-new", pw2: "lg-new2" }) }
                : step === "code"
                  ? { code: codeProblem(code) }
                  : { "lg-name": nameProblem, "lg-pw": pw ? undefined : "Bitte dein Passwort eingeben." };
        setFieldErrors(problems);
        if (focusFirstError(problems)) return;
        setBusy(true);
        try {
            if (step === "recover") {
                await call(routes.recover, { body: { recoveryKey, name, password: pw } });
                setRecoveryKey("");
                setPw2("");
                await queryClient.refetchQueries({ queryKey: ["status"] });
            }
            await login(step === "code");
        } catch (err) {
            setError(errorText(err));
            if (step === "code") setCode("");
            else if (step === "password") setPw("");
        } finally {
            setBusy(false);
        }
    };

    const signOut = async () => {
        await call(routes.logout).catch(() => undefined);
        queryClient.setQueryData(["me"], null);
        restart();
    };

    if (step === "setup" && setup) return <TotpSetupScreen setup={setup} onExpired={restart} />;

    const nameInput = lockedAs ? (
        <input type="text" autoComplete="username" value={lockedAs.name} readOnly hidden />
    ) : (
        <Field id="lg-name" label="Name" error={fieldErrors["lg-name"]}>
            <input className="inp" autoComplete="username" value={typedName} onChange={(e) => setTypedName(e.target.value)} autoFocus {...fieldProps("lg-name", fieldErrors["lg-name"])} />
        </Field>
    );

    if (step === "recover") {
        return (
            <Screen
                title="Passwort vergessen"
                text="Der Wiederherstellungsschlüssel öffnet die Daten und setzt ein neues Passwort. Danach meldest du dich mit dem Code aus der Authenticator-App an."
            >
                <form onSubmit={submit} noValidate>
                    {nameInput}
                    <Field id="lg-key" label="Wiederherstellungsschlüssel" error={fieldErrors["lg-key"]}>
                        <input className="inp mono" autoComplete="off" placeholder="XXXX-XXXX-…" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} autoFocus={!!lockedAs} {...fieldProps("lg-key", fieldErrors["lg-key"])} />
                    </Field>
                    <Field id="lg-new" label="Neues Passwort" error={fieldErrors["lg-new"]} hint={PASSWORD_HINT}>
                        <input className="inp" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} {...fieldProps("lg-new", fieldErrors["lg-new"], true)} />
                    </Field>
                    <Field id="lg-new2" label="Neues Passwort wiederholen" error={fieldErrors["lg-new2"]}>
                        <input className="inp" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} {...fieldProps("lg-new2", fieldErrors["lg-new2"])} />
                    </Field>
                    <Button className="btn-primary btn-lg" type="submit" busy={busy} icon={KeyRound} iconSize={16}>
                        {busy ? "Prüfe …" : "Neues Passwort setzen"}
                    </Button>
                    {error && <Hint tone="bad">{error}</Hint>}
                </form>
                <button type="button" className="link" onClick={restart}>
                    Zurück zur Anmeldung
                </button>
            </Screen>
        );
    }

    const locked = !!lockedAs || serverLocked;
    const title = lockedAs && !serverLocked ? "Sitzung gesperrt" : serverLocked ? "MBM ist gesperrt" : "Anmelden";
    const text =
        step === "code" ? (
            "Gib den aktuellen Code aus deiner Authenticator-App ein."
        ) : lockedAs ? (
            <>
                Angemeldet als <b>{lockedAs.name}</b>. Gib dein Passwort ein, um weiterzumachen.
            </>
        ) : serverLocked ? (
            "Deine Daten sind verschlüsselt gespeichert. Melde dich an, um sie zu entsperren."
        ) : undefined;
    const foot = serverLocked
        ? "Der Schlüssel liegt nur im Arbeitsspeicher des Servers. Nach einem Neustart ist MBM wieder gesperrt."
        : lockedAs
          ? "Nach fünf falschen Eingaben wird diese Sitzung abgemeldet."
          : undefined;

    return (
        <Screen title={title} text={text} foot={foot}>
            <form onSubmit={submit} noValidate>
                {step === "password" ? (
                    <>
                        {nameInput}
                        <Field id="lg-pw" label="Passwort" error={fieldErrors["lg-pw"]}>
                            <input className="inp" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus={!!lockedAs} {...fieldProps("lg-pw", fieldErrors["lg-pw"])} />
                        </Field>
                    </>
                ) : (
                    <CodeInput value={code} onChange={setCode} error={fieldErrors.code} />
                )}
                <Button className="btn-primary btn-lg" type="submit" busy={busy} icon={locked ? Lock : undefined} iconSize={16}>
                    {busy ? "Prüfe …" : locked ? "Entsperren" : step === "password" ? "Weiter" : "Anmelden"}
                </Button>
                {error && <Hint tone="bad">{error}</Hint>}
            </form>
            {step === "code" && (
                <button type="button" className="link" onClick={restart}>
                    Zurück
                </button>
            )}
            {step === "password" && (
                <button type="button" className="link" onClick={() => { restart(); setStep("recover"); }}>
                    <Ic icon={KeyRound} size={14} />
                    Passwort vergessen
                </button>
            )}
            {step === "password" && lockedAs && (
                <button type="button" className="link" onClick={() => void signOut()}>
                    <Ic icon={LogOut} size={14} />
                    {serverLocked ? "Anderer Benutzer" : "Abmelden"}
                </button>
            )}
        </Screen>
    );
}
