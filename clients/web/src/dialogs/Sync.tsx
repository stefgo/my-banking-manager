import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { routes, type SyncRun } from "@mbm/shared";
import { call, errorText } from "../lib/api";
import { isActive, setSyncRuns, startSync, useSyncRuns } from "../lib/bank";
import { queryClient } from "../lib/queries";
import { ui } from "../lib/ui";
import { plural } from "../lib/format";
import { Modal, Button, Spinner } from "../components/common";
import { Ic } from "../components/icons";
import { Approval } from "../components/Approval";

/** A finished run with nothing to read beyond its toast. */
const quietlyDone = (r: SyncRun): boolean => r.status === "done" && r.newAccounts.length === 0 && r.missingAccounts.length === 0 && r.foreignCurrency === 0;
/** The approval at the bank has ended (PSD2): fetching again does not help, approving again does. */
const consentEnded = (r: SyncRun): boolean => r.status === "error" && (r.error === "consent_expired" || r.error === "consent_needed");

/**
 * The fetch runs of the signed-in user. Closing it does not stop them. It opens for an approval or
 * a running fetch; once those runs have ended well, the toasts report the result and it closes.
 */
export function SyncDialog() {
    const runs = (useSyncRuns().data ?? []).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const latest = new Map<number, SyncRun>();
    for (const r of runs) if (!latest.has(r.connectionId)) latest.set(r.connectionId, r);
    const shown = [...latest.values()];
    const anyActive = shown.some(isActive);

    // Runs seen active while the panel is open; a retry from the panel joins them
    const watched = useRef(new Set<string>());
    useEffect(() => {
        for (const r of shown) if (isActive(r)) watched.current.add(r.id);
        const ended = shown.filter((r) => watched.current.has(r.id));
        if (!anyActive && ended.length > 0 && ended.every(quietlyDone)) ui.close();
    });

    return (
        <Modal title="Abruf" onClose={() => ui.close()}>
            <div className="sync-list">
                {shown.length === 0 && <p className="muted">Noch kein Abruf in dieser Sitzung.</p>}
                {shown.map((r) => <RunRow key={r.id} run={r} />)}
            </div>
            <div className="actions">
                <button className="btn btn-ghost" onClick={() => ui.close()}>{anyActive ? "Im Hintergrund weiter" : "Schließen"}</button>
            </div>
        </Modal>
    );
}

function RunRow({ run }: { run: SyncRun }) {
    const [pin, setPin] = useState("");
    const update = (r: SyncRun) => setSyncRuns([r, ...(queryClient.getQueryData<SyncRun[]>(["sync"]) ?? []).filter((x) => x.id !== r.id)]);
    const retry = (pins?: Record<string, string>) => {
        const target = run.accountIds.length === 1 ? { accountId: run.accountIds[0] } : { connectionId: run.connectionId };
        void startSync(target, pins, run.ordersOnly);
    };
    const state =
        run.status === "done" ? (
            <span className="sync-state ok"><Ic icon={Check} size={14} />{run.ordersOnly ? "Aufträge abgerufen" : run.newTransactions ? plural(run.newTransactions, "neuer Umsatz", "neue Umsätze") : "keine neuen Umsätze"}</span>
        ) : run.status === "error" ? (
            <span className="sync-state bad"><Ic icon={AlertTriangle} size={14} />{run.error === "cancelled" ? "abgebrochen" : "fehlgeschlagen"}</span>
        ) : (
            <span className="sync-state"><Spinner size={14} />{run.status === "approval" ? "wartet auf Freigabe" : "läuft"}</span>
        );

    return (
        <section className="panel sync-run" aria-label={run.connectionName}>
            <div className="sync-head">
                <b>{run.connectionName}</b>
                {state}
            </div>
            {run.status === "approval" && run.challenge && (
                <Approval
                    challenge={run.challenge}
                    submitTan={async (tan) => {
                        try {
                            update(await call(routes.syncTan, { params: { id: run.id }, body: { tan } }));
                        } catch (err) {
                            ui.toast(errorText(err), "error");
                        }
                    }}
                    onCancel={() => void call(routes.cancelSync, { params: { id: run.id } }).catch((err) => ui.toast(errorText(err), "error"))}
                />
            )}
            {run.status === "error" && run.error === "pin_required" && (
                <form
                    className="approval-tan"
                    onSubmit={(e) => {
                        e.preventDefault();
                        retry({ [String(run.connectionId)]: pin });
                        setPin("");
                    }}
                >
                    <input className="inp" type="password" autoComplete="off" aria-label="PIN" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
                    <Button className="btn-primary" type="submit" disabled={!pin}>Abrufen</Button>
                </form>
            )}
            {run.status === "error" && run.error !== "pin_required" && run.error !== "cancelled" && run.message && <p className="muted small">{run.message}</p>}
            {consentEnded(run) ? (
                <Button className="btn-sm btn-primary" style={{ justifySelf: "start" }} onClick={() => ui.open({ kind: "psd2Setup", connectionId: run.connectionId, mode: "consent" })}>Freigabe erneuern</Button>
            ) : (
                run.status === "error" && run.error !== "pin_required" && <Button className="btn-sm" icon={RefreshCw} style={{ justifySelf: "start" }} onClick={() => retry()}>Erneut abrufen</Button>
            )}
            {run.status === "done" && run.ordersMessage && <p className="muted small">{run.ordersMessage}</p>}
            {run.foreignCurrency > 0 && <p className="muted small">{plural(run.foreignCurrency, "Umsatz", "Umsätze")} in einer anderen Währung als der des Kontos {run.foreignCurrency === 1 ? "hat" : "haben"} MBM nicht übernommen.</p>}
            {run.newAccounts.length > 0 && <p className="muted small">Neu bei der Bank: {run.newAccounts.join(", ")}. In den Einstellungen unter „Bankzugänge“ zeigt „Konten abrufen“ sie unter „Weitere Konten bei der Bank“; dort kannst du sie übernehmen oder ausblenden.</p>}
            {run.missingAccounts.length > 0 && <p className="muted small">{plural(run.missingAccounts.length, "Konto meldet", "Konten melden")} die Bank nicht mehr. Gelöscht wird nichts.</p>}
        </section>
    );
}
