import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { routes } from "@mbm/shared";
import { call, errorText } from "../lib/api";
import { afterConsent, readRedirect, redirectErrorText } from "../lib/psd2";
import { Button, Hint, Spinner } from "../components/common";

/**
 * Where the bank sends the browser back after a PSD2 approval. Takes code and state from the
 * address, removes them from it at once (they never reach the history or browser storage), and
 * finishes the approval; then on to the bank accesses.
 */
export function BankCallbackPage() {
    const navigate = useNavigate();
    // Read before the effect removes code and state from the address
    const [result] = useState(() => readRedirect(new URLSearchParams(window.location.search)));
    const [error, setError] = useState<string | null>(() =>
        result.kind === "invalid"
            ? "Diese Adresse gehört zu keiner Freigabe. Starte die Freigabe in den Einstellungen unter „Bankzugänge“ noch einmal."
            : result.kind === "error"
              ? redirectErrorText(result.error, result.description)
              : null,
    );
    // The redirect is used once: a second request with the same code would only fail
    const started = useRef(false);

    useEffect(() => {
        window.history.replaceState(null, "", window.location.pathname);
        if (started.current || result.kind !== "code") return;
        started.current = true;
        void (async () => {
            try {
                const c = await call(routes.completeConsent, { body: { state: result.state, code: result.code } });
                await navigate({ to: "/settings", search: { tab: "accounts" }, replace: true });
                afterConsent(c);
            } catch (err) {
                setError(errorText(err));
            }
        })();
    }, [navigate, result]);

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Freigabe bei der Bank</h1>
                </div>
            </div>
            <section className="panel" style={{ display: "grid", gap: 16 }}>
                {error ? (
                    <>
                        <Hint tone="bad">{error}</Hint>
                        <div className="actions" style={{ justifyContent: "flex-start" }}>
                            <Button className="btn-primary" onClick={() => void navigate({ to: "/settings", search: { tab: "accounts" }, replace: true })}>Zu den Bankzugängen</Button>
                        </div>
                    </>
                ) : (
                    <p className="muted" style={{ display: "flex", gap: 10, alignItems: "center" }}><Spinner size={16} />Die Freigabe wird abgeschlossen …</p>
                )}
            </section>
        </>
    );
}
