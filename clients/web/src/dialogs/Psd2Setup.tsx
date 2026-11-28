import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Landmark, Search } from "lucide-react";
import { routes, type BankConnection, type Psd2BankInfo } from "@mbm/shared";
import { call, errorText } from "../lib/api";
import { refreshBank, useConnections } from "../lib/bank";
import { copyText } from "../lib/clipboard";
import { afterConsent, LOCALHOST_CALLBACK, ownCallback, PSD2_COUNTRIES, readKeyFile, readRedirect, redirectErrorText } from "../lib/psd2";
import { ui } from "../lib/ui";
import { Modal, Button, Hint } from "../components/common";
import { Field } from "../components/form";
import { Ic } from "../components/icons";

type Step = "intro" | "credentials" | "bank" | "consent" | "paste";

/**
 * Sets up a bank access over PSD2 through Enable Banking: consent to the third party, the own
 * Enable Banking application (ID and private key, or taken from another own PSD2 access), the bank,
 * and the approval at the bank. The approval comes back over /bank-callback, or as an address the
 * user pastes. Without `connectionId` a new access; with it the own login (`mode` "credentials":
 * a new application) or just a new approval (`mode` "consent", or "add" for a further account). A
 * new approval joins those the access already holds. Key and ID stay in this dialog's state only.
 */
export function Psd2SetupDialog({ connectionId, mode }: { connectionId?: number; mode?: "consent" | "credentials" | "add" }) {
    const connections = useConnections().data;
    const existing = connections?.find((c) => c.id === connectionId);
    const [step, setStep] = useState<Step>(() => (!connectionId ? "intro" : mode === "consent" || mode === "add" || (existing?.myLogin?.status === "setup" && !mode) ? "consent" : "credentials"));
    const [conn, setConn] = useState<BankConnection | null>(existing ?? null);
    // A further account at an access that already has approvals
    const [adding, setAdding] = useState(mode === "add");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Step "intro"
    const [agreed, setAgreed] = useState(false);
    // Step "credentials": typed in, or the id of another own PSD2 access to take them from
    // One choice per application (its hint), not per access: taken from the first access that uses it
    const ownApps = useMemo(() => {
        const apps = new Map<string, { id: number; hint: string; names: string[] }>();
        for (const c of connections ?? []) {
            if (c.kind !== "psd2" || c.id === connectionId || !c.myLogin || c.myLogin.status === "credentials_lost") continue;
            const app = apps.get(c.myLogin.loginHint);
            if (app) app.names.push(c.name);
            else apps.set(c.myLogin.loginHint, { id: c.id, hint: c.myLogin.loginHint, names: [c.name] });
        }
        return [...apps.values()];
    }, [connections, connectionId]);
    // Until the user picks: the first own application, if there is one (one application serves all banks)
    const [picked, setSource] = useState<"typed" | number | null>(null);
    const source = picked ?? ownApps[0]?.id ?? "typed";
    const [applicationId, setApplicationId] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [keyName, setKeyName] = useState<string | null>(null);
    const [pasteKey, setPasteKey] = useState(false);
    // Step "bank"
    const [country, setCountry] = useState("DE");
    const [filter, setFilter] = useState("");
    const [banks, setBanks] = useState<Psd2BankInfo[] | null>(null);
    // Step "consent" / "paste"
    const [via, setVia] = useState<"own" | "localhost">("own");
    const [pasted, setPasted] = useState("");

    useEffect(() => () => setPrivateKey(""), []);

    const credentials = source === "typed" ? { credentials: { applicationId: applicationId.trim(), privateKey: privateKey.trim() } } : { fromConnection: source };
    const credentialsReady = source !== "typed" || (/^[0-9a-fA-F-]{36}$/.test(applicationId.trim()) && privateKey.trim().length >= 100);
    const bankName = conn?.name ?? existing?.name ?? "der Bank";

    const run = async (fn: () => Promise<void>) => {
        setError(null);
        setBusy(true);
        try {
            await fn();
        } catch (err) {
            setError(err instanceof Error && !("code" in err) ? err.message : errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const pickKeyFile = (file: File | undefined) =>
        void run(async () => {
            if (!file) return;
            setPrivateKey(await readKeyFile(file));
            setKeyName(file.name);
        });

    const loadBanks = (c: string) =>
        run(async () => {
            setBanks(null);
            const r = await call(routes.psd2Banks, { body: { country: c, ...credentials } });
            setBanks(r.banks);
        });

    /** Credentials checked: an existing access sets them right away, a new one picks the bank first. */
    const confirmCredentials = () =>
        run(async () => {
            if (conn) {
                await call(routes.setPsd2Login, { params: { id: conn.id }, body: credentials });
                setPrivateKey("");
                refreshBank();
                setStep("consent");
                return;
            }
            const r = await call(routes.psd2Banks, { body: { country, ...credentials } });
            setBanks(r.banks);
            setStep("bank");
        });

    const pickBank = (b: Psd2BankInfo) =>
        run(async () => {
            // The access exists with an own approval: a further account joins it; a new application would end the approvals
            const own = (connections ?? []).find((c) => c.psd2?.aspsp === b.name && c.psd2.country === b.country && c.myLogin?.consentUntil && c.myLogin.status !== "credentials_lost");
            if (own) {
                setConn(own);
                setAdding(true);
                setStep("consent");
                return;
            }
            const c = await call(routes.createPsd2Connection, { body: { aspsp: b.name, country: b.country } });
            await call(routes.setPsd2Login, { params: { id: c.id }, body: credentials });
            setPrivateKey("");
            refreshBank();
            setConn(c);
            setStep("consent");
        });

    const startConsent = () =>
        run(async () => {
            const id = conn?.id ?? connectionId!;
            const { url } = await call(routes.startConsent, { params: { id }, body: { redirectUrl: via === "own" ? ownCallback() : LOCALHOST_CALLBACK } });
            if (via === "own") {
                // The bank sends this tab back to /bank-callback, which finishes the approval
                window.location.assign(url);
                return;
            }
            window.open(url, "_blank", "noopener,noreferrer");
            setStep("paste");
        });

    const finishPasted = () =>
        run(async () => {
            const r = readRedirect(pasted);
            if (r.kind === "invalid") throw new Error("Das ist keine Adresse der Rückleitung. Sie beginnt mit https://localhost/bank-callback?… und enthält „code“ und „state“.");
            if (r.kind === "error") throw new Error(redirectErrorText(r.error, r.description));
            const c = await call(routes.completeConsent, { body: { state: r.state, code: r.code } });
            setPasted("");
            afterConsent(c);
        });

    const shownBanks = (banks ?? []).filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase()));
    const hasAccess = (b: Psd2BankInfo) => (connections ?? []).some((c) => c.psd2?.aspsp === b.name && c.psd2.country === b.country && c.myLogin);
    const title = step === "intro" ? "Bank über PSD2" : step === "credentials" ? "Enable-Banking-Anwendung" : step === "bank" ? "Bank wählen" : step === "consent" ? (adding ? `Weiteres Konto bei ${bankName} freigeben` : `Bei ${bankName} freigeben`) : "Freigabe abschließen";
    // The access already holds approvals: the new one joins them, or renews the one of the same account
    const hasApprovals = !!(conn ?? existing)?.myLogin?.consentUntil;

    return (
        <Modal title={title} onClose={() => ui.close()}>
            <div className="form-grid" style={{ maxWidth: "none", gap: 16 }}>
                {error && <Hint tone="bad">{error}</Hint>}

                {step === "intro" && (
                    <>
                        <p className="muted">Für PayPal und viele andere Banken gibt es kein FinTS. MBM ruft sie dann über PSD2 ab, die Schnittstelle, die jede Bank in der EU anbieten muss. Nutzen darf sie nur ein zugelassener Dienst; MBM verwendet dafür <b>Enable Banking</b> (Finnland).</p>
                        <ul className="psd2-points">
                            <li>Die Umsätze dieser Bank laufen über die Server von Enable Banking. Enable Banking sieht sie, speichert sie nach eigener Aussage aber nicht.</li>
                            <li>Der Zugriff kann nur lesen. Überweisen geht darüber nicht.</li>
                            <li>Die Freigabe bei der Bank gilt höchstens 180 Tage. Danach gibst du sie neu frei.</li>
                            <li>Du brauchst eine eigene, kostenlose Anwendung bei Enable Banking. Wie du sie anlegst, steht in der Dokumentation unter „Konten → Bank über PSD2“.</li>
                        </ul>
                        <label className="bank-item">
                            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                            <span><b>Einverstanden</b><small>Die Umsätze dieser Bank dürfen über Enable Banking laufen.</small></span>
                        </label>
                        <div className="actions">
                            <Button className="btn-primary" disabled={!agreed} onClick={() => setStep("credentials")}>Weiter</Button>
                        </div>
                    </>
                )}

                {step === "credentials" && (
                    <form className="form-grid" style={{ maxWidth: "none", gap: 16 }} onSubmit={(e) => (e.preventDefault(), void confirmCredentials())}>
                        {ownApps.length > 0 && (
                            <div className="kind-list" role="radiogroup" aria-label="Zugangsdaten">
                                {ownApps.map((a) => (
                                    <button key={a.hint} type="button" role="radio" aria-checked={source === a.id} className={`bank-item ${source === a.id ? "on" : ""}`} onClick={() => setSource(a.id)}>
                                        <span className="acc-ic">{source === a.id ? <Ic icon={Check} size={16} /> : null}</span>
                                        <span>
                                            <b>Anwendung ({a.hint})</b>
                                            <small className="psd2-app-note">Mit dieser Application-ID verwendete Kontoverbindungen:</small>
                                            <span className="psd2-app-banks">
                                                {a.names.map((n, i) => <small key={i}>{n}</small>)}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                                <button type="button" role="radio" aria-checked={source === "typed"} className={`bank-item ${source === "typed" ? "on" : ""}`} onClick={() => setSource("typed")}>
                                    <span className="acc-ic">{source === "typed" ? <Ic icon={Check} size={16} /> : null}</span>
                                    <span><b>Andere Anwendung</b><small>Application-ID und Schlüssel eingeben</small></span>
                                </button>
                            </div>
                        )}
                        {source === "typed" && (
                            <>
                                <Field id="ps-app" label="Application-ID" hint="Steht im Control Panel von Enable Banking bei deiner Anwendung, z. B. 0b3c7a52-6f1e-4c2a-9d8e-1f2a3b4c5d6e.">
                                    <input id="ps-app" className="inp mono" autoFocus autoComplete="off" spellCheck={false} value={applicationId} onChange={(e) => setApplicationId(e.target.value)} />
                                </Field>
                                <Field id="ps-key" label="Privater Schlüssel" hint={pasteKey ? "Den Inhalt der .pem-Datei einfügen, mit der ersten und letzten Zeile." : "Die .pem-Datei, die beim Anlegen der Anwendung heruntergeladen wurde. Sie bleibt bei dir; MBM speichert den Schlüssel verschlüsselt."}>
                                    {pasteKey ? (
                                        <textarea id="ps-key" className="inp" rows={5} spellCheck={false} autoComplete="off" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" />
                                    ) : (
                                        <input id="ps-key" className="inp" type="file" accept=".pem,.key,application/x-pem-file" onChange={(e) => pickKeyFile(e.target.files?.[0])} />
                                    )}
                                </Field>
                                <div className="muted small">
                                    {keyName && !pasteKey ? <>Schlüssel aus „{keyName}“ gelesen. </> : null}
                                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => (setPasteKey(!pasteKey), setPrivateKey(""), setKeyName(null))}>{pasteKey ? "Datei wählen" : "Inhalt einfügen"}</button>
                                </div>
                                <Field id="ps-urls" label="Redirect-URLs der Anwendung" hint="Trag mindestens eine davon im Control Panel bei deiner Anwendung ein. Die erste schickt dich nach der Freigabe direkt hierher zurück; mit der zweiten fügst du die Adresse von Hand ein.">
                                    <div id="ps-urls" className="psd2-urls">
                                        {[ownCallback(), LOCALHOST_CALLBACK].map((u) => (
                                            <div key={u} className="psd2-url">
                                                <code>{u}</code>
                                                <button type="button" className="mini" aria-label={`${u} kopieren`} title="Kopieren" onClick={() => copyText(u)}><Ic icon={Copy} size={14} /></button>
                                            </div>
                                        ))}
                                    </div>
                                </Field>
                            </>
                        )}
                        <div className="actions">
                            <Button className="btn-primary" type="submit" busy={busy} disabled={!credentialsReady}>{conn ? "Prüfen und speichern" : "Prüfen und Bank wählen"}</Button>
                        </div>
                    </form>
                )}

                {step === "bank" && (
                    <>
                        <Field id="ps-country" label="Land">
                            <select id="ps-country" className="inp" value={country} onChange={(e) => (setCountry(e.target.value), void loadBanks(e.target.value))}>
                                {PSD2_COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                            </select>
                        </Field>
                        <Field id="ps-filter" label="Bank" hint="Die Liste kommt von Enable Banking.">
                            <div className="inp-icon">
                                <Ic icon={Search} size={15} />
                                <input id="ps-filter" className="inp" autoFocus autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="z. B. PayPal" />
                            </div>
                        </Field>
                        {banks && shownBanks.length === 0 && <p className="muted small">Keine Bank gefunden.</p>}
                        {shownBanks.length > 0 && (
                            <div className="kind-list bank-results">
                                {shownBanks.map((b) => (
                                    <button key={`${b.country}-${b.name}`} className="bank-item" type="button" disabled={busy} onClick={() => void pickBank(b)}>
                                        <span className="acc-ic"><Ic icon={Landmark} size={16} /></span>
                                        <span>
                                            <b>{b.name}</b>
                                            <small>{[b.maxConsentDays ? `Freigabe bis ${b.maxConsentDays} Tage` : null, b.psuTypes.includes("personal") ? (b.psuTypes.includes("business") ? "privat und geschäftlich" : "privat") : "nur geschäftlich", hasAccess(b) ? "schon eingerichtet" : null].filter(Boolean).join(" · ")}</small>
                                        </span>
                                        {b.beta && <span className="badge attn">Beta</span>}
                                    </button>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {step === "consent" && (
                    <>
                        <p className="muted">MBM öffnet die Freigabeseite von Enable Banking. Dort meldest du dich bei {bankName} an und bestätigst den Zugriff. Danach schickt die Bank dich zurück.</p>
                        {hasApprovals && (
                            <Hint>
                                {adding ? <>„{bankName}“ ist schon eingerichtet. </> : null}
                                Melde dich mit dem Konto an, das du {adding ? "hinzufügen" : "erneuern oder hinzufügen"} willst. Deine übrigen Freigaben bleiben bestehen; die neue ersetzt nur eine frühere Freigabe desselben Kontos.
                            </Hint>
                        )}
                        <div className="kind-list" role="radiogroup" aria-label="Rückleitung">
                            <button type="button" role="radio" aria-checked={via === "own"} className={`bank-item ${via === "own" ? "on" : ""}`} onClick={() => setVia("own")}>
                                <span className="acc-ic">{via === "own" ? <Ic icon={Check} size={16} /> : null}</span>
                                <span><b>Zurück zu MBM</b><small>{ownCallback()} muss in der Anwendung eingetragen sein</small></span>
                            </button>
                            <button type="button" role="radio" aria-checked={via === "localhost"} className={`bank-item ${via === "localhost" ? "on" : ""}`} onClick={() => setVia("localhost")}>
                                <span className="acc-ic">{via === "localhost" ? <Ic icon={Check} size={16} /> : null}</span>
                                <span><b>Adresse von Hand einfügen</b><small>Über {LOCALHOST_CALLBACK}; die Seite lädt nicht, du kopierst ihre Adresse hierher</small></span>
                            </button>
                        </div>
                        <div className="actions">
                            <Button className="btn-primary" icon={ExternalLink} busy={busy} onClick={() => void startConsent()}>Bei {bankName} freigeben</Button>
                        </div>
                    </>
                )}

                {step === "paste" && (
                    <form className="form-grid" style={{ maxWidth: "none", gap: 16 }} onSubmit={(e) => (e.preventDefault(), void finishPasted())}>
                        <Hint>Die Freigabeseite hat sich in einem neuen Tab geöffnet. Wenn du fertig bist, zeigt der Browser dort eine Seite, die nicht lädt. Kopier ihre Adresse aus der Adresszeile und füge sie hier ein. Die Freigabe gilt 15 Minuten.</Hint>
                        <Field id="ps-back" label="Adresse nach der Freigabe">
                            <textarea id="ps-back" className="inp" rows={3} autoFocus spellCheck={false} autoComplete="off" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={`${LOCALHOST_CALLBACK}?state=…&code=…`} />
                        </Field>
                        <div className="actions">
                            <button type="button" className="btn btn-ghost" onClick={() => setStep("consent")}>Noch einmal freigeben</button>
                            <Button className="btn-primary" type="submit" busy={busy} disabled={!pasted.trim()}>Freigabe abschließen</Button>
                        </div>
                    </form>
                )}
            </div>
        </Modal>
    );
}
