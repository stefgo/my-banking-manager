import { useEffect } from "react";
import { ServerEvent, type ClientEvent, type Me } from "@mbm/shared";
import { invalidate, queryClient } from "./queries";
import { receiveSyncRuns } from "./bank";

/** Close codes of the server (see server/src/http/events.ts). */
const CLOSE_SIGNED_OUT = 4401;
const CLOSE_SESSION_LOCKED = 4403;
const CLOSE_LOCKED = 4423;

let current: WebSocket | null = null;

/** Sends a message to the server; false when no connection is open right now. */
export function sendToServer(event: ClientEvent): boolean {
    if (current?.readyState !== WebSocket.OPEN) return false;
    current.send(JSON.stringify(event));
    return true;
}

/** Shows the password prompt at once; the server locks the session as well. */
export function markSessionLocked(): void {
    queryClient.setQueryData<Me | null>(["me"], (me) => (me ? { ...me, sessionLocked: true } : me));
}

/** Listens to the server's events while signed in; reconnects with growing pauses. */
export function useServerEvents(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return;
        let ws: WebSocket | null = null;
        let stopped = false;
        let delay = 1000;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const signedOutOrLocked = () => {
            void queryClient.invalidateQueries({ queryKey: ["status"] });
            void queryClient.invalidateQueries({ queryKey: ["me"] });
        };

        const connect = () => {
            const proto = location.protocol === "https:" ? "wss:" : "ws:";
            ws = new WebSocket(`${proto}//${location.host}/api/events`);
            current = ws;
            ws.onopen = () => {
                delay = 1000;
            };
            ws.onmessage = (e) => {
                const parsed = ServerEvent.safeParse(JSON.parse(String(e.data)));
                if (!parsed.success) return;
                const ev = parsed.data;
                if (ev.type === "changed") invalidate(...ev.topics);
                else if (ev.type === "sync") receiveSyncRuns(ev.runs);
                else if (ev.type === "profile") void queryClient.invalidateQueries({ queryKey: ["profile"] });
                else if (ev.type === "session_locked") {
                    stopped = true;
                    markSessionLocked();
                } else if (ev.type === "locked" || ev.type === "signed_out") {
                    stopped = true;
                    signedOutOrLocked();
                }
            };
            ws.onclose = (e) => {
                if (current === ws) current = null;
                if (stopped) return;
                if (e.code === CLOSE_SESSION_LOCKED) return markSessionLocked();
                if (e.code === CLOSE_SIGNED_OUT || e.code === CLOSE_LOCKED) return signedOutOrLocked();
                timer = setTimeout(connect, delay);
                delay = Math.min(delay * 2, 30_000);
            };
        };
        connect();
        return () => {
            stopped = true;
            clearTimeout(timer);
            if (current === ws) current = null;
            ws?.close();
        };
    }, [enabled]);
}
