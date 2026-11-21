import { useEffect, useRef } from "react";
import { useBlocker } from "@tanstack/react-router";
import { ui } from "./ui";

/**
 * Asks before leaving the page while `active`. `release()` lets the next navigation through, for
 * a page that moves on by itself after saving.
 */
export function useLeaveGuard(active: boolean, title: string, text: string): { release: () => void } {
    const activeRef = useRef(active);
    const released = useRef(false);
    useEffect(() => {
        activeRef.current = active;
        if (active) released.current = false;
    }, [active]);
    useBlocker({
        shouldBlockFn: () => {
            if (!activeRef.current || released.current) return false;
            return new Promise<boolean>((resolve) => {
                ui.confirm({ title, text, confirm: "Verlassen", danger: true, onConfirm: () => resolve(false), onCancel: () => resolve(true) });
            });
        },
        enableBeforeUnload: () => activeRef.current && !released.current,
    });
    return {
        release: () => {
            released.current = true;
        },
    };
}
