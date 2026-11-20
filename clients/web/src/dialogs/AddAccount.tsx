import { useMemo, useState } from "react";
import { Check, ChevronRight, Folder, Info, Landmark } from "lucide-react";
import { centsToInput, parseAmount, routes, type Account } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction } from "../lib/queries";
import { fieldProps, focusFirstError, hasErrors, type FieldErrors } from "../lib/fields";
import { ui } from "../lib/ui";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { Modal, Button } from "../components/common";
import { Field } from "../components/form";
import { Picker, PickerButton } from "../components/pickers";
import { Ic, Sym } from "../components/icons";
import { useScopeItems } from "../components/pickItems";

export function AddAccountDialog({ offline = false }: { offline?: boolean }) {
    const [type, setType] = useState<"offline" | null>(offline ? "offline" : null);
    const [name, setName] = useState("");
    const [opening, setOpening] = useState("");
    const [group, setGroup] = useState("");
    const [errors, setErrors] = useState<FieldErrors>({});
    const scopeItems = useScopeItems(false);
    const groups = useMemo(() => scopeItems.filter((x) => x.value.startsWith("group:")), [scopeItems]);
    const groupItems = useMemo(() => [{ value: "top", label: "Oberste Ebene", top: true }, ...groups], [groups]);
    const action = useAction();
    const open = useOpenTransactions();

    if (!type) {
        return (
            <Modal title="Konto hinzufügen" onClose={() => ui.close()}>
                <p className="muted">Welche Art von Konto möchtest du hinzufügen?</p>
                <div className="kind-list">
                    <button className="bank-item" onClick={() => ui.open({ kind: "bankSetup" })}>
                        <span className="acc-ic"><Ic icon={Landmark} size={16} /></span>
                        <span>
                            <b>Bank (FinTS)</b>
                            <small>Sparkassen und andere Banken mit FinTS: Salden und Umsätze ruft MBM bei der Bank ab</small>
                        </span>
                        <Ic icon={ChevronRight} size={16} />
                    </button>
                    <button className="bank-item" onClick={() => setType("offline")} autoFocus>
                        <span className="acc-ic"><Sym name="banknote" size={16} /></span>
                        <span>
                            <b>Offline-Konto</b>
                            <small>Bargeld, Sparbuch, Depot … Buchungen erfasst du selbst oder importierst sie</small>
                        </span>
                        <Ic icon={ChevronRight} size={16} />
                    </button>
                </div>
            </Modal>
        );
    }

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const cents = opening.trim() ? parseAmount(opening) : 0;
        const next: FieldErrors = {
            "wz-name": name.trim() ? undefined : "Bitte einen Namen eingeben.",
            "wz-bal": cents === null ? "Der Anfangssaldo ist kein Betrag." : undefined,
        };
        setErrors(next);
        if (hasErrors(next)) return void focusFirstError(next);
        const acc = await action.run<Account>(
            () =>
                call(routes.createOfflineAccount, {
                    body: { name: name.trim(), openingBalance: cents!, groupId: group ? Number(group.slice(6)) : null },
                }),
            { topics: ["accounts"], ok: (a) => `Offline-Konto „${a.name}“ angelegt` },
        );
        if (acc) {
            ui.close();
            void open({ kind: "show", search: { scope: `account:${acc.id}` } });
        }
    };

    const groupItem = groups.find((g) => g.value === group);

    return (
        <Modal title="Offline-Konto anlegen" onClose={() => ui.close()}>
            <form className="form-grid" style={{ maxWidth: "none", gap: 16 }} onSubmit={submit} noValidate>
                <Field id="wz-name" label="Name" error={errors["wz-name"]}>
                    <input className="inp" placeholder="z. B. Bargeld, Sparbuch, Depot" autoComplete="off" autoFocus value={name} onChange={(e) => setName(e.target.value)} {...fieldProps("wz-name", errors["wz-name"])} />
                </Field>
                <Field id="wz-bal" label="Anfangssaldo" error={errors["wz-bal"]} hint="Kontostand vor der ersten Buchung. Jede Buchung, auch eine importierte, ändert den Kontostand.">
                    <div className="amount-wrap">
                        <input className="inp" inputMode="decimal" placeholder="0,00" autoComplete="off" value={opening} onChange={(e) => setOpening(e.target.value)} {...fieldProps("wz-bal", errors["wz-bal"], true)} />
                        <span className="cur">€</span>
                    </div>
                </Field>
                <Field id="wz-group" label="Gruppe">
                    <Picker
                        items={groupItems}
                        value={group || "top"}
                        onPick={(v) => setGroup(v === "top" ? "" : v)}
                        placeholder="Gruppe suchen …"
                        trigger={
                            <PickerButton id="wz-group" set={!!groupItem} icon={groupItem?.icon ?? <Ic icon={Folder} size={14} />}>
                                {groupItem ? groupItem.label : "Oberste Ebene"}
                            </PickerButton>
                        }
                    />
                </Field>
                <p className="hint"><Ic icon={Info} size={14} />Symbol und Farbe änderst du danach über das Symbol im Kopfbereich.</p>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => setType(null)}>Zurück</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Check}>
                        Offline-Konto anlegen
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

/** Changes the balance an offline account starts from, before its first booking. */
export function OpeningBalanceDialog({ accountId }: { accountId: number }) {
    const account = (useAccounts().data ?? []).find((a) => a.id === accountId);
    const [value, setValue] = useState(() => centsToInput(account?.openingBalance ?? 0));
    const [error, setError] = useState<string | undefined>();
    const action = useAction();
    if (!account) return null;
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const cents = value.trim() ? parseAmount(value) : 0;
        if (cents === null) {
            const problem = "Der Anfangssaldo ist kein Betrag.";
            setError(problem);
            focusFirstError({ "ob-amount": problem });
            return;
        }
        setError(undefined);
        const r = await action.run(() => call(routes.updateAccount, { params: { id: accountId }, body: { openingBalance: cents } }), {
            topics: ["accounts", "transactions"],
            ok: "Anfangssaldo geändert",
        });
        if (r) ui.close();
    };
    return (
        <Modal title="Anfangssaldo ändern" onClose={() => ui.close()} narrow>
            <form className="form-grid" style={{ gap: 16 }} onSubmit={submit} noValidate>
                <p className="muted">Kontostand von „{account.name}“ vor der ersten Buchung. Alle Buchungen werden darauf gerechnet.</p>
                <Field id="ob-amount" label="Anfangssaldo" error={error}>
                    <div className="amount-wrap">
                        <input className="inp" inputMode="decimal" placeholder="0,00" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} {...fieldProps("ob-amount", error)} />
                        <span className="cur">€</span>
                    </div>
                </Field>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Abbrechen</button>
                    <Button className="btn-primary" type="submit" busy={action.pending} icon={Check}>
                        Speichern
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
