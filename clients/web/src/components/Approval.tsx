import { useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";
import type { ConnectorChallenge } from "@mbm/shared";
import { Button, Spinner } from "./common";
import { Ic } from "./icons";

/**
 * What the bank asks for: an approval in the app (the caller's `poll` is asked every two
 * seconds) or a TAN. The bank's text is shown unchanged.
 */
export function Approval({
    challenge,
    poll,
    submitTan,
    onCancel,
}: {
    challenge: ConnectorChallenge;
    /** Decoupled: asks once whether the approval is there; resolves true when done. */
    poll?: () => Promise<boolean>;
    submitTan?: (tan: string) => Promise<void>;
    onCancel: () => void;
}) {
    const [tan, setTan] = useState("");
    const [busy, setBusy] = useState(false);
    const pollRef = useRef(poll);
    useEffect(() => {
        pollRef.current = poll;
    });

    useEffect(() => {
        if (!challenge.decoupled || !pollRef.current) return;
        let stop = false;
        const tick = async () => {
            while (!stop) {
                await new Promise((r) => setTimeout(r, 2000));
                if (stop) return;
                try {
                    if (await pollRef.current?.()) return;
                } catch {
                    return;
                }
            }
        };
        void tick();
        return () => {
            stop = true;
        };
    }, [challenge.decoupled]);

    return (
        <div className="approval" role="status" aria-live="polite">
            <span className="acc-ic"><Ic icon={Smartphone} size={18} /></span>
            <div className="approval-main">
                <b>{challenge.decoupled ? `Bitte in der App freigeben${challenge.methodName ? ` (${challenge.methodName})` : ""}` : "TAN eingeben"}</b>
                {challenge.text && <p className="muted small approval-text">{challenge.text}</p>}
                {challenge.medium && <small className="faint">Gerät: {challenge.medium}</small>}
                {challenge.decoupled ? (
                    <span className="approval-wait">
                        <Spinner size={14} /> Warte auf die Freigabe …
                    </span>
                ) : (
                    <form
                        className="approval-tan"
                        onSubmit={async (e) => {
                            e.preventDefault();
                            if (!tan.trim() || !submitTan) return;
                            setBusy(true);
                            try {
                                await submitTan(tan.trim());
                            } finally {
                                setBusy(false);
                                setTan("");
                            }
                        }}
                    >
                        <input className="inp" inputMode="numeric" autoComplete="one-time-code" aria-label="TAN" placeholder="TAN" value={tan} onChange={(e) => setTan(e.target.value)} autoFocus />
                        <Button className="btn-primary" type="submit" busy={busy} disabled={!tan.trim()}>
                            Senden
                        </Button>
                    </form>
                )}
            </div>
            <button className="btn btn-sm" type="button" onClick={onCancel}>
                Abbrechen
            </button>
        </div>
    );
}
