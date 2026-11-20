// Ending work: sign this device out, or lock the whole server for every user and device.

import { routes } from "@mbm/shared";
import { ApiFailure, call, errorText } from "../lib/api";
import { queryClient } from "../lib/queries";
import { ui } from "../lib/ui";

export function signOut(): void {
    ui.confirm({
        title: "Abmelden?",
        text: "Dieses Gerät wird abgemeldet. Beim nächsten Anmelden brauchst du Passwort und Code. Andere Geräte bleiben angemeldet.",
        confirm: "Abmelden",
        onConfirm: async () => {
            // Signed out either way: a failed request leaves at most a session the server ends later
            await call(routes.logout).catch(() => undefined);
            queryClient.setQueryData(["me"], null);
        },
    });
}

export function lockServer(): void {
    ui.confirm({
        title: "MBM für alle sperren?",
        text: "Der Server schließt die Datenbank. Alle angemeldeten Benutzer und Geräte sind gesperrt, bis sich jemand mit seinem Passwort anmeldet.",
        confirm: "Für alle sperren",
        onConfirm: async () => {
            // Refused while a transfer runs: say why. Any other failure leaves nothing to show,
            // the server is locked or gone either way.
            await call(routes.lock).catch((err) => {
                if (err instanceof ApiFailure && err.code === "transfer_running") ui.toast(errorText(err), "error");
            });
        },
    });
}
