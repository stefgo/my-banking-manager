import { useEffect, useMemo, useState } from "react";
import { Check, Folder, Landmark, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { groupCardNumber, routes, type BankConnection } from "@mbm/shared";
import { call, errorText } from "../lib/api";
import { refreshBank } from "../lib/bank";
import { useBankOperation } from "../lib/bankOperation";
import { ui } from "../lib/ui";
import { plural } from "../lib/format";
import { Modal, Button, Hint, Switch } from "../components/common";
import { Field } from "../components/form";
import { Picker, PickerButton } from "../components/pickers";
import { Ic } from "../components/icons";
import { Approval } from "../components/Approval";
import { useScopeItems } from "../components/pickItems";

type Step = "bank" | "login" | "method" | "accounts" | "done";
type Method = { id: string; name: string; decoupled: boolean; needsMedium: boolean };
const KIND_NAME: Record<string, string> = { loan: "Darlehen", depot: "Depot", other: "Sonstiges Konto" };

type Offered = { externalId: string; name: string; iban: string | null; cardNumber: string | null; owner: string; kind: string; supported: boolean; accountId: number | null; ignored: boolean };

/**
 * Sets up a bank access: find the bank, FinTS address, login name and PIN, TAN method, take
 * over accounts. With `connectionId` it starts at the login (access exists, own login missing).
 * New accounts left unpicked are ignored: a fetch no longer reports them as new.
 * A PIN that should not be stored stays in this dialog's state only.
 */
export function BankSetupDialog({ connectionId }: { connectionId?: number }) {
    const [step, setStep] = useState<Step>(connectionId ? "login" : "bank");
    const [conn, setConn] = useState<number | null>(connectionId ?? null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const { pending, outcome, approval } = useBankOperation(setError);

    // Step "bank"
    const [query, setQuery] = useState("");
    const [bank, setBank] = useState<{ blz: string; name: string; place: string } | null>(null);
    const [url, setUrl] = useState("https://");
    // Step "login"
    const [loginName, setLoginName] = useState("");
    const [pin, setPin] = useState("");
    const [savePin, setSavePin] = useState(true);
    // Step "method"
    const [methods, setMethods] = useState<Method[]>([]);
    const [method, setMethod] = useState("");
    const [media, setMedia] = useState<string[] | null>(null);
    const [medium, setMedium] = useState("");
    // Step "accounts"
    const [offered, setOffered] = useState<Offered[] | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [group, setGroup] = useState("");

    useEffect(() => () => setPin(""), []);

    const search = useQuery({
        queryKey: ["banks", query.trim()],
        queryFn: () => call(routes.searchBanks, { query: { q: query.trim() } }),
        enabled: query.trim().length >= 2 && !bank,
        staleTime: Infinity,
    });

    const scopeItems = useScopeItems(false);
    const groups = useMemo(() => scopeItems.filter((x) => x.value.startsWith("group:")), [scopeItems]);
    const groupItems = useMemo(() => [{ value: "top", label: "Oberste Ebene", top: true }, ...groups], [groups]);
    const groupItem = groups.find((g) => g.value === group);
    const pinBody = savePin ? {} : { pin };

    /** Runs a call; an answer "approval" shows the approval and continues with `done`. */
    const run = async (fn: () => Promise<void>) => {
        setError(null);
        setBusy(true);
        try {
            await fn();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    const createConnection = () =>
        run(async () => {
            if (!bank) return;
            const c: BankConnection = await call(routes.createConnection, { body: { blz: bank.blz, fintsUrl: url.trim() } });
            refreshBank();
            setConn(c.id);
            if (c.myLogin?.status === "ready") {
                ui.toast(`Du bist bei ${c.name} schon angemeldet.`);
                return ui.close();
            }
            setStep("login");
        });

    const setLogin = () =>
        run(async () => {
            const r = await call(routes.setLogin, { params: { id: conn! }, body: { loginName: loginName.trim(), pin, savePin } });
            if (savePin) setPin("");
            setMethods(r.tanMethods);
            setMethod(r.tanMethods.find((m) => m.decoupled)?.id ?? r.tanMethods[0]?.id ?? "");
            refreshBank();
            setStep("method");
        });

    const chosen = methods.find((m) => m.id === method);

    const fetchMedia = () =>
        run(async () => {
            // The bank wants the dialog opened with the chosen method, so store it first.
            await call(routes.chooseTanMethod, { params: { id: conn! }, body: { tanMethod: method } });
            const o = await call(routes.tanMedia, { params: { id: conn! }, body: pinBody });
            outcome(o, (d) => {
                // The bank lists all media; offer the active ones if there are any.
                const active = d.media.filter((m) => m.active);
                const names = (active.length > 0 ? active : d.media).map((m) => m.name).filter(Boolean);
                setMedia(names);
                setMedium(names[0] ?? "");
            });
        });

    const loadAccounts = async (body: { pin?: string }) => {
        const o = await call(routes.offeredAccounts, { params: { id: conn! }, body });
        outcome(o, (d) => {
            setOffered(d.accounts);
            // Accounts left out before stay out until picked again
            setPicked(new Set(d.accounts.filter((a) => a.supported && !a.ignored).map((a) => a.externalId)));
        });
    };

    const fetchAccounts = () =>
        run(async () => {
            await call(routes.chooseTanMethod, { params: { id: conn! }, body: { tanMethod: method, ...(medium.trim() ? { tanMedium: medium.trim() } : {}) } });
            setStep("accounts");
            await loadAccounts(pinBody);
        });

    // New accounts not picked are left out: a fetch no longer reports them
    const leftOut = (offered ?? []).filter((a) => a.supported && a.accountId === null && !picked.has(a.externalId)).map((a) => a.externalId);

    const importAccounts = () =>
        run(async () => {
            const groupId = group ? Number(group.slice(6)) : null;
            const r = await call(routes.importAccounts, { params: { id: conn! }, body: { accounts: [...picked].map((externalId) => ({ externalId, groupId })), ignore: leftOut } });
            refreshBank();
            setPin("");
            ui.toast(`${plural(r.created.length, "Konto", "Konten")} übernommen${r.linked.length ? `, ${r.linked.length} verknüpft` : ""}`);
            ui.close();
        });

    const title = step === "bank" ? "Bank hinzufügen" : step === "login" ? "Bei der Bank anmelden" : step === "method" ? "TAN-Verfahren wählen" : "Konten übernehmen";

    return (
        <Modal title={title} onClose={() => ui.close()}>
            <div className="form-grid" style={{ maxWidth: "none", gap: 16 }}>
                {error && <Hint tone="bad">{error}</Hint>}

                {approval && <Approval {...approval} />}

                {step === "bank" && (
                    <>
                        {!bank ? (
                            <Field id="bs-q" label="Bank" hint="Bankleitzahl, BIC oder Name, z. B. „Sparkasse Bad Tölz“">
                                <div className="inp-icon">
                                    <Ic icon={Search} size={15} />
                                    <input id="bs-q" className="inp" autoFocus autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
                                </div>
                            </Field>
                        ) : (
                            <div className="bank-item on">
                                <span className="acc-ic"><Ic icon={Landmark} size={16} /></span>
                                <span><b>{bank.name}</b><small>{bank.place} · BLZ {bank.blz}</small></span>
                                <button className="btn btn-sm btn-ghost" type="button" onClick={() => setBank(null)}>Ändern</button>
                            </div>
                        )}
                        {!bank && (search.data ?? []).length > 0 && (
                            <div className="kind-list bank-results">
                                {(search.data ?? []).map((b) => (
                                    <button key={b.blz} className="bank-item" type="button" onClick={() => setBank(b)}>
                                        <span className="acc-ic"><Ic icon={Landmark} size={16} /></span>
                                        <span><b>{b.name}</b><small>{b.place} · BLZ {b.blz}</small></span>
                                    </button>
                                ))}
                            </div>
                        )}
                        {bank && (
                            <>
                                <Field id="bs-url" label="FinTS-Adresse" hint="Steht im Online-Banking deiner Bank, meist unter „Online-Banking-Software“ oder „HBCI/FinTS“. Beginnt mit https://.">
                                    <input id="bs-url" className="inp" autoFocus autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} />
                                </Field>
                                <div className="actions">
                                    <Button className="btn-primary" busy={busy} disabled={!/^https:\/\/\S+\.\S+/.test(url.trim())} onClick={() => void createConnection()}>
                                        Bank prüfen
                                    </Button>
                                </div>
                            </>
                        )}
                    </>
                )}

                {step === "login" && (
                    <form className="form-grid" style={{ maxWidth: "none", gap: 16 }} onSubmit={(e) => (e.preventDefault(), void setLogin())}>
                        <Field id="bs-login" label="Anmeldename" hint="Wie im Online-Banking: Anmeldename, Legitimations-ID oder Kontonummer">
                            <input id="bs-login" className="inp" autoFocus autoComplete="off" value={loginName} onChange={(e) => setLoginName(e.target.value)} />
                        </Field>
                        <Field id="bs-pin" label="PIN">
                            <input id="bs-pin" className="inp" type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
                        </Field>
                        <div className="switch-row">
                            <span>
                                <b>PIN speichern</b>
                                <small>{savePin ? "Verschlüsselt, nur mit deiner Anmeldung an MBM lesbar. Abrufe laufen ohne PIN-Eingabe." : "MBM fragt die PIN bei jedem Abruf. Sie wird nirgends gespeichert."}</small>
                            </span>
                            <Switch checked={savePin} onChange={setSavePin} label="PIN speichern" />
                        </div>
                        <div className="actions">
                            <Button className="btn-primary" type="submit" busy={busy} disabled={!loginName.trim() || !pin}>
                                Anmelden
                            </Button>
                        </div>
                    </form>
                )}

                {step === "method" && (
                    <>
                        <div className="kind-list" role="radiogroup" aria-label="TAN-Verfahren">
                            {methods.map((m) => (
                                <button key={m.id} type="button" role="radio" aria-checked={method === m.id} className={`bank-item ${method === m.id ? "on" : ""}`} onClick={() => (setMethod(m.id), setMedia(null), setMedium(""))}>
                                    <span className="acc-ic">{method === m.id ? <Ic icon={Check} size={16} /> : null}</span>
                                    <span><b>{m.name}</b><small>{m.decoupled ? "Freigabe in der App" : "TAN-Eingabe"}</small></span>
                                </button>
                            ))}
                        </div>
                        {chosen?.needsMedium && (
                            media === null ? (
                                <Button busy={busy && !pending} onClick={() => void fetchMedia()}>Geräte abrufen</Button>
                            ) : media.length === 0 ? (
                                <Field id="bs-medium" label="Gerät" hint="Die Bank hat keine Geräte gemeldet. Gib die Bezeichnung so ein, wie sie in der App oder im Online-Banking steht.">
                                    <input id="bs-medium" className="inp" autoComplete="off" value={medium} onChange={(e) => setMedium(e.target.value)} />
                                </Field>
                            ) : (
                                <Field id="bs-medium" label="Gerät">
                                    <div className="kind-list">
                                        {media.map((m) => (
                                            <button key={m} type="button" className={`bank-item ${medium === m ? "on" : ""}`} onClick={() => setMedium(m)}>
                                                <span className="acc-ic">{medium === m ? <Ic icon={Check} size={16} /> : null}</span>
                                                <span><b>{m}</b></span>
                                            </button>
                                        ))}
                                    </div>
                                </Field>
                            )
                        )}
                        <div className="actions">
                            <Button className="btn-primary" busy={busy && !pending} disabled={!method || (chosen?.needsMedium && !medium.trim()) || !!pending} onClick={() => void fetchAccounts()}>
                                Konten abrufen
                            </Button>
                        </div>
                    </>
                )}

                {step === "accounts" && offered && (
                    <>
                        {offered.length === 0 && (
                            <>
                                <Hint>Die Bank hat keine Konten gemeldet.</Hint>
                                <div className="actions">
                                    <Button busy={busy && !pending} disabled={!!pending} onClick={() => void fetchAccounts()}>Noch einmal abrufen</Button>
                                </div>
                            </>
                        )}
                        {offered.length > 0 && (
                            <div className="kind-list bank-offer">
                                {offered.map((a) => (
                                    <label key={a.externalId} className={`bank-item ${a.supported ? "" : "disabled"}`}>
                                        <input type="checkbox" disabled={!a.supported} checked={picked.has(a.externalId)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(a.externalId); else n.delete(a.externalId); return n; })} />
                                        <span>
                                            <b>{a.name}</b>
                                            <small>{[(a.kind === "credit_card" && a.cardNumber ? groupCardNumber(a.cardNumber) : a.iban) ?? a.externalId, a.owner, a.accountId ? "schon in MBM – wird verknüpft" : a.supported && a.ignored ? "bisher nicht übernommen" : null, a.supported ? null : `${KIND_NAME[a.kind] ?? "Kontoart"}: kann MBM noch nicht übernehmen`].filter(Boolean).join(" · ")}</small>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}
                        <Field id="bs-group" label="Gruppe für neue Konten">
                            <Picker
                                items={groupItems}
                                value={group || "top"}
                                onPick={(v) => setGroup(v === "top" ? "" : v)}
                                placeholder="Gruppe suchen …"
                                trigger={<PickerButton id="bs-group" set={!!groupItem} icon={groupItem?.icon ?? <Ic icon={Folder} size={14} />}>{groupItem ? groupItem.label : "Oberste Ebene"}</PickerButton>}
                            />
                        </Field>
                        <div className="actions">
                            <Button className="btn-primary" icon={Check} busy={busy} disabled={picked.size === 0} onClick={() => void importAccounts()}>
                                {picked.size === 1 ? "Konto übernehmen" : `${picked.size} Konten übernehmen`}
                            </Button>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}
