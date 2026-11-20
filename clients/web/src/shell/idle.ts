// Locks the session after the configured time without input.
//
// Input in any tab of this browser counts (shared over a BroadcastChannel, which keeps nothing).
// The server learns about it at most once a minute over the WebSocket and decides on its own as
// well; the countdown here only makes the password prompt appear on time.

import { useEffect } from "react";
import { routes } from "@mbm/shared";
import { call } from "../lib/api";
import { markSessionLocked, sendToServer } from "../lib/socket";

const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "scroll"] as const;
const REPORT_EVERY_MS = 60_000;
const SHARE_EVERY_MS = 5_000;
const CHECK_EVERY_MS = 5_000;

export function useIdleLock(idleMinutes: number): void {
    useEffect(() => {
        if (idleMinutes <= 0) return;
        const idleMs = idleMinutes * 60_000;
        let lastInput = Date.now();
        let lastReport = 0;
        let lastShare = 0;
        let locked = false;
        const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("mbm-activity");

        const report = (now: number) => {
            if (now - lastReport >= REPORT_EVERY_MS && sendToServer({ type: "active" })) lastReport = now;
        };

        const onInput = () => {
            const now = Date.now();
            lastInput = now;
            report(now);
            if (channel && now - lastShare >= SHARE_EVERY_MS) {
                channel.postMessage(now);
                lastShare = now;
            }
        };

        const onShared = (e: MessageEvent) => {
            if (typeof e.data === "number" && e.data > lastInput) lastInput = e.data;
        };

        const check = () => {
            if (locked || Date.now() - lastInput < idleMs) return;
            locked = true;
            markSessionLocked();
            void call(routes.lockSession).catch(() => undefined);
        };

        for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, { capture: true, passive: true });
        channel?.addEventListener("message", onShared);
        // Timers in background tabs run late; checking on return catches up at once
        document.addEventListener("visibilitychange", check);
        const timer = setInterval(check, CHECK_EVERY_MS);
        return () => {
            for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, { capture: true });
            channel?.close();
            document.removeEventListener("visibilitychange", check);
            clearInterval(timer);
        };
    }, [idleMinutes]);
}
