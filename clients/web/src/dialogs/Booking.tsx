import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Scale, Tag } from "lucide-react";
import { centsToInput, isValidIsoDate, parseAmount, routes, todayIso, type Transaction } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction, useCategoryIndex, usePayees, useTxById } from "../lib/queries";
import { categoryPath } from "../lib/tree";
import { fmt, fmtSigned } from "../lib/format";
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

export function BookingDialog({ accountId, txId }: { accountId?: number; txId?: number }) {
    const accountsData = useAccounts().data;
    const accounts = accountsData ?? [];
    const offline = useMemo(() => (accountsData ?? []).filter((a) => a.kind === "offline"), [accountsData]);
    const accountItems = useMemo(() => accountPickItems(offline), [offline]);
    const { index } = useCategoryIndex();
    const payees = usePayees().data;
    const catItems = useCategoryItems({ none: true });
    const action = useAction();
    const editTx = useTxById(txId);
    // The category picked here; until then the one of the booking being edited (undefined: rules decide)
    const [picked, setPicked] = useState<{ id: number | null } | null>(null);
    const cat: number | null | undefined = picked ? picked.id : editTx?.categoryId;
    const editing = txId !== undefined;

    const startAccount = accountId && offline.some((a) => a.id === accountId) ? accountId : offline[0]?.id;
    const form = useForm<BookingForm>({
        resolver: zodResolver(BookingForm),
        defaultValues: { accountId: String(startAccount ?? ""), dir: "out", amount: "", date: todayIso(), name: "", purpose: "", pending: false },
    });
    const { register, handleSubmit, setValue, reset, formState, control } = form;
    register("accountId");
    const dir = useWatch({ control, name: "dir" });
    const accountValue = useWatch({ control, name: "accountId" });
    const account = offline.find((a) => String(a.id) === accountValue);

    // Fill the form once the booking to edit has arrived
    useEffect(() => {
        if (!editTx) return;
        reset({
            accountId: String(editTx.accountId),
            dir: editTx.amount < 0 ? "out" : "in",
            amount: centsToInput(Math.abs(editTx.amount)),
            date: editTx.bookingDate,
            name: editTx.counterpartyName,
            purpose: editTx.remittance,
            pending: editTx.status === "pending",
        });
    }, [editTx, reset]);

    const names = useMemo(() => (payees ?? []).map((p) => p.name).slice(0, 60), [payees]);

    const submit = handleSubmit(async (v) => {
        const cents = parseAmount(v.amount)!;
        const amount = v.dir === "out" ? -cents : cents;
        const body = {
            bookingDate: v.date,
            amount,
            counterpartyName: v.name.trim(),
            remittance: v.purpose.trim(),
            status: v.pending ? ("pending" as const) : ("booked" as const),
            ...(cat !== undefined ? { categoryId: cat } : {}),
        };
        const name = accounts.find((a) => a.id === Number(v.accountId))?.name ?? "";
        const r = await action.run<Transaction>(
            () => (editing ? call(routes.updateTransaction, { params: { id: txId! }, body }) : call(routes.createTransaction, { params: { id: Number(v.accountId) }, body })),
            { topics: ["accounts", "transactions", "categories"], ok: `${editing ? "Buchung geändert" : "Buchung erfasst"} · ${name} ${fmtSigned(amount)}` },
        );
        if (r) ui.close();
    });

    const err = formState.errors;
    const catHint = cat === undefined && !editing ? "Ohne Auswahl vergeben die Regeln die Kategorie." : undefined;

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
                <Field id="bk-cat" label="Kategorie" hint={catHint}>
                    <Picker
                        items={catItems}
                        value={cat === undefined ? undefined : cat === null ? "none" : String(cat)}
                        onPick={(v) => setPicked({ id: v === "none" ? null : Number(v) })}
                        placeholder="Kategorie suchen …"
                        trigger={
                            <PickerButton {...fieldProps("bk-cat", undefined, !!catHint)} set={!!cat} icon={cat ? <CatTile idx={index} id={cat} size={12} className="ti-s" /> : <Ic icon={Tag} size={14} />}>
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
