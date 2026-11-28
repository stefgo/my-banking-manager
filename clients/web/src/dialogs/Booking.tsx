import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, RotateCcw, Scale, Tag } from "lucide-react";
import { centsToInput, isOffline, isValidIsoDate, parseAmount, routes, todayIso, type Topic, type Transaction, type TxEditField } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex, useGroups, usePayees, useTxById } from "../lib/queries";
import { accountsInTreeOrder, categoryPath } from "../lib/tree";
import { dateText, fmt, fmtSigned, partyName, shownParty, shownPurpose } from "../lib/format";
import { fieldProps, focusFirstError, hasErrors, type FieldErrors } from "../lib/fields";
import { ui } from "../lib/ui";
import { Modal, Button } from "../components/common";
import { Field } from "../components/form";
import { CatTile, Ic, Tile } from "../components/icons";
import { Picker, PickerButton } from "../components/pickers";
import { accountPickItems, useCategoryItems } from "../components/pickItems";

const BookingForm = z.object({
    accountId: z.string().min(1, "Bitte ein Konto wählen."),
    dir: z.enum(["out", "in"]),
    amount: z.string().refine((s) => {
        const c = parseAmount(s);
        return c !== null && c > 0;
    }, "Bitte einen Betrag größer als 0 eingeben."),
    date: z.string().refine(isValidIsoDate, "Bitte ein Datum wählen."),
    name: z.string().trim().min(1, "Bitte eine Gegenseite angeben.").max(140, "Höchstens 140 Zeichen."),
    purpose: z.string().max(400, "Höchstens 400 Zeichen."),
    pending: z.boolean(),
});
type BookingForm = z.infer<typeof BookingForm>;

/**
 * Books by hand, or changes a booking: one entered by hand as a whole; one from the bank, an import
 * or added by MBM in amount and date, with own texts shown instead of its counterparty and purpose.
 */
export function BookingDialog({ accountId, txId }: { accountId?: number; txId?: number }) {
    const tx = useTxById(txId);
    if (tx && tx.source !== "manual") return <TxDialog tx={tx} />;
    return <ManualDialog accountId={accountId} txId={txId} />;
}

function ManualDialog({ accountId, txId }: { accountId?: number; txId?: number }) {
    const accountsData = useAccounts().data;
    const groupsData = useGroups().data;
    // Same order as the account tree in the sidebar
    const accounts = useMemo(() => accountsInTreeOrder(groupsData ?? [], accountsData ?? []), [groupsData, accountsData]);
    const accountItems = useMemo(() => accountPickItems(accounts), [accounts]);
    const { index } = useCategoryIndex();
    const payees = usePayees().data;
    const catItems = useCategoryItems({ none: true });
    const action = useAction();
    const editTx = useTxById(txId);
    // The category picked here; until then the one of the booking being edited (undefined: none)
    const [picked, setPicked] = useState<{ id: number | null } | null>(null);
    const cat: number | null | undefined = picked ? picked.id : editTx?.categoryId;
    const editing = txId !== undefined;

    // Without an account given, an offline one first: that is where bookings by hand belong most
    const startAccount = accountId && accounts.some((a) => a.id === accountId) ? accountId : (accounts.find((a) => isOffline(a)) ?? accounts[0])?.id;
    const form = useForm<BookingForm>({
        resolver: zodResolver(BookingForm),
        defaultValues: { accountId: String(startAccount ?? ""), dir: "out", amount: "", date: todayIso(), name: "", purpose: "", pending: false },
    });
    const { register, handleSubmit, setValue, reset, formState, control } = form;
    register("accountId");
    const dir = useWatch({ control, name: "dir" });
    const accountValue = useWatch({ control, name: "accountId" });
    const account = accounts.find((a) => String(a.id) === accountValue);

    // Fill the form once the booking to edit has arrived
    useEffect(() => {
        if (!editTx) return;
        reset({
            accountId: String(editTx.accountId),
            dir: editTx.amount < 0 ? "out" : "in",
            amount: centsToInput(Math.abs(editTx.amount)),
            date: editTx.bookingDate,
            name: shownParty(editTx),
            purpose: shownPurpose(editTx),
            pending: editTx.status === "pending",
        });
    }, [editTx, reset]);

    const names = useMemo(() => (payees ?? []).map((p) => p.name).slice(0, 60), [payees]);

    const submit = handleSubmit(async (v) => {
        const cents = parseAmount(v.amount)!;
        const amount = v.dir === "out" ? -cents : cents;
        const name = v.name.trim();
        const purpose = v.purpose.trim();
        // The fields show what the booking shows: a text left as it was keeps the booking's own
        const party = editTx && name === shownParty(editTx) ? editTx.counterpartyName : name;
        const remittance = editTx && purpose === shownPurpose(editTx) ? editTx.remittance : purpose;
        const body = {
            bookingDate: v.date,
            amount,
            counterpartyName: party,
            remittance,
            status: v.pending ? ("pending" as const) : ("booked" as const),
            ...(cat !== undefined ? { categoryId: cat } : {}),
        };
        const accountName = accounts.find((a) => a.id === Number(v.accountId))?.name ?? "";
        const r = await action.run<Transaction>(
            async () => {
                if (!editing) return call(routes.createTransaction, { params: { id: Number(v.accountId) }, body });
                let t = await call(routes.updateTransaction, { params: { id: txId! }, body });
                // A text typed as the booking already says it, while another one was shown instead
                for (const [field, typed] of [["counterparty", name], ["remittance", purpose]] as [TxEditField, string][]) {
                    const shown = field === "counterparty" ? shownParty(t) : shownPurpose(t);
                    if (shown !== typed) t = await call(routes.setTransactionEdit, { params: { id: t.id, field }, body: { value: null } });
                }
                return t;
            },
            { topics: ["accounts", "transactions", "categories"], ok: `${editing ? "Buchung geändert" : "Buchung erfasst"} · ${accountName} ${fmtSigned(amount)}` },
        );
        if (r) ui.close();
    });

    const err = formState.errors;

    return (
        <Modal title={editing ? "Buchung ändern" : "Buchung erfassen"} onClose={() => ui.close()} narrow>
            <form className="form-grid" style={{ gap: 16 }} onSubmit={submit} noValidate>
                <Field id="bk-acc" label="Konto" error={err.accountId?.message}>
                    <Picker
                        items={accountItems}
                        value={accountValue}
                        onPick={(v) => setValue("accountId", v, { shouldValidate: formState.isSubmitted })}
                        placeholder="Konto suchen …"
                        trigger={
                            <PickerButton {...fieldProps("bk-acc", err.accountId?.message)} set={!!account} disabled={editing} icon={account && <Tile icon={account.icon} color={account.color} size={12} className="ti-s" />}>
                                {account ? account.name : "Konto wählen"}
                            </PickerButton>
                        }
                    />
                </Field>
                {account && !isOffline(account) && !editing && (
                    <p className="muted small">Der Kontostand der Bank bleibt; die Buchung ändert nur den Verlauf davor. Liefert die Bank dieselbe Buchung, übernimmt sie diese.</p>
                )}
                <div className="seg" role="group" aria-label="Richtung" style={{ justifySelf: "start" }}>
                    <button type="button" aria-pressed={dir === "out"} onClick={() => setValue("dir", "out")}>Ausgabe</button>
                    <button type="button" aria-pressed={dir === "in"} onClick={() => setValue("dir", "in")}>Eingang</button>
                </div>
                <div className="bk-row">
                    <Field id="bk-amount" label="Betrag" error={err.amount?.message}>
                        <div className="amount-wrap">
                            <input className="inp" inputMode="decimal" placeholder="0,00" autoComplete="off" autoFocus {...fieldProps("bk-amount", err.amount?.message)} {...register("amount")} />
                            <span className="cur">€</span>
                        </div>
                    </Field>
                    <Field id="bk-date" label="Datum" error={err.date?.message}>
                        <input className="inp" type="date" {...fieldProps("bk-date", err.date?.message)} {...register("date")} />
                    </Field>
                </div>
                <Field id="bk-name" label="Gegenseite" error={err.name?.message}>
                    <input className="inp" list="bk-names" placeholder="z. B. Wochenmarkt" autoComplete="off" {...fieldProps("bk-name", err.name?.message)} {...register("name")} />
                    <datalist id="bk-names">
                        {names.map((n) => <option key={n} value={n} />)}
                    </datalist>
                </Field>
                <Field id="bk-purpose" label="Verwendungszweck" error={err.purpose?.message}>
                    <input className="inp" placeholder="optional" autoComplete="off" {...fieldProps("bk-purpose", err.purpose?.message)} {...register("purpose")} />
                </Field>
                <Field id="bk-cat" label="Kategorie">
                    <Picker
                        items={catItems}
                        value={cat === undefined ? undefined : cat === null ? "none" : String(cat)}
                        onPick={(v) => setPicked({ id: v === "none" ? null : Number(v) })}
                        placeholder="Kategorie suchen …"
                        trigger={
                            <PickerButton {...fieldProps("bk-cat", undefined)} set={!!cat} icon={cat ? <CatTile idx={index} id={cat} size={12} className="ti-s" /> : <Ic icon={Tag} size={14} />}>
                                {cat ? categoryPath(index, cat) : cat === null ? "Ohne Kategorie" : "Kategorie wählen"}
                            </PickerButton>
                        }
                    />
                </Field>
                <label className="check-row">
                    <input type="checkbox" {...register("pending")} />
                    <span>Vorgemerkt (noch nicht gebucht)</span>
                </label>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Check}>
                        {editing ? "Speichern" : "Buchung erfassen"}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

const TxForm = z.object({
    dir: z.enum(["out", "in"]),
    amount: BookingForm.shape.amount,
    date: BookingForm.shape.date,
    name: z.string().max(140, "Höchstens 140 Zeichen."),
    purpose: BookingForm.shape.purpose,
});
type TxForm = z.infer<typeof TxForm>;

const TX_TOPICS: Topic[] = ["accounts", "transactions", "categories"];

/** Where the values a booking came with are from. */
const ORIGIN_OF = (tx: Transaction): string => (tx.fundingOfId !== null ? "Von MBM berechnet" : tx.source === "import" ? "Aus der Datei" : "Von der Bank");

/**
 * Changes a booking from the bank, an import or added by MBM. Amount and date count instead of the
 * ones it came with (booked only); counterparty and purpose are texts shown instead of its own,
 * an emptied field shows its own again. What it came with stays.
 */
function TxDialog({ tx }: { tx: Transaction }) {
    const action = useAction();
    const accounts = useAccounts().data ?? [];
    const original = tx.original ?? { amount: tx.amount, bookingDate: tx.bookingDate };
    const pending = tx.status === "pending";
    const form = useForm<TxForm>({
        resolver: zodResolver(TxForm),
        defaultValues: { dir: tx.amount < 0 ? "out" : "in", amount: centsToInput(Math.abs(tx.amount)), date: tx.bookingDate, name: shownParty(tx), purpose: shownPurpose(tx) },
    });
    const { register, handleSubmit, setValue, formState, control } = form;
    const dir = useWatch({ control, name: "dir" });
    const err = formState.errors;
    const title = shownParty(tx) || shownPurpose(tx) || "Umsatz";
    const account = accounts.find((a) => a.id === tx.accountId);

    const submit = handleSubmit(async (v) => {
        const cents = parseAmount(v.amount)!;
        const amount = v.dir === "out" ? -cents : cents;
        const values = !pending && (amount !== tx.amount || v.date !== tx.bookingDate);
        const texts = (
            [
                ["counterparty", v.name.trim(), shownParty(tx)],
                ["remittance", v.purpose.trim(), shownPurpose(tx)],
            ] as [TxEditField, string, string][]
        ).filter(([, typed, shown]) => typed !== shown);
        if (!values && texts.length === 0) return ui.close();
        const r = await action.run(
            async () => {
                if (values) await call(routes.updateTransaction, { params: { id: tx.id }, body: { amount, bookingDate: v.date } });
                // An emptied field goes back to the booking's own text
                for (const [field, typed] of texts) await call(routes.setTransactionEdit, { params: { id: tx.id, field }, body: { value: typed || null } });
                return true;
            },
            { topics: TX_TOPICS, ok: `Umsatz geändert · ${v.name.trim() || title} ${fmtSigned(values ? amount : tx.amount)}` },
        );
        if (r) ui.close();
    });
    const restore = async () => {
        const r = await action.run<Transaction>(() => call(routes.updateTransaction, { params: { id: tx.id }, body: { amount: original.amount, bookingDate: original.bookingDate } }), {
            topics: TX_TOPICS,
            ok: "Ursprüngliche Werte wiederhergestellt",
        });
        if (r) ui.close();
    };

    return (
        <Modal title="Umsatz ändern" onClose={() => ui.close()} narrow>
            <form className="form-grid" style={{ gap: 16 }} onSubmit={submit} noValidate>
                <p className="muted">
                    <b>{title}</b>
                    {account ? ` · ${account.name}` : ""}
                </p>
                <div className="seg" role="group" aria-label="Richtung" style={{ justifySelf: "start" }}>
                    <button type="button" aria-pressed={dir === "out"} disabled={pending} onClick={() => setValue("dir", "out")}>Ausgabe</button>
                    <button type="button" aria-pressed={dir === "in"} disabled={pending} onClick={() => setValue("dir", "in")}>Eingang</button>
                </div>
                <div className="bk-row">
                    <Field id="tx-amount" label="Betrag" error={err.amount?.message}>
                        <div className="amount-wrap">
                            <input className="inp" inputMode="decimal" placeholder="0,00" autoComplete="off" autoFocus={!pending} readOnly={pending} {...fieldProps("tx-amount", err.amount?.message)} {...register("amount")} />
                            <span className="cur">€</span>
                        </div>
                    </Field>
                    <Field id="tx-date" label="Datum" error={err.date?.message}>
                        <input className="inp" type="date" readOnly={pending} {...fieldProps("tx-date", err.date?.message)} {...register("date")} />
                    </Field>
                </div>
                <p className="muted small">
                    {pending ? (
                        "Datum und Betrag änderst du, sobald der Umsatz gebucht ist."
                    ) : (
                        <>
                            {ORIGIN_OF(tx)}: <span className="amt">{fmtSigned(original.amount)}</span> am {dateText(original.bookingDate)}.
                            {account && !isOffline(account) ? " Der Kontostand der Bank bleibt; eine Änderung verschiebt nur den Verlauf davor." : ""}
                        </>
                    )}
                </p>
                <Field id="tx-name" label="Gegenseite" error={err.name?.message}>
                    <input className="inp" placeholder={partyName(tx) || "leer"} autoComplete="off" autoFocus={pending} {...fieldProps("tx-name", err.name?.message)} {...register("name")} />
                </Field>
                <Field id="tx-purpose" label="Verwendungszweck" error={err.purpose?.message}>
                    <input className="inp" placeholder={tx.remittance || "leer"} autoComplete="off" {...fieldProps("tx-purpose", err.purpose?.message)} {...register("purpose")} />
                </Field>
                <p className="muted small">MBM zeigt Gegenseite und Zweck statt der Werte der Bank, ein leeres Feld zeigt wieder ihre.</p>
                <div className="actions">
                    {tx.original && (
                        <Button type="button" className="btn-ghost" icon={RotateCcw} busy={action.pending} onClick={() => void restore()}>
                            Ursprüngliche Werte
                        </Button>
                    )}
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Check}>
                        Speichern
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

export function ReconcileDialog({ accountId }: { accountId: number }) {
    const account = (useAccounts().data ?? []).find((a) => a.id === accountId);
    const [value, setValue] = useState("");
    const [date, setDate] = useState(todayIso());
    const [errors, setErrors] = useState<FieldErrors>({});
    const action = useAction();
    if (!account) return null;
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const counted = parseAmount(value);
        const next: FieldErrors = {
            "rec-amount": counted === null ? "Bitte den gezählten Bestand eingeben." : undefined,
            "rec-date": isValidIsoDate(date) ? undefined : "Bitte ein Datum wählen.",
        };
        setErrors(next);
        if (hasErrors(next)) return void focusFirstError(next);
        const r = await action.run(() => call(routes.reconcile, { params: { id: accountId }, body: { date, balance: counted! } }), {
            topics: ["accounts", "transactions"],
            ok: (res) => (res.difference === 0 ? "Der Bestand stimmt, keine Buchung nötig" : `Saldo abgeglichen · Differenz ${fmtSigned(res.difference)}`),
        });
        if (r) ui.close();
    };
    return (
        <Modal title="Saldo abgleichen" onClose={() => ui.close()} narrow>
            <form className="form-grid" style={{ gap: 16 }} onSubmit={submit} noValidate>
                <p className="muted">
                    Laut MBM liegen in „{account.name}“ <b className="amt">{fmt(account.balance)}</b>. Gib ein, was tatsächlich da ist. Die Differenz wird als Buchung „Saldo-Abgleich“ angelegt.
                </p>
                <div className="bk-row">
                    <Field id="rec-amount" label="Tatsächlicher Bestand" error={errors["rec-amount"]}>
                        <div className="amount-wrap">
                            <input className="inp" inputMode="decimal" placeholder="0,00" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} {...fieldProps("rec-amount", errors["rec-amount"])} />
                            <span className="cur">€</span>
                        </div>
                    </Field>
                    <Field id="rec-date" label="Gezählt am" error={errors["rec-date"]}>
                        <input className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} {...fieldProps("rec-date", errors["rec-date"])} />
                    </Field>
                </div>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Scale}>
                        Abgleichen
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
