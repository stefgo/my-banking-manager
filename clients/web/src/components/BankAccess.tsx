import { useState } from "react";
import { EyeOff, Plus, RefreshCw, Unlink } from "lucide-react";
import { groupCardNumber, routes, type BankConnection, type BankLogin, type OfferedAccount } from "@mbm/shared";
import { call, errorText } from "../lib/api";
import { canFetch, isActive, refreshBank, startSync, useBankDirectory, useConnections, useOfferedAccounts, useSyncRuns } from "../lib/bank";
import { consentText, isPsd2 } from "../lib/psd2";
import { useBankOperation } from "../lib/bankOperation";
import { useAccounts, useAction, useGroups } from "../lib/queries";
import { accountsInTreeOrder } from "../lib/tree";
import { ui } from "../lib/ui";
import { dateText, dateTime as formatDateTime, plural } from "../lib/format";
import { Button, Hint, Switch } from "./common";
import { AccountRow } from "./AccountRow";
import { Approval } from "./Approval";
import { Ic, Sym, Tile } from "./icons";

const STATUS_TEXT: Record<BankLogin["status"], string> = {
    setup: "Einrichtung nicht abgeschlossen",
    ready: "Bereit",
    credentials_lost: "Anmeldename und PIN bitte neu eingeben",
    pin_wrong: "PIN abgelehnt",
    error: "Letzter Abruf fehlgeschlagen",
    consent_needed: "Freigabe bei der Bank nötig",
};
/** PSD2 logins have an application instead of login name and PIN. */
const PSD2_STATUS_TEXT: Partial<Record<BankLogin["status"], string>> = {
    credentials_lost: "Application-ID und Schlüssel bitte neu eingeben",
    pin_wrong: "Application-ID oder Schlüssel abgelehnt",
};
const statusText = (s: BankLogin["status"], kind: BankConnection["kind"]): string => (kind === "psd2" ? PSD2_STATUS_TEXT[s] : undefined) ?? STATUS_TEXT[s];

const dotClass = (s: BankLogin["status"] | null) => (s === "ready" ? "dot" : s === null ? "dot off" : "dot attn");

/** One row per bank access in „Status der Kontoabfrage“. */
export function BankStatusRows() {
    const connections = useConnections().data ?? [];
    const runs = useSyncRuns().data ?? [];
    if (connections.length === 0) {
        return (
            <div className="fs-row">
                <span className="dot off" />
                <span className="fs-main">
                    <b>Bankzugänge</b>
                    <small>Noch keiner eingerichtet. „Konto hinzufügen → Bank (FinTS)“ oder „Bank über PSD2“ richtet einen ein.</small>
                </span>
                <span className="fs-state">–</span>
                <span />
            </div>
        );
    }
    return (
        <>
            {connections.map((c) => (
                <div className="fs-row" key={c.id}>
                    <span className={dotClass(c.myLogin?.status ?? null)} />
                    <span className="fs-main">
                        <b>{c.name}</b>
                        <small>{c.myLogin ? [statusText(c.myLogin.status, c.kind), consentText(c.myLogin.consentUntil)?.attn ? consentText(c.myLogin.consentUntil)!.text : null, c.myLogin.lastSyncAt ? `zuletzt abgerufen ${formatDateTime(c.myLogin.lastSyncAt)}` : null].filter(Boolean).join(" · ") : "Keine eigene Anmeldung"}</small>
                    </span>
                    <span className="fs-state">{plural(c.accountCount, "Konto", "Konten")}</span>
                    <ConnectionSyncButton c={c} syncing={runs.some((r) => r.connectionId === c.id && isActive(r))} />
                </div>
            ))}
        </>
    );
}

/** The bank directory of the Bundesbank in „Status der Kontoabfrage“: state, last check, check now. */
export function BankDirectoryRow() {
    const dir = useBankDirectory().data;
    const action = useAction();
    if (!dir) return null;
    const check = async () => {
        const r = await action.run(() => call(routes.checkBankDirectory), { topics: ["bankDirectory"] });
        if (!r) return;
        if (r.lastError) ui.toast(r.lastError, "error");
        else ui.toast(r.generated !== dir.generated || r.banks !== dir.banks ? "BLZ-Verzeichnis aktualisiert" : "BLZ-Verzeichnis ist aktuell");
    };
    const details = [
        plural(dir.banks, "Bank", "Banken"),
        `Stand ${dateText(dir.generated)}${dir.origin === "image" ? " (mitgeliefert)" : ""}`,
        !dir.autoUpdate ? "Abruf von bundesbank.de abgeschaltet" : dir.checkedAt ? `geprüft ${formatDateTime(dir.checkedAt)}` : null,
        dir.lastError,
    ];
    return (
        <div className="fs-row">
            <span className={!dir.autoUpdate ? "dot off" : dir.lastError ? "dot attn" : "dot"} />
            <span className="fs-main">
                <b>BLZ-Verzeichnis der Bundesbank</b>
                <small>{details.filter(Boolean).join(" · ")}</small>
            </span>
            <span className={dir.lastError ? "fs-state attn" : "fs-state"}>{!dir.autoUpdate ? "ohne Abruf" : dir.lastError ? "Prüfung fehlgeschlagen" : "täglich geprüft"}</span>
            {dir.autoUpdate ? (
                <button type="button" className="mini" aria-label="BLZ-Verzeichnis jetzt prüfen" title="Jetzt prüfen" disabled={action.pending} onClick={() => void check()}>
                    <Ic icon={RefreshCw} size={15} className={action.pending ? "spin" : undefined} />
                </button>
            ) : (
                <span />
            )}
        </div>
    );
}

/**
 * The bank access cards of the settings: own login, other users' logins, accounts. „Bankzugänge“
 * with heading; hidden without a bank access. The state of the connectors is under „Versionen“.
 */
export function BankAccessCards() {
    const connections = useConnections().data ?? [];
    if (connections.length === 0) return null;
    return (
        <>
            <h2 className="set-h">Bankzugänge</h2>
            {connections.map((c) => <BankCard key={c.id} c={c} />)}
        </>
    );
}

function BankCard({ c }: { c: BankConnection }) {
    const accounts = accountsInTreeOrder(useGroups().data ?? [], useAccounts().data ?? []).filter((a) => a.connectionId === c.id);
    const runs = useSyncRuns().data ?? [];
    const active = runs.filter((r) => r.connectionId === c.id && isActive(r));
    const action = useAction();
    const [pinOpen, setPinOpen] = useState(false);
    const login = c.myLogin;
    const psd2 = isPsd2(c);
    const canSync = canFetch(c);
    const consent = psd2 ? consentText(login?.consentUntil ?? null) : null;
    const atBank = useAccountsAtBank(c.id, canSync, login?.savePin ?? true);
    // Accounts in MBM the own login does not reach yet (known from the last account list): account id → bank id
    const unlinked = new Map((atBank.list?.accounts ?? []).filter((x) => x.accountId !== null && x.supported && !x.linked).map((x) => [x.accountId!, x.externalId]));
    const link = (accountId: number, name: string) =>
        void action.succeeds(() => call(routes.importAccounts, { params: { id: c.id }, body: { accounts: [{ externalId: unlinked.get(accountId)! }], ignore: [] } }), {
            topics: ["accounts", "connections"],
            ok: `„${name}“ verknüpft`,
        });

    const removeAccess = () =>
        ui.confirm({
            title: "Bankzugang entfernen",
            text: `„${c.name}“ mit allen Anmeldungen entfernen? Die Konten bleiben als Offline-Konten mit ihren Buchungen erhalten.`,
            confirm: "Entfernen",
            danger: true,
            onConfirm: () => action.succeeds(() => call(routes.deleteConnection, { params: { id: c.id }, query: { accounts: "keep" } }), { topics: ["connections", "accounts"], ok: "Bankzugang entfernt" }),
        });
    const removeLogin = () =>
        ui.confirm({
            title: "Eigene Anmeldung entfernen",
            text: "Deine Anmeldung bei dieser Bank entfernen? Konten und Buchungen bleiben; abrufen kannst du dann nicht mehr.",
            confirm: "Entfernen",
            danger: true,
            onConfirm: () => action.succeeds(() => call(routes.deleteLogin, { params: { id: c.id } }), { topics: ["connections"], ok: "Anmeldung entfernt" }),
        });

    return (
        <section className="panel conn-card" aria-label={c.name}>
            <div className="cc-head">
                <span className="acc-ic"><Sym name={c.icon} size={20} /></span>
                <div style={{ minWidth: 0 }}>
                    <h3>{c.name}</h3>
                    <p className="muted small">{psd2 ? `${c.bankName} · PSD2 über Enable Banking` : `${c.bankName} · BLZ ${c.blz}`}</p>
                </div>
                <span />
            </div>

            <div className="fs-list">
                <div className="fs-row">
                    <span className={dotClass(login?.status ?? null)} />
                    <span className="fs-main">
                        <b>Deine Anmeldung {login ? login.loginHint : ""}</b>
                        <small>
                            {login
                                ? [statusText(login.status, c.kind), login.tanMethod?.name, consent?.text, login.savePin ? null : "PIN wird bei jedem Abruf abgefragt", login.lastSyncAt ? `zuletzt abgerufen ${formatDateTime(login.lastSyncAt)}` : null, login.lastError]
                                      .filter(Boolean)
                                      .join(" · ")
                                : "Du hast hier noch keine eigene Anmeldung."}
                        </small>
                    </span>
                    <span className="fs-state cc-actions">
                        {psd2 ? (
                            <Psd2LoginActions c={c} atBank={canSync ? atBank : null} attn={!!consent?.attn} />
                        ) : !login || login.status === "setup" || login.status === "credentials_lost" ? (
                            <button className="btn btn-sm" onClick={() => ui.open({ kind: "bankSetup", connectionId: c.id })}>{login ? "Einrichtung fortsetzen" : "Anmeldung hinzufügen"}</button>
                        ) : (
                            <>
                                <Button className="btn-sm btn-ghost" busy={atBank.busy} disabled={atBank.pending} onClick={atBank.start}>Konten abrufen</Button>
                                <button className="btn btn-sm btn-ghost" onClick={() => setPinOpen(!pinOpen)}>PIN ändern</button>
                                <button className="btn btn-sm btn-ghost" onClick={() => ui.open({ kind: "bankSetup", connectionId: c.id })}>Neu einrichten</button>
                            </>
                        )}
                    </span>
                    <span />
                </div>
                {pinOpen && login && <PinForm connectionId={c.id} savePin={login.savePin} onDone={() => setPinOpen(false)} />}
                {c.otherLogins.map((o) => (
                    <div className="fs-row" key={o.userName}>
                        <span className={dotClass(o.status)} />
                        <span className="fs-main">
                            <b>{o.userName}</b>
                            <small>{STATUS_TEXT[o.status]}</small>
                        </span>
                        <span className="fs-state" />
                        <span />
                    </div>
                ))}
            </div>

            {accounts.length > 0 && (
                <div className="cc-accs">
                    {accounts.map((a) => (
                        <AccountRow
                            key={a.id}
                            account={a}
                            detail={
                                <>
                                    <small>{a.kind === "credit_card" ? (a.cardNumber ? groupCardNumber(a.cardNumber) : "Kreditkarte") : (a.iban ?? "")}</small>
                                    {unlinked.has(a.id) && <small className="cc-acc-hint">Nicht mit deiner Anmeldung verknüpft: dein Abruf erfasst es nicht</small>}
                                </>
                            }
                            actions={
                                <>
                                    {unlinked.has(a.id) && (
                                        <button type="button" className="btn btn-sm" disabled={action.pending} onClick={() => link(a.id, a.name)}>Verknüpfen</button>
                                    )}
                                    {canSync && !unlinked.has(a.id) && <AccountSyncButton id={a.id} name={a.name} syncing={active.some((r) => r.accountIds.includes(a.id))} />}
                                    <button type="button" className="mini" aria-label={`„${a.name}“ vom Bankzugang lösen`} title="Vom Bankzugang lösen …" onClick={() => ui.open({ kind: "detachAccount", accountId: a.id })}>
                                        <Ic icon={Unlink} size={14} />
                                    </button>
                                </>
                            }
                        />
                    ))}
                </div>
            )}

            {canSync && <AccountsAtBank connectionId={c.id} atBank={atBank} />}

            <div className="cc-foot">
                {login && <button className="btn btn-sm btn-ghost" onClick={removeLogin}>Eigene Anmeldung entfernen</button>}
                <button className="btn btn-sm btn-ghost btn-danger" onClick={removeAccess}>Bankzugang entfernen</button>
            </div>
        </section>
    );
}

/**
 * What the own PSD2 login offers: set up the application, approve at the bank, take over accounts,
 * then fetch the account list, renew the approval (marked when it runs out) or change the application.
 */
function Psd2LoginActions({ c, atBank, attn }: { c: BankConnection; atBank: ReturnType<typeof useAccountsAtBank> | null; attn: boolean }) {
    const login = c.myLogin;
    if (!login || login.status === "credentials_lost") {
        return <button className="btn btn-sm" onClick={() => ui.open({ kind: "psd2Setup", connectionId: c.id, mode: "credentials" })}>{login ? "Zugangsdaten eingeben" : "Anmeldung hinzufügen"}</button>;
    }
    if (login.status === "setup" && !login.consentUntil) {
        return <button className="btn btn-sm" onClick={() => ui.open({ kind: "psd2Setup", connectionId: c.id, mode: "consent" })}>Bei der Bank freigeben</button>;
    }
    if (login.status === "setup") {
        return <button className="btn btn-sm" onClick={() => ui.open({ kind: "bankSetup", connectionId: c.id, start: "accounts" })}>Konten übernehmen</button>;
    }
    const renew = login.status === "consent_needed" || attn;
    return (
        <>
            {atBank && <Button className="btn-sm btn-ghost" busy={atBank.busy} disabled={atBank.pending} onClick={atBank.start}>Konten abrufen</Button>}
            <button className={`btn btn-sm ${renew ? "" : "btn-ghost"}`} onClick={() => ui.open({ kind: "psd2Setup", connectionId: c.id, mode: "consent" })}>Freigabe erneuern</button>
            <button className="btn btn-sm btn-ghost" onClick={() => ui.open({ kind: "psd2Setup", connectionId: c.id, mode: "credentials" })}>Zugangsdaten ändern</button>
        </>
    );
}

const KIND_ICON: Record<string, string> = { giro: "landmark", savings: "piggy-bank", credit_card: "credit-card", loan: "percent", depot: "chart-line" };
const KIND_NAME: Record<string, string> = { loan: "Darlehen", depot: "Depot", other: "Sonstiges Konto" };

/**
 * Asking the bank which accounts the own login reaches. The list stays on the server (in memory),
 * so it shows again when the settings open; nothing of it goes into browser storage.
 */
function useAccountsAtBank(connectionId: number, enabled: boolean, pinStored: boolean) {
    const list = useOfferedAccounts(connectionId, enabled);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [askPin, setAskPin] = useState(false);
    const op = useBankOperation(setError);

    const fetch = async (pin?: string) => {
        setError(null);
        setBusy(true);
        try {
            const o = await call(routes.offeredAccounts, { params: { id: connectionId }, body: pin ? { pin } : {} });
            setAskPin(false);
            op.outcome(o, () => void list.refetch());
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    const start = () => (pinStored ? void fetch() : setAskPin(true));

    return { list: list.data ?? null, error, busy: busy || op.pending, pending: op.pending, approval: op.approval, askPin, cancelPin: () => setAskPin(false), fetch, start };
}

/** The accounts the bank reports for the own login that are not in MBM (new, hidden, unsupported). */
function AccountsAtBank({ connectionId, atBank }: { connectionId: number; atBank: ReturnType<typeof useAccountsAtBank> }) {
    const { list, error, approval, askPin } = atBank;
    if (!list && !error && !approval && !askPin) return null;
    // What can be taken over comes first: new, then hidden, then what MBM cannot take over
    const rank = (a: OfferedAccount) => (!a.supported ? 2 : a.ignored ? 1 : 0);
    const outside = (list?.accounts ?? []).filter((a) => a.accountId === null).sort((a, b) => rank(a) - rank(b));
    return (
        <section className="cc-bank" aria-label="Weitere Konten bei der Bank">
            <div className="cc-bank-head">
                <b>Weitere Konten bei der Bank</b>
                {list && <small>Stand {formatDateTime(list.fetchedAt)}</small>}
            </div>
            {error && <Hint tone="bad">{error}</Hint>}
            {askPin && <AskPin busy={atBank.busy} onSubmit={(pin) => void atBank.fetch(pin)} onCancel={atBank.cancelPin} />}
            {approval && <Approval {...approval} />}
            {list && outside.length === 0 && <p className="muted small">{list.accounts.length === 0 ? "Die Bank hat keine Konten gemeldet." : "Alle Konten, die die Bank meldet, sind in MBM."}</p>}
            {outside.length > 0 && (
                <div className="cc-accs cc-accs-bank">
                    {outside.map((a) => <AtBankRow key={a.externalId} connectionId={connectionId} a={a} />)}
                </div>
            )}
        </section>
    );
}

/** One account at the bank that is not in MBM, and what can be done with it. */
function AtBankRow({ connectionId, a }: { connectionId: number; a: OfferedAccount }) {
    const action = useAction();
    const send = (body: { accounts: { externalId: string }[]; ignore: string[] }, ok: string) =>
        void action.succeeds(() => call(routes.importAccounts, { params: { id: connectionId }, body }), { topics: ["accounts", "connections"], ok });
    const takeOver = () => send({ accounts: [{ externalId: a.externalId }], ignore: [] }, `„${a.name}“ übernommen`);
    const ignore = () => send({ accounts: [], ignore: [a.externalId] }, `„${a.name}“ ausgeblendet`);

    const [state, tone]: [string, string] = !a.supported ? ["nicht unterstützt", "off"] : a.ignored ? ["ausgeblendet", "off"] : ["neu", "attn"];
    const kindName = a.supported ? null : KIND_NAME[a.kind];

    return (
        <div className="cc-acc">
            <Tile icon={KIND_ICON[a.kind] ?? "landmark"} color="neutral" size={15} />
            <span className="cc-acc-main">
                <b>{a.name}</b>
                <small>{[(a.kind === "credit_card" && a.cardNumber ? groupCardNumber(a.cardNumber) : a.iban) ?? a.externalId, a.owner].filter(Boolean).join(" · ")}</small>
                {kindName && <small className="cc-acc-hint">{kindName}: kann MBM noch nicht übernehmen</small>}
            </span>
            <span className={`badge ${tone}`}>{state}</span>
            <span className="cc-acc-actions">
                {a.supported && !a.ignored && (
                    <button type="button" className="mini" aria-label={`„${a.name}“ ausblenden`} title="Ausblenden" disabled={action.pending} onClick={ignore}>
                        <Ic icon={EyeOff} size={14} />
                    </button>
                )}
                {a.supported && (
                    <button type="button" className="mini" aria-label={`„${a.name}“ übernehmen`} title="Übernehmen" disabled={action.pending} onClick={takeOver}>
                        <Ic icon={Plus} size={14} />
                    </button>
                )}
            </span>
        </div>
    );
}

function AskPin({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (pin: string) => void; onCancel: () => void }) {
    const [pin, setPin] = useState("");
    return (
        <form
            className="approval-tan pin-form"
            onSubmit={(e) => {
                e.preventDefault();
                onSubmit(pin);
                setPin("");
            }}
        >
            <input className="inp" type="password" autoComplete="off" aria-label="PIN" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
            <Button className="btn-primary" type="submit" busy={busy} disabled={!pin}>Abrufen</Button>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
        </form>
    );
}

/** Fetches one account of the card; spins while a run covers it. */
/** Fetches all accounts of a bank access with the own login; an empty cell without a usable login. */
function ConnectionSyncButton({ c, syncing }: { c: BankConnection; syncing: boolean }) {
    const status = c.myLogin?.status;
    if (!status || !canFetch(c)) return <span />;
    const label = syncing ? `„${c.name}“ wird abgerufen` : `„${c.name}“ abrufen`;
    return (
        <button type="button" className="mini" aria-label={label} title={label} aria-busy={syncing || undefined} onClick={() => !syncing && void startSync({ connectionId: c.id })}>
            <Ic icon={RefreshCw} size={15} className={syncing ? "spin" : undefined} />
        </button>
    );
}

function AccountSyncButton({ id, name, syncing }: { id: number; name: string; syncing: boolean }) {
    const label = syncing ? `„${name}“ wird abgerufen` : `„${name}“ abrufen`;
    return (
        <button type="button" className="mini" aria-label={label} title={label} aria-busy={syncing || undefined} onClick={() => !syncing && void startSync({ accountId: id })}>
            <Ic icon={RefreshCw} size={14} className={syncing ? "spin" : undefined} />
        </button>
    );
}

function PinForm({ connectionId, savePin: initial, onDone }: { connectionId: number; savePin: boolean; onDone: () => void }) {
    const [pin, setPin] = useState("");
    const [savePin, setSavePin] = useState(initial);
    const [busy, setBusy] = useState(false);
    return (
        <form
            className="approval-tan pin-form"
            onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                    await call(routes.changePin, { params: { id: connectionId }, body: { pin, savePin } });
                    refreshBank();
                    ui.toast(savePin ? "PIN gespeichert" : "PIN wird nicht mehr gespeichert");
                    onDone();
                } catch (err) {
                    ui.toast(errorText(err), "error");
                } finally {
                    setBusy(false);
                    setPin("");
                }
            }}
        >
            <input className="inp" type="password" autoComplete="off" aria-label="Neue PIN" placeholder="Neue PIN" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
            <label className="switch-label">
                <Switch checked={savePin} onChange={setSavePin} label="PIN speichern" />
                PIN speichern
            </label>
            <Button className="btn-primary" type="submit" busy={busy} disabled={!pin}>Speichern</Button>
        </form>
    );
}
