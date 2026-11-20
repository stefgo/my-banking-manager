import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Dialog as RDialog } from "radix-ui";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, CircleHelp, Pencil, Send, ShieldCheck, Smartphone, X, Zap } from "lucide-react";
import {
    centsToInput,
    cleanIban,
    groupIban,
    ibanLength,
    ibanProblem,
    isValidIban,
    joinRemittance,
    needsBic,
    parseAmount,
    REMITTANCE_LINE_MAX,
    REMITTANCE_LINES,
    routes,
    SEPA_NAME_MAX,
    splitRemittance,
    toIsoDate,
    wrapRemittance,
    type ConnectorChallenge,
    type Transfer,
    type VopResult,
} from "@mbm/shared";
import { ApiFailure, call, errorText } from "../lib/api";
import { useConnections } from "../lib/bank";
import { fieldProps, focusFirstError, hasErrors, type FieldErrors } from "../lib/fields";
import { fmt } from "../lib/format";
import { chipDate } from "../lib/orders";
import { invalidate, useAccounts, useAction, useTransfer, useTransferAccounts, useTransferPayees, useTransfers } from "../lib/queries";
import { bicToSend, blzOfIban, checkTransfer, emptyForm, isRunning, newRequestId, needsSecondConfirm, ibanAsTyped, remittanceLeft, STATUS_LABEL, VOP_VIEW, type Tone, type TransferForm } from "../lib/transfer";
import { ui, useUi, type TransferDraft } from "../lib/ui";
import { Amt, Button, Empty, NoBankAccess, Switch } from "../components/common";
import { Field } from "../components/form";
import { Ic, Tile } from "../components/icons";
import { BankText } from "../components/BankText";
import { Picker } from "../components/pickers";
import { SkeletonRows } from "../components/Skeleton";

type TransferAccount = NonNullable<ReturnType<typeof useTransferAccounts>["data"]>[number];

const STEPS = ["Erfassen", "Prüfen", "Freigeben"] as const;

/** Up to this many accounts the form shows them as tiles; with more, as a list to pick from. */
const FROM_TILES_MAX = 4;

/**
 * The history of all users' transfers. A new transfer opens in a dialog, in three steps: enter,
 * check, approve. The bank checks the payee's name; a differing name needs a deliberate confirmation.
 */
export function TransferPage() {
    const accounts = useTransferAccounts();
    const history = useTransfers();
    const transfers = history.data ?? [];
    const formOpen = useUi((s) => s.transferForm);
    const list = accounts.data ?? [];
    const connections = useConnections();
    const hasLogin = (connections.data ?? []).some((c) => c.myLogin !== null);
    // A transfer of this user that still waits (e.g. after leaving the page) brings the dialog back,
    // once per transfer and visit, so closing it while the bank works is respected
    const waitingId = transfers.find((t) => t.mine && isRunning(t.status))?.id ?? null;
    const reopened = useRef<number | null>(null);
    useEffect(() => {
        if (waitingId === null || reopened.current === waitingId) return;
        reopened.current = waitingId;
        ui.showTransferForm(true);
    }, [waitingId]);

    return (
        <>
            <section className="hero ctx">
                <div className="ctx-top">
                    <span className="ctx-ic">
                        <Ic icon={Send} size={22} />
                    </span>
                    <div className="ctx-title">
                        <span className="label">SEPA-Überweisungen</span>
                        <h1>Überweisen</h1>
                    </div>
                </div>
                {list.length > 0 && (
                    <div className="ctx-actions">
                        {waitingId !== null ? (
                            <Button className="btn-primary" icon={Send} onClick={() => ui.showTransferForm(true)}>
                                Laufende Überweisung
                            </Button>
                        ) : (
                            <Button className="btn-primary" icon={Send} onClick={() => ui.newTransfer()}>
                                Neue Überweisung
                            </Button>
                        )}
                    </div>
                )}
            </section>
            {!history.data || accounts.isLoading || connections.isPending ? (
                <section className="panel list-panel" aria-label="Verlauf">
                    <SkeletonRows rows={5} />
                </section>
            ) : transfers.length === 0 ? (
                <section className="panel list-panel" aria-label="Verlauf">
                    {list.length === 0 ? (
                        <NoAccounts hasLogin={hasLogin} />
                    ) : (
                        <Empty
                            icon={Send}
                            title="Noch keine Überweisungen"
                            text="Hier erscheinen die Überweisungen, die über MBM an die Bank gehen."
                            action={
                                <Button className="btn-primary" icon={Send} onClick={() => ui.newTransfer()}>
                                    Neue Überweisung
                                </Button>
                            }
                        />
                    )}
                </section>
            ) : (
                <History transfers={transfers} />
            )}
            {formOpen && list.length > 0 && <TransferDialog accounts={list} transfers={transfers} />}
        </>
    );
}

/** The transfer form and its way to the bank. Clicking beside it does not close it, Esc and ✕ do. */
function TransferDialog({ accounts, transfers }: { accounts: TransferAccount[]; transfers: Transfer[] }) {
    const draft = useUi((s) => s.transferDraft);
    const [activeId, setActiveId] = useState<number | null>(null);
    const [formKey, setFormKey] = useState(0);
    // A transfer of this user that still waits comes back, and stays shown once it ends, so its
    // outcome is seen (above all "Ausgang unbekannt")
    const waiting = transfers.find((t) => t.mine && isRunning(t.status));
    if (activeId === null && waiting) setActiveId(waiting.id);
    const shownId = activeId ?? waiting?.id ?? null;
    const close = () => ui.showTransferForm(false);

    const startOver = (next: TransferDraft | null) => {
        ui.prefillTransfer(next);
        setActiveId(null);
        setFormKey((k) => k + 1);
    };

    return (
        <RDialog.Root open onOpenChange={(o) => !o && close()}>
            <RDialog.Portal>
                <div className="modal-wrap">
                    <RDialog.Overlay className="scrim" />
                    <RDialog.Content className="modal tf-modal" aria-describedby={undefined} onInteractOutside={(e) => e.preventDefault()}>
                        <RDialog.Title className="sr-only">{shownId !== null ? "Überweisung" : "Neue Überweisung"}</RDialog.Title>
                        <RDialog.Close className="icon-btn tf-close" aria-label="Schließen">
                            <Ic icon={X} />
                        </RDialog.Close>
                        {shownId !== null ? (
                            <RunView key={shownId} id={shownId} onNew={() => startOver(null)} onEdit={startOver} onClose={close} />
                        ) : (
                            <Composer key={`${draft?.seq ?? 0}-${formKey}`} draft={draft} accounts={accounts} onSent={setActiveId} onCancel={close} />
                        )}
                    </RDialog.Content>
                </div>
            </RDialog.Portal>
        </RDialog.Root>
    );
}

/** No account to transfer from: either no own bank connection yet, or its bank does not offer transfers. */
function NoAccounts({ hasLogin }: { hasLogin: boolean }) {
    const navigate = useNavigate();
    if (!hasLogin) return <NoBankAccess reason="Zum Überweisen brauchst du eine Bankverbindung." />;
    return (
        <Empty
            icon={Send}
            title="Kein Konto für Überweisungen"
            text="Deine Bank bietet für deine Konten keine Überweisungen über FinTS an."
            action={<Button onClick={() => void navigate({ to: "/settings", search: { tab: "accounts" } })}>Zu den Bankzugängen</Button>}
        />
    );
}

function Steps({ at }: { at: number }) {
    return (
        <ol className="steps tf" aria-label="Schritte">
            {STEPS.map((s, i) => (
                <Fragment key={s}>
                    {i > 0 && <li className="step-sep" aria-hidden="true" />}
                    <li className={`step ${i < at ? "done" : i === at ? "on" : ""}`} aria-current={i === at ? "step" : undefined}>
                        <span className="n">{i < at ? <Ic icon={Check} size={13} /> : i + 1}</span>
                        {s}
                    </li>
                </Fragment>
            ))}
        </ol>
    );
}

// ---------- Enter and check ----------

const formOf = (d: TransferDraft | null, accounts: TransferAccount[]): TransferForm => {
    const account = accounts.find((a) => a.id === d?.accountId) ?? accounts[0];
    return {
        ...emptyForm(account ? String(account.id) : ""),
        payeeName: (d?.payeeName ?? "").slice(0, SEPA_NAME_MAX),
        payeeIban: d?.payeeIban ? groupIban(d.payeeIban) : "",
        payeeBic: d?.payeeBic ?? "",
        amount: d?.amount ? centsToInput(d.amount) : "",
        remittance: splitRemittance(d?.remittance ?? ""),
        instant: !!d?.instant && !!account?.instant,
    };
};

/** A saved payee or a counterparty from the bookings, as the form takes it over. */
type PayeePick = { name: string; iban: string; bic: string | null };

const initials = (name: string): string =>
    name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("");

const FIELD_ID: Record<keyof TransferForm, string> = { accountId: "tr-acc", payeeName: "tr-name", payeeIban: "tr-iban", payeeBic: "tr-bic", amount: "tr-amount", remittance: "tr-purpose", instant: "tr-instant", pin: "tr-pin" };

function Composer({ draft, accounts, onSent, onCancel }: { draft: TransferDraft | null; accounts: TransferAccount[]; onSent: (id: number) => void; onCancel: () => void }) {
    const [form, setForm] = useState<TransferForm>(() => formOf(draft, accounts));
    const account = accounts.find((a) => String(a.id) === form.accountId);
    const [step, setStep] = useState<"edit" | "review">(() => (draft?.review && !hasErrors(checkTransfer(formOf(draft, accounts), !!account?.pinRequired)) ? "review" : "edit"));
    const [errors, setErrors] = useState<FieldErrors>({});
    const [sending, setSending] = useState(false);
    // One per form: sending it twice (double click, retry after a lost answer) gives the same transfer
    const [requestId, setRequestId] = useState(newRequestId);
    const recent = (useTransferPayees().data?.payees ?? []).slice(0, 5);
    const amountRef = useRef<HTMLInputElement>(null);
    const cents = parseAmount(form.amount);
    const remittance = joinRemittance(form.remittance);
    const bic = bicToSend(form);

    const set = <K extends keyof TransferForm>(k: K, v: TransferForm[K]) => {
        setForm((f) => ({ ...f, [k]: v }));
        if (errors[FIELD_ID[k]]) setErrors((e) => ({ ...e, [FIELD_ID[k]]: undefined }));
    };
    const takePayee = (p: PayeePick) => {
        setForm((f) => ({ ...f, payeeName: p.name.slice(0, SEPA_NAME_MAX), payeeIban: groupIban(p.iban), payeeBic: p.bic ?? "" }));
        setErrors((e) => ({ ...e, "tr-name": undefined, "tr-iban": undefined, "tr-bic": undefined }));
        requestAnimationFrame(() => amountRef.current?.focus());
    };

    const review = (e: React.FormEvent) => {
        e.preventDefault();
        const next = checkTransfer(form, !!account?.pinRequired);
        setErrors(next);
        if (focusFirstError(next)) return;
        setForm((f) => ({ ...f, payeeIban: groupIban(f.payeeIban), payeeName: f.payeeName.trim(), payeeBic: f.payeeBic.trim().toUpperCase(), remittance: f.remittance.map((l) => l.trim()) }));
        setStep("review");
    };

    const send = async () => {
        setSending(true);
        try {
            const t = await call(routes.createTransfer, {
                body: {
                    requestId,
                    accountId: Number(form.accountId),
                    payeeName: form.payeeName.trim(),
                    payeeIban: cleanIban(form.payeeIban),
                    payeeBic: bic,
                    amount: parseAmount(form.amount)!,
                    remittance,
                    instant: form.instant,
                    ...(account?.pinRequired ? { pin: form.pin } : {}),
                },
            });
            invalidate("transfers");
            onSent(t.id);
        } catch (err) {
            if (err instanceof ApiFailure && err.code === "confirm_required") {
                ui.confirmSecret({
                    secret: "password",
                    title: "Passwort bestätigen",
                    text: "Deine letzte Passworteingabe ist eine Weile her. Bitte bestätige vor der Überweisung, dass du es bist.",
                    confirm: "Bestätigen",
                    run: (password) => call(routes.confirmPassword, { body: { password } }),
                    onDone: () => void send(),
                });
            } else {
                // An earlier send of this form arrived with other data: it shows in the history; sending
                // again is a new transfer, and only on purpose
                if (err instanceof ApiFailure && err.code === "request_id_conflict") {
                    setRequestId(newRequestId());
                    invalidate("transfers");
                }
                ui.toast(errorText(err), "error");
            }
        } finally {
            setSending(false);
        }
    };

    if (step === "review") {
        return (
            <section className="panel tf-main" aria-label="Überweisung prüfen">
                <Steps at={1} />
                <div>
                    <span className="label">{form.instant ? "Echtzeitüberweisung" : "Überweisung"} an</span>
                    <h2 className="tf-payee">{form.payeeName}</h2>
                </div>
                <div className="r-amount review-amount amt">{fmt(cents!)}</div>
                <dl className="d-list">
                    <Row k="IBAN" v={<span className="mono">{groupIban(form.payeeIban)}</span>} />
                    {bic && <Row k="BIC" v={<span className="mono">{bic}</span>} />}
                    <Row k="Bank" v={<BankName iban={form.payeeIban} />} />
                    <Row k="Von Konto" v={account?.name ?? ""} />
                    <Row k="Verwendungszweck" v={remittance || <span className="faint">ohne</span>} />
                    <Row k="Ausführung" v={form.instant ? "sofort, in Sekunden beim Empfänger" : "am nächsten Bankarbeitstag"} />
                </dl>
                <div className="note">
                    <Ic icon={ShieldCheck} size={16} />
                    <span>
                        {account?.payeeVerification
                            ? "Die Bank prüft zuerst, ob der Name zur IBAN passt. Danach gibst du die Überweisung in deiner App frei."
                            : "Danach gibst du die Überweisung in deiner App frei. Diese Bank meldet keine Empfängerüberprüfung."}
                    </span>
                </div>
                <div className="actions">
                    <Button icon={ArrowLeft} className="btn-ghost" onClick={() => setStep("edit")} disabled={sending}>
                        Ändern
                    </Button>
                    <Button icon={Send} className="btn-primary" busy={sending} onClick={() => void send()} autoFocus>
                        An die Bank senden
                    </Button>
                </div>
            </section>
        );
    }

    const remLeft = remittanceLeft(form.remittance);
    return (
        <form className="panel tf-main tf-edit" aria-label="Überweisung erfassen" onSubmit={review} noValidate>
            <Steps at={0} />
            <FromAccount accounts={accounts} value={form.accountId} error={errors["tr-acc"]} onPick={(a) => setForm((f) => ({ ...f, accountId: String(a.id), instant: f.instant && a.instant, pin: "" }))} />
            {recent.length > 0 && (
                <div className="recent" aria-label="Zuletzt genutzte Empfänger">
                    <span className="label">Zuletzt</span>
                    {recent.map((p) => (
                        <button key={p.id} type="button" className="pchip" onClick={() => takePayee(p)}>
                            <span className="av" aria-hidden="true">
                                {initials(p.name)}
                            </span>
                            {p.name}
                        </button>
                    ))}
                </div>
            )}
            <PayeeField name={form.payeeName} error={errors["tr-name"]} onName={(v) => set("payeeName", v)} onPick={takePayee} />
            <IbanField value={form.payeeIban} error={errors["tr-iban"]} onChange={(v) => set("payeeIban", v)} />
            {needsBic(cleanIban(form.payeeIban)) && (
                <Field id="tr-bic" label="BIC (optional)" error={errors["tr-bic"]} hint="Für Überweisungen in dieses Land verlangen manche Banken die BIC.">
                    <input
                        className="inp mono tf-bic"
                        placeholder="z. B. UBSWCHZH80A"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={11}
                        value={form.payeeBic}
                        onChange={(e) => set("payeeBic", e.target.value.toUpperCase().replace(/\s/g, ""))}
                        {...fieldProps("tr-bic", errors["tr-bic"], true)}
                    />
                </Field>
            )}
            <Field id="tr-amount" label="Betrag" error={errors["tr-amount"]}>
                <div className="amount-wrap tf-amount">
                    <input ref={amountRef} className="inp" inputMode="decimal" placeholder="0,00" autoComplete="off" value={form.amount} onChange={(e) => set("amount", e.target.value)} {...fieldProps("tr-amount", errors["tr-amount"])} />
                    <span className="cur">€</span>
                </div>
            </Field>
            <Field id="tr-purpose" label="Verwendungszweck" error={errors["tr-purpose"]} hint={remLeft < 30 ? `Noch ${Math.max(remLeft, 0)} Zeichen` : undefined}>
                <RemittanceLines lines={form.remittance} error={errors["tr-purpose"]} hasHint={remLeft < 30} onChange={(v) => set("remittance", v)} />
            </Field>
            {(account?.instant || account?.pinRequired) && (
                <div className="exec">
                    {account.instant && (
                        <div className="switch-row">
                            <span>
                                <b>
                                    <Ic icon={Zap} size={14} /> Echtzeitüberweisung
                                </b>
                                <small>In Sekunden beim Empfänger, auch am Wochenende.</small>
                            </span>
                            <Switch checked={form.instant} onChange={(v) => set("instant", v)} label="Echtzeitüberweisung" />
                        </div>
                    )}
                    {account.pinRequired && (
                        <Field id="tr-pin" label="PIN" error={errors["tr-pin"]} hint="Die PIN ist nicht gespeichert und gilt nur für diese Überweisung.">
                            <input className="inp" type="password" autoComplete="off" value={form.pin} onChange={(e) => set("pin", e.target.value)} {...fieldProps("tr-pin", errors["tr-pin"], true)} />
                        </Field>
                    )}
                </div>
            )}
            <div className="actions">
                <Button className="btn-ghost tf-cancel" onClick={onCancel}>
                    Abbrechen
                </Button>
                <Button className="btn-primary" type="submit">
                    Weiter zur Prüfung
                </Button>
            </div>
        </form>
    );
}

/** The account to send from: one is just shown, up to four are tiles, more a list to pick from. */
function FromAccount({ accounts, value, error, onPick }: { accounts: TransferAccount[]; value: string; error?: string; onPick: (a: TransferAccount) => void }) {
    const all = useAccounts().data ?? [];
    const [open, setOpen] = useState(false);
    const body = (a: TransferAccount) => {
        const full = all.find((x) => x.id === a.id);
        return (
            <>
                {full && <Tile icon={full.icon} color={full.color} size={14} />}
                <span>
                    <b>{a.name}</b>
                    <small>{full ? <Amt cents={full.balance} /> : a.connectionName}</small>
                </span>
            </>
        );
    };
    const current = accounts.find((a) => String(a.id) === value);
    let control: React.ReactNode;
    if (accounts.length === 1) {
        control = (
            <div className="from-opt from-one" id="tr-acc" aria-labelledby="tr-acc-label tr-acc" tabIndex={-1}>
                {body(accounts[0]!)}
            </div>
        );
    } else if (accounts.length > FROM_TILES_MAX) {
        const items = accounts.map((a) => {
            const full = all.find((x) => x.id === a.id);
            return { value: String(a.id), label: a.name, search: a.connectionName, icon: full ? <Tile icon={full.icon} color={full.color} size={12} className="ti-s" /> : undefined, hint: full ? <Amt cents={full.balance} /> : a.connectionName };
        });
        control = (
            <Picker
                open={open}
                onOpenChange={setOpen}
                items={items}
                value={value}
                placeholder="Konto suchen …"
                onPick={(v) => {
                    const a = accounts.find((x) => String(x.id) === v);
                    if (a) onPick(a);
                }}
                trigger={
                    <button type="button" className="from-opt from-pick" id="tr-acc" aria-labelledby="tr-acc-label tr-acc" aria-invalid={error ? true : undefined}>
                        {current ? body(current) : <span className="faint">Konto wählen</span>}
                        <Ic icon={ChevronDown} size={15} />
                    </button>
                }
            />
        );
    } else {
        control = (
            <div className="from" role="radiogroup" aria-labelledby="tr-acc-label" id="tr-acc">
                {accounts.map((a) => (
                    <button key={a.id} type="button" role="radio" aria-checked={String(a.id) === value} className="from-opt" onClick={() => onPick(a)}>
                        {body(a)}
                    </button>
                ))}
            </div>
        );
    }
    return (
        <div className="field">
            <span className="flabel" id="tr-acc-label">
                Von Konto
            </span>
            {control}
            {error && <p className="hint bad">{error}</p>}
        </div>
    );
}

/**
 * The remittance information in four lines of 35 characters, written like on paper: Enter starts
 * the next line, typing past a full line carries the word over, pasted text is spread over the
 * lines. The bank gets the lines joined with a space; SEPA has no line breaks.
 */
function RemittanceLines({ lines, error, hasHint, onChange }: { lines: string[]; error?: string; hasHint: boolean; onChange: (lines: string[]) => void }) {
    const refs = useRef<(HTMLInputElement | null)[]>([]);
    const max = REMITTANCE_LINE_MAX;
    const last = REMITTANCE_LINES - 1;
    const focusAt = (i: number, pos: number | "end") =>
        requestAnimationFrame(() => {
            const el = refs.current[i];
            if (!el) return;
            el.focus();
            const p = pos === "end" ? el.value.length : Math.min(pos, el.value.length);
            el.setSelectionRange(p, p);
        });
    /** Lines from `i` on replaced by `tail`; empty lines go first when it does not fit. */
    const replaceFrom = (i: number, tail: string[]): string[] => {
        const room = REMITTANCE_LINES - i;
        let t = tail;
        for (let k = t.length - 1; t.length > room && k >= 0; k--) if (!t[k]!.trim()) t = t.filter((_, n) => n !== k);
        // Still too long: the rest stays in the last line, where the check flags it
        if (t.length > room) t = [...t.slice(0, room - 1), t.slice(room - 1).join(" ")];
        const next = [...lines.slice(0, i), ...t];
        while (next.length < REMITTANCE_LINES) next.push("");
        return next;
    };

    const change = (i: number, e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        if (v.length <= max) {
            onChange(lines.map((l, n) => (n === i ? v : l)));
            return;
        }
        // Typed past the end of a full line: the word goes on in the next line, if that is empty
        const atEnd = e.target.selectionStart === v.length;
        if (!atEnd || i === last || lines[i + 1]!.trim()) return;
        const cut = v.lastIndexOf(" ", max);
        const at = cut > 0 ? cut : max;
        onChange(lines.map((l, n) => (n === i ? v.slice(0, at).trimEnd() : n === i + 1 ? v.slice(at).trimStart() : l)));
        focusAt(i + 1, "end");
    };

    const paste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
        const el = e.currentTarget;
        const pasted = e.clipboardData.getData("text");
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        const merged = el.value.slice(0, start) + pasted + el.value.slice(end);
        if (!/[\r\n]/.test(pasted) && merged.length <= max) return;
        e.preventDefault();
        const wrapped = wrapRemittance(merged);
        const next = replaceFrom(i, [...wrapped, ...lines.slice(i + 1)]);
        onChange(next);
        focusAt(Math.min(i + Math.max(wrapped.length - 1, 0), last), "end");
    };

    const key = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        const el = e.currentTarget;
        const pos = el.selectionStart ?? 0;
        const collapsed = pos === el.selectionEnd;
        if (e.key === "Enter" && i < last) {
            // Like a text editor: the line breaks at the caret if there is a free line left
            e.preventDefault();
            if (collapsed && !lines[last]!.trim()) {
                onChange([...lines.slice(0, i), el.value.slice(0, pos), el.value.slice(pos), ...lines.slice(i + 1, last)]);
                focusAt(i + 1, 0);
            } else focusAt(i + 1, "end");
        } else if (e.key === "Backspace" && i > 0 && collapsed && pos === 0) {
            // At the start of a line: joins it to the one above if both fit in one line
            e.preventDefault();
            const prev = lines[i - 1]!;
            if (prev.length + el.value.length <= max) {
                onChange([...lines.slice(0, i - 1), prev + el.value, ...lines.slice(i + 1), ""]);
                focusAt(i - 1, prev.length);
            } else focusAt(i - 1, "end");
        } else if (e.key === "ArrowUp" && i > 0) {
            e.preventDefault();
            focusAt(i - 1, pos);
        } else if (e.key === "ArrowDown" && i < last) {
            e.preventDefault();
            focusAt(i + 1, pos);
        }
    };

    return (
        <div className={`rem-lines ${error ? "bad" : ""}`} role="group" aria-label="Verwendungszweck">
            {lines.map((l, i) => (
                <div key={i} className="rem-line">
                    <input
                        ref={(el) => {
                            refs.current[i] = el;
                        }}
                        className="rem-in"
                        placeholder={i === 0 ? "optional" : undefined}
                        autoComplete="off"
                        aria-label={i === 0 ? undefined : `Verwendungszweck, Zeile ${i + 1}`}
                        value={l}
                        onChange={(e) => change(i, e)}
                        onPaste={(e) => paste(i, e)}
                        onKeyDown={(e) => key(i, e)}
                        {...(i === 0 ? fieldProps("tr-purpose", error, hasHint) : { "aria-invalid": l.trim().length > max ? (true as const) : undefined })}
                    />
                    {l.length >= max - 5 && (
                        <span className={`rem-count ${l.length > max ? "bad" : ""}`} aria-hidden="true">
                            {l.length}/{max}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div>
            <dt>{k}</dt>
            <dd>{v}</dd>
        </div>
    );
}

/** The bank of a German IBAN, from the Bundesbank's directory on the server. */
function BankName({ iban }: { iban: string }) {
    const blz = isValidIban(iban) ? blzOfIban(iban) : null;
    const q = useQuery({ queryKey: ["bank-of", blz], queryFn: () => call(routes.searchBanks, { query: { q: blz! } }), enabled: blz !== null, staleTime: Infinity });
    const hit = q.data?.find((b) => b.blz === blz);
    if (!blz) return <span className="faint">{isValidIban(iban) ? "Bank im Ausland" : "—"}</span>;
    return <span>{hit ? `${hit.name}${hit.place ? `, ${hit.place}` : ""}` : "unbekannt"}</span>;
}

function IbanField({ value, error, onChange }: { value: string; error?: string; onChange: (v: string) => void }) {
    const clean = cleanIban(value);
    const problem = clean ? ibanProblem(clean) : null;
    const complete = clean !== "" && problem === null;
    // Says early what is wrong, but not while the IBAN is still being typed: a wrong country code
    // at once, length and check digits once the length of that country is reached
    const len = ibanLength(clean);
    const early = problem && clean.length >= 2 && (len === null || clean.length >= len) ? problem : undefined;
    const shown = error ?? early;
    // Paper form while typing; the caret stays behind the character it was behind
    const write = (el: HTMLInputElement, raw: string, pos: number) => {
        const typed = cleanIban(raw);
        if (len !== null && clean.length >= len && typed.length > (ibanLength(typed) ?? 34)) {
            // Like a field at its maximum length: a complete IBAN takes no more characters
            const back = Math.max(0, pos - (raw.length - value.length));
            requestAnimationFrame(() => el.setSelectionRange(back, back));
            return;
        }
        const next = ibanAsTyped(raw, pos);
        onChange(next.value);
        requestAnimationFrame(() => {
            if (document.activeElement === el) el.setSelectionRange(next.caret, next.caret);
        });
    };
    const key = (e: React.KeyboardEvent<HTMLInputElement>) => {
        const el = e.currentTarget;
        const pos = el.selectionStart ?? 0;
        if (pos !== el.selectionEnd) return;
        // A space between groups is not deleted on its own but with the character beyond it
        if (e.key === "Backspace" && pos > 1 && el.value[pos - 1] === " ") {
            e.preventDefault();
            write(el, el.value.slice(0, pos - 2) + el.value.slice(pos), pos - 2);
        } else if (e.key === "Delete" && el.value[pos] === " ") {
            e.preventDefault();
            write(el, el.value.slice(0, pos) + el.value.slice(pos + 2), pos);
        }
    };
    return (
        <Field id="tr-iban" label="IBAN" error={shown} hint={complete ? <BankName iban={clean} /> : undefined}>
            <input
                className="inp mono tf-iban"
                placeholder="DE00 0000 0000 0000 0000 00"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => write(e.currentTarget, e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
                onKeyDown={key}
                {...fieldProps("tr-iban", shown, complete)}
            />
        </Field>
    );
}

/**
 * The payee's name with suggestions: saved payees first, then counterparties of debits. A saved
 * payee leaves the list with ✕ or the Delete key.
 */
function PayeeField({ name, error, onName, onPick }: { name: string; error?: string; onName: (v: string) => void; onPick: (p: PayeePick) => void }) {
    const data = useTransferPayees().data;
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const action = useAction();
    const items = useMemo(() => {
        const all: (PayeePick & { id?: number })[] = [...(data?.payees ?? []), ...(data?.suggestions ?? [])];
        const q = name.trim().toLowerCase();
        const compact = q.replace(/\s/g, "");
        return q ? all.filter((p) => p.name.toLowerCase().includes(q) || (compact.length >= 4 && p.iban.toLowerCase().includes(compact))).slice(0, 7) : [];
    }, [data, name]);
    const shown = open && items.length > 0;
    const take = (i: number) => {
        const p = items[i];
        if (!p) return;
        onPick(p);
        setOpen(false);
        setActive(-1);
    };
    const remove = (i: number) => {
        const p = items[i];
        if (p?.id === undefined) return;
        setActive(-1);
        void action.run(() => call(routes.deletePayee, { params: { id: p.id! } }), { topics: ["payees"], ok: `„${p.name}“ ist nicht mehr unter den Empfängern.` });
    };
    const left = SEPA_NAME_MAX - name.length;
    return (
        <Field id="tr-name" label="Empfänger" error={error} hint={left < 15 ? `Noch ${left} Zeichen` : undefined}>
            <div className="suggest-wrap">
                <input
                    className="inp"
                    placeholder="Name oder Firma"
                    autoComplete="off"
                    maxLength={SEPA_NAME_MAX}
                    value={name}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={shown}
                    aria-controls={shown ? "tr-name-list" : undefined}
                    aria-activedescendant={shown && active >= 0 ? `tr-name-${active}` : undefined}
                    onChange={(e) => {
                        onName(e.target.value);
                        setOpen(true);
                        setActive(-1);
                    }}
                    onBlur={() => setOpen(false)}
                    onKeyDown={(e) => {
                        if (!shown) return;
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                            e.preventDefault();
                            const n = items.length;
                            setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
                        } else if ((e.key === "Enter" || e.key === "Tab") && active >= 0) {
                            e.preventDefault();
                            take(active);
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            setOpen(false);
                        } else if (e.key === "Delete" && active >= 0 && items[active]?.id !== undefined) {
                            e.preventDefault();
                            remove(active);
                        }
                    }}
                    {...fieldProps("tr-name", error)}
                />
                {shown && (
                    <div className="suggest" role="listbox" id="tr-name-list" aria-label="Empfänger">
                        {items.map((p, i) => (
                            <div
                                key={p.iban}
                                id={`tr-name-${i}`}
                                role="option"
                                aria-selected={i === active}
                                className={`pop-item ${i === active ? "on" : ""}`}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    take(i);
                                }}
                            >
                                <span>{p.name}</span>
                                <small className="mono">{groupIban(p.iban)}</small>
                                {p.id !== undefined && (
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        className="suggest-del"
                                        title="Aus den Empfängern entfernen (Entf)"
                                        aria-label={`„${p.name}“ aus den Empfängern entfernen`}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                        }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            remove(i);
                                        }}
                                    >
                                        <Ic icon={X} size={13} />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Field>
    );
}

// ---------- On its way ----------

const draftOf = (t: Transfer): TransferDraft => ({ accountId: t.accountId, payeeName: t.payeeName, payeeIban: t.payeeIban, payeeBic: t.payeeBic, amount: t.amount, remittance: t.remittance, instant: t.instant });

/** Design class of the verification result (`.vop.match` …). */
const VOP_CLASS: Record<VopResult, string> = { match: "match", close_match: "close", no_match: "nomatch", not_applicable: "close", pending: "close", none: "none" };
const TONE_ICON: Record<Tone, typeof Check> = { ok: Check, warn: AlertTriangle, bad: X, neutral: CircleHelp };

function RunView({ id, onNew, onEdit, onClose }: { id: number; onNew: () => void; onEdit: (d: TransferDraft) => void; onClose: () => void }) {
    const t = useTransfer(id).data;
    const accounts = useAccounts().data ?? [];
    if (!t) return null;
    const account = accounts.find((a) => a.id === t.accountId);
    const at = t.status === "awaiting_tan" ? 2 : isRunning(t.status) ? 1 : 3;
    return (
        <section className="panel tf-main" aria-label="Überweisung">
            <Steps at={at} />
            <RunSummary t={t} account={account?.name} />
            {t.status === "submitting" && (
                <div className="tan" role="status">
                    <Orb small />
                    <h2>Wird an die Bank gesendet</h2>
                    <p className="muted">Die Bank prüft, ob der Name zur IBAN passt.</p>
                </div>
            )}
            {t.status === "awaiting_vop_confirm" && <VopDecision t={t} onEdit={onEdit} />}
            {t.status === "awaiting_tan" && <ApprovalWait t={t} />}
            {!isRunning(t.status) && <Outcome t={t} onNew={onNew} onEdit={onEdit} onClose={onClose} />}
        </section>
    );
}

/** What is on its way, above the state: so the approval on the phone can be compared with it. */
function RunSummary({ t, account }: { t: Transfer; account?: string }) {
    return (
        <div className="tf-sum">
            <div className="tf-sum-main">
                <span className="label">{t.instant ? "Echtzeitüberweisung" : "Überweisung"} an</span>
                <b>{t.payeeName}</b>
                <small>
                    <span className="mono">{groupIban(t.payeeIban)}</span>
                    {account && ` · von ${account}`}
                </small>
                {t.remittance && <small className="tf-sum-rem">{t.remittance}</small>}
            </div>
            <Amt cents={t.amount} className="tf-sum-amt" />
        </div>
    );
}

function Orb({ small = false }: { small?: boolean }) {
    return (
        <div className={`orb ${small ? "sm" : ""}`} aria-hidden="true">
            <span className="ring" />
            <span className="ring r2" />
            <span className="halo" />
            <span className="phone">
                <Ic icon={Smartphone} size={small ? 22 : 30} />
            </span>
        </div>
    );
}

const VOP_TEXT: Record<VopResult, (v: NonNullable<Transfer["vop"]>) => string> = {
    match: () => "Die Bank des Empfängers führt das Konto unter diesem Namen.",
    close_match: (v) => (v.payeeName ? `Die Bank des Empfängers kennt das Konto unter „${v.payeeName}“.` : "Der Name weicht etwas von dem ab, den die Bank des Empfängers kennt."),
    no_match: () => "Der Name passt nicht zu dem, den die Bank des Empfängers für diese IBAN kennt. Das Geld könnte bei jemand anderem landen.",
    not_applicable: (v) => v.reason ?? "Die Bank des Empfängers konnte den Namen nicht prüfen.",
    pending: () => "Die Bank hat das Ergebnis noch nicht geliefert.",
    none: () => "Die Bank hat keinen Namensabgleich gemeldet.",
};

/** The verification result as the design shows it; `children` go below (checkbox, buttons). */
function VopCard({ t, children }: { t: Transfer; children?: React.ReactNode }) {
    const vop = t.vop;
    if (!vop) return null;
    const view = VOP_VIEW[vop.result];
    return (
        <div className={`vop ${VOP_CLASS[vop.result]}`} role="status">
            <span className="v-ic">
                <Ic icon={vop.result === "match" ? ShieldCheck : TONE_ICON[view?.tone ?? "neutral"]} size={20} />
            </span>
            <div>
                <h3>{view?.title ?? "Empfängerüberprüfung"}</h3>
                <p>{VOP_TEXT[vop.result](vop)}</p>
                {vop.explanation && <BankText text={vop.explanation} structured={vop.structured} />}
                {children}
            </div>
        </div>
    );
}

function VopDecision({ t, onEdit }: { t: Transfer; onEdit: (d: TransferDraft) => void }) {
    const [ack, setAck] = useState(false);
    const action = useAction();
    const vop = t.vop;
    const second = !!vop && needsSecondConfirm(vop.result);
    const act = (fn: () => Promise<unknown>) => action.run(fn, { topics: ["transfers"] });
    return (
        <VopCard t={t}>
            {t.mine ? (
                <>
                    {second && (
                        <label className="ack">
                            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                            <span>Ich habe den Hinweis gelesen und will trotzdem an „{t.payeeName}“ überweisen. Das Geld kann bei einem falschen Empfänger landen.</span>
                        </label>
                    )}
                    <div className="v-actions">
                        {vop?.result === "close_match" && vop.payeeName && (
                            <Button
                                className="btn-primary"
                                icon={Pencil}
                                busy={action.pending}
                                onClick={() =>
                                    void act(() => call(routes.cancelTransfer, { params: { id: t.id } })).then((r) => {
                                        if (r) onEdit({ ...draftOf(t), payeeName: vop.payeeName!, review: true });
                                    })
                                }
                            >
                                Mit „{vop.payeeName}“ neu einreichen
                            </Button>
                        )}
                        <Button className={second ? "btn-danger" : ""} disabled={second && !ack} busy={action.pending} onClick={() => void act(() => call(routes.confirmTransfer, { params: { id: t.id } }))}>
                            Trotzdem überweisen
                        </Button>
                        <Button className="btn-ghost" busy={action.pending} onClick={() => void act(() => call(routes.cancelTransfer, { params: { id: t.id } }))}>
                            Abbrechen
                        </Button>
                    </div>
                </>
            ) : (
                <p>Gestartet von {t.createdBy}. Nur {t.createdBy} kann bestätigen oder abbrechen.</p>
            )}
        </VopCard>
    );
}

/** Waiting for the approval: a calm animation for the app, or the field for the TAN. */
function ApprovalWait({ t }: { t: Transfer }) {
    const [tan, setTan] = useState("");
    const action = useAction();
    const c: ConnectorChallenge | null = t.challenge;
    const decoupled = !c || c.decoupled;
    const until = c?.validUntil ? c.validUntil.slice(11, 16) : "";
    const cancel = () => void action.run(() => call(routes.cancelTransfer, { params: { id: t.id } }), { topics: ["transfers"] });
    return (
        <>
            {t.vop && t.vop.result !== "none" && <VopCard t={t} />}
            <div className="tan" role="status" aria-live="polite">
                {decoupled && <Orb />}
                <h2>{!t.mine ? `Wartet auf die Freigabe durch ${t.createdBy}` : decoupled ? "Bitte in der App freigeben" : "TAN eingeben"}</h2>
                {t.mine && c?.text && <p className="muted approval-text">{c.text}</p>}
                {t.mine && (c?.medium || c?.methodName) && <small className="faint">{[c.methodName, c.medium && `Gerät: ${c.medium}`].filter(Boolean).join(" · ")}</small>}
                {until && <span className="countdown">gültig bis {until} Uhr</span>}
                {t.mine && !decoupled && (
                    <form
                        className="approval-tan"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!tan.trim()) return;
                            void action.run(() => call(routes.transferTan, { params: { id: t.id }, body: { tan: tan.trim() } }), { topics: ["transfers"] }).then(() => setTan(""));
                        }}
                    >
                        <input className="inp" inputMode="numeric" autoComplete="one-time-code" aria-label="TAN" placeholder="TAN" value={tan} onChange={(e) => setTan(e.target.value)} autoFocus />
                        <Button className="btn-primary" type="submit" busy={action.pending} disabled={!tan.trim()}>
                            Freigeben
                        </Button>
                    </form>
                )}
                {t.mine && (
                    <Button className="btn-ghost" onClick={cancel} busy={action.pending}>
                        Abbrechen
                    </Button>
                )}
            </div>
        </>
    );
}

const OUTCOME_TITLE: Partial<Record<Transfer["status"], (t: Transfer) => string>> = {
    executed: (t) => (t.instant ? (t.unconfirmed ? "Echtzeitüberweisung eingereicht" : "Echtzeitüberweisung ausgeführt") : "Überweisung ausgeführt"),
    rejected: () => "Von der Bank abgelehnt",
    failed: () => "Nicht gesendet",
    cancelled: () => "Abgebrochen",
    unknown: () => "Ausgang unbekannt",
};

function Outcome({ t, onNew, onEdit, onClose }: { t: Transfer; onNew: () => void; onEdit: (d: TransferDraft) => void; onClose: () => void }) {
    const ok = t.status === "executed";
    return (
        <div className="tan" role="status">
            {ok ? (
                <span className="okmark" aria-hidden="true">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                </span>
            ) : (
                <span className={`nomark ${t.status === "unknown" ? "warn" : t.status === "cancelled" ? "" : "bad"}`} aria-hidden="true">
                    <Ic icon={t.status === "unknown" ? AlertTriangle : X} size={36} />
                </span>
            )}
            <h2>{OUTCOME_TITLE[t.status]?.(t)}</h2>
            {t.bankMessage && <p className="muted">{t.bankMessage}</p>}
            {t.bankReference && (
                <small className="faint">
                    Referenz der Bank: <span className="mono">{t.bankReference}</span>
                </small>
            )}
            {ok && t.unconfirmed && <p className="muted small">Die Bank hat den Eingang beim Empfänger noch nicht bestätigt. Bitte beim nächsten Abruf in den Umsätzen prüfen.</p>}
            {ok && !t.transactionId && <p className="muted small">Die Buchung erscheint beim nächsten Abruf.</p>}
            <div className="actions tan-actions">
                {(t.status === "rejected" || t.status === "failed" || t.status === "cancelled") && (
                    <Button icon={Pencil} onClick={() => onEdit(draftOf(t))}>
                        Ändern und neu senden
                    </Button>
                )}
                {t.status === "unknown" && (
                    <Button
                        icon={Pencil}
                        onClick={() =>
                            ui.confirm({
                                title: "Neu erfassen?",
                                text: "Ob die erste Überweisung ausgeführt wurde, ist unbekannt. Bitte erst nach dem nächsten Abruf in den Umsätzen prüfen, sonst überweist du womöglich doppelt.",
                                confirm: "Trotzdem neu erfassen",
                                onConfirm: () => onEdit(draftOf(t)),
                            })
                        }
                    >
                        Neu erfassen …
                    </Button>
                )}
                <Button onClick={onClose}>Schließen</Button>
                <Button className="btn-primary" icon={Send} onClick={onNew}>
                    Neue Überweisung
                </Button>
            </div>
        </div>
    );
}

// ---------- History ----------

const localDate = (ts: string): string => toIsoDate(new Date(ts));

const statusTone = (t: Transfer): Tone =>
    t.status === "executed" ? "ok" : t.status === "rejected" || t.status === "failed" ? "bad" : t.status === "unknown" || t.status === "awaiting_vop_confirm" ? "warn" : "neutral";

function History({ transfers }: { transfers: Transfer[] }) {
    const open = useUi((s) => s.drawerTransfer);
    const accounts = useAccounts().data ?? [];
    const several = new Set(transfers.map((t) => t.createdBy)).size > 1;
    return (
        <section className="panel list-panel" aria-label="Verlauf">
            <div className="day">
                <span>Verlauf</span>
                <span>{transfers.length}</span>
            </div>
            <div className="up-list flat">
                {transfers.map((t) => {
                    const [d, m] = chipDate(localDate(t.createdAt));
                    const detail = [STATUS_LABEL[t.status], accounts.find((a) => a.id === t.accountId)?.name, several ? `von ${t.createdBy}` : "", t.remittance].filter(Boolean).join(" · ");
                    return (
                        <button key={t.id} type="button" className={`up ${open === t.id ? "sel" : ""}`} aria-pressed={open === t.id || undefined} onClick={() => ui.openTransfer(open === t.id ? null : t.id)}>
                            <span className="datechip">
                                <b>{d}</b>
                                <span>{m}</span>
                            </span>
                            <span className="up-main">
                                <b>{t.payeeName}</b>
                                <small>
                                    <span className={`st-dot ${statusTone(t)}`} aria-hidden="true" />
                                    <span>{detail}</span>
                                </small>
                            </span>
                            <Amt cents={-t.amount} className="up-amt" />
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
