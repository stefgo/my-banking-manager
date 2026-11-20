import { useState } from "react";
import { Check, Unlink } from "lucide-react";
import { routes } from "@mbm/shared";
import { call } from "../lib/api";
import { useAccounts, useAction } from "../lib/queries";
import { ui } from "../lib/ui";
import { plural } from "../lib/format";
import { Modal, Button } from "../components/common";
import { Ic } from "../components/icons";

/** Detaches a bank account from its bank access: keep it as an offline account, or delete it. */
export function DetachAccountDialog({ accountId }: { accountId: number }) {
    const account = (useAccounts().data ?? []).find((a) => a.id === accountId);
    const [mode, setMode] = useState<"keep" | "delete">("keep");
    const action = useAction();
    if (!account) return null;
    const n = account.transactionCount;
    const bookings = plural(n, "Buchung", "Buchungen");
    const choices = [
        { value: "keep" as const, title: "Als Offline-Konto behalten", text: `${n ? `Die ${bookings} und der letzte Kontostand bleiben` : "Der letzte Kontostand bleibt"}. Neue Buchungen erfasst du selbst.` },
        { value: "delete" as const, title: "Mit Buchungen löschen", text: `Das Konto${n ? ` und ${n === 1 ? "seine" : "die"} ${bookings}` : ""} ${n ? "werden" : "wird"} gelöscht. Das lässt sich nicht rückgängig machen.` },
    ];
    const submit = async () => {
        const ok = await action.succeeds(() => call(routes.detachAccount, { params: { id: accountId }, body: { mode } }), {
            topics: ["accounts", "connections", "transactions", "categories"],
            ok: mode === "keep" ? "Konto vom Bankzugang gelöst" : "Konto gelöscht",
        });
        if (ok) ui.close();
    };
    return (
        <Modal title={`„${account.name}“ vom Bankzugang lösen`} onClose={() => ui.close()} narrow>
            <div className="form-grid" style={{ maxWidth: "none", gap: 16 }}>
                <p className="muted">
                    MBM ruft das Konto danach nicht mehr ab. Die Bank meldet es weiter; unter „Konten verwalten“ kannst du es später wieder übernehmen, dann als neues
                    Konto.
                </p>
                <div className="kind-list" role="radiogroup" aria-label="Was mit dem Konto geschieht">
                    {choices.map((c) => (
                        <button key={c.value} type="button" role="radio" aria-checked={mode === c.value} className={`bank-item ${mode === c.value ? "on" : ""}`} onClick={() => setMode(c.value)}>
                            <span className="acc-ic">{mode === c.value ? <Ic icon={Check} size={16} /> : null}</span>
                            <span>
                                <b>{c.title}</b>
                                <small>{c.text}</small>
                            </span>
                        </button>
                    ))}
                </div>
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Abbrechen</button>
                    <Button className={mode === "delete" ? "btn-danger" : "btn-primary"} icon={Unlink} busy={action.pending} onClick={() => void submit()}>
                        {mode === "keep" ? "Lösen" : "Lösen und löschen"}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
