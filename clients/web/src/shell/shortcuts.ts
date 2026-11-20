import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getUi, ui } from "../lib/ui";
import { queryClient } from "../lib/queries";
import type { Account } from "@mbm/shared";
import { GO_KEYS, type GoLetter } from "../lib/keys";
import { inspectorMode } from "../lib/media";
import { useTxHome } from "../lib/useTxHome";
import { lockServer } from "./session";
import { toggleSidebar } from "./sidebarToggle";

/** True while the user types into a field; single-key shortcuts stay quiet then. */
export function isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/** Is something open that owns the keyboard (dialog, drawer, menu)? */
export const overlayOpen = (): boolean =>
    !!getUi().dialog || !!document.querySelector("[role=menu], .pop-content, .modal-wrap");

export function openBooking(accountId?: number): void {
    const accounts = queryClient.getQueryData<Account[]>(["accounts"]) ?? [];
    if (!accounts.some((a) => a.kind === "offline")) {
        ui.toast("Lege zuerst ein Offline-Konto an.", "info");
        ui.open({ kind: "addAccount" });
        return;
    }
    ui.open({ kind: "booking", accountId });
}

/** Global keys: ⌘K, ⌘B, /, ?, H, L, B, N and G followed by a letter of `GO_KEYS`. The list for display is `KEYS`. */
export function useShortcuts(): void {
    const navigate = useNavigate();
    // "G U" returns to the last view shown, like "Umsätze" in the navigation
    const home = useTxHome();
    const homeRef = useRef(home);
    useEffect(() => {
        homeRef.current = home;
    }, [home]);
    useEffect(() => {
        let gPending = 0;
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                ui.open({ kind: "palette" });
                return;
            }
            // Also while typing (⌘B has no meaning in plain fields), but not over a dialog
            if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
                if (overlayOpen()) return;
                e.preventDefault();
                toggleSidebar();
                return;
            }
            // The booking details as an overlay own the keyboard; as a panel beside the list they do not
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || overlayOpen() || (getUi().drawerTx !== null && !inspectorMode())) return;
            const k = e.key.toLowerCase();
            if (Date.now() - gPending < 1200) {
                gPending = 0;
                const target: { to: string; search?: Record<string, unknown> } | undefined = k in GO_KEYS ? GO_KEYS[k as GoLetter] : undefined;
                if (target) {
                    e.preventDefault();
                    void navigate({ to: target.to, search: target.to === "/transactions" ? homeRef.current : (target.search ?? {}) });
                }
                return;
            }
            switch (e.key) {
                case "g":
                case "G":
                    gPending = Date.now();
                    break;
                case "/":
                    e.preventDefault();
                    // Searching needs the list: from the hint to pick a view it searches all accounts
                    void navigate({ to: "/transactions", search: (s) => ({ ...s, view: undefined }) }).then(() => setTimeout(() => document.getElementById("q")?.focus(), 30));
                    break;
                case "?":
                    ui.open({ kind: "help" });
                    break;
                case "h":
                case "H":
                    ui.togglePrivacy();
                    break;
                case "l":
                case "L":
                    lockServer();
                    break;
                case "b":
                case "B":
                    e.preventDefault();
                    openBooking();
                    break;
                case "n":
                case "N":
                    ui.newTransfer();
                    void navigate({ to: "/transfer" });
                    break;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [navigate]);
}
