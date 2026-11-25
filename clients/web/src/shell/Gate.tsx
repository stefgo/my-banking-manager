import { useEffect, useState } from "react";
import { onAuthProblem } from "../lib/api";
import { queryClient, useMe, useStatus } from "../lib/queries";
import { LoginScreen, SetupScreen } from "../screens/Access";
import { markSessionLocked } from "../lib/socket";
import { Mark } from "../components/icons";
import { Toasts } from "../components/common";
import { isOutdated, nothingTyped, OWN_BUILD } from "../lib/build";
import { applyTheme } from "../lib/theme";
import { Shell } from "./Shell";

/** Decides what to show: set-up, sign-in (also into a locked server or session) or the app. */
export function Gate() {
    const status = useStatus();
    const ready = status.data?.state === "ready";
    const me = useMe(ready);

    useEffect(
        () =>
            onAuthProblem((code) => {
                if (code === "signed_out") {
                    queryClient.setQueryData(["me"], null);
                } else if (code === "session_locked") {
                    markSessionLocked();
                } else {
                    void queryClient.invalidateQueries({ queryKey: ["status"] });
                }
            }),
        [],
    );

    // Before sign-in the start value of the server's configuration styles the page; a signed-in
    // window (also a locked one) keeps the appearance of its profile
    const webTheme = status.data?.webTheme;
    const signedOut = !me.data;
    useEffect(() => {
        if (webTheme && signedOut) applyTheme(webTheme);
    }, [webTheme, signedOut]);

    // Leaving the app (or a locked session) forgets every bank figure held in memory
    const sessionLocked = me.data?.sessionLocked === true;
    useEffect(() => {
        if (!ready || me.data === null || sessionLocked) {
            queryClient.removeQueries({ predicate: (q) => !["status", "me"].includes(String(q.queryKey[0])) });
            document.documentElement.classList.remove("private");
        }
    }, [ready, me.data, sessionLocked]);

    // A new web client on the server: before sign-in a reload loses nothing; in the app (and in a
    // locked session, which keeps its user only in memory) a notice offers it
    const webBuild = status.data?.webBuild;
    const outdated = isOutdated(OWN_BUILD, webBuild);
    const state = status.data?.state;
    const nobody = state === "setup" || (state === "locked" && !me.data) || (state === "ready" && me.data === null);
    useEffect(() => {
        if (outdated && nobody && nothingTyped()) location.reload();
    }, [outdated, nobody]);
    const [closedFor, setClosedFor] = useState<string | null>(null);
    const update = outdated && webBuild !== closedFor ? { onClose: () => setClosedFor(webBuild ?? null) } : undefined;

    return (
        <>
            <Screen status={status} me={me} />
            <Toasts update={update} />
        </>
    );
}

function Screen({ status, me }: { status: ReturnType<typeof useStatus>; me: ReturnType<typeof useMe> }) {
    if (status.isPending) return <Loading />;
    if (status.isError || !status.data) {
        return (
            <div className="center-screen">
                <div className="lock-card">
                    <span className="mark mark-lg"><Mark size={30} /></span>
                    <h2>Server nicht erreichbar</h2>
                    <p className="muted">MBM antwortet gerade nicht. Läuft der Server?</p>
                    <button className="btn btn-primary" onClick={() => void status.refetch()}>Erneut versuchen</button>
                </div>
            </div>
        );
    }
    const s = status.data;
    if (s.state === "setup") return <SetupScreen />;
    // A window that was signed in before the server locked still knows its user (in memory only)
    if (s.state === "locked") return <LoginScreen lockedAs={me.data ?? undefined} serverLocked />;
    if (me.isPending) return <Loading />;
    if (!me.data) return <LoginScreen />;
    if (me.data.sessionLocked) return <LoginScreen lockedAs={me.data} />;
    return <Shell me={me.data} />;
}

function Loading() {
    return <div className="center-screen" aria-busy="true" />;
}
