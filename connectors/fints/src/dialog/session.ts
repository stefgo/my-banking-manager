// The steps around a dialog: find out the user's TAN methods, open a dialog (with
// synchronisation on first use).

import { hkidn, hkvvb } from "../segments/dialog.js";
import { updVersionToAnnounce } from "../segments/upd.js";
import { hksyn, parseTanMethods, type TanMethod } from "../segments/tan.js";
import { Dialog, type DialogOptions, type ScaResult } from "./dialog.js";
import { FintsBankError, FintsSetupError, PIN_ERROR_CODES, throwIfErrors } from "./errors.js";

/**
 * Dialog with security function 999 (PIN/TAN B.4.3.1): the bank answers with its parameters,
 * the user's allowed methods (3920) and, with HKSYN, a Kundensystem-ID. Such a dialog may not
 * carry any other job; the bank may even reject it (9800) and still name the methods.
 */
export async function discoverTanMethods(o: DialogOptions): Promise<TanMethod[]> {
    const d = new Dialog(o, "999");
    const c = o.credentials;
    try {
        const segments = [hkidn(c.blz, c.customerId || c.userId, o.state.systemId, true), hkvvb(o.state.bpd?.version ?? 0, updVersionToAnnounce(o.state.upd), o.product)];
        if (o.state.systemId === "0") segments.push(hksyn());
        const { message } = await d.exchange(segments);
        const errors = message.errors;
        if (errors.some((e) => PIN_ERROR_CODES.includes(e.code)) || !message.hasCode("3920")) throwIfErrors(errors);
    } finally {
        await d.end();
    }
    if (!o.state.bpd) throw new FintsSetupError("no_bpd", "The bank sent no bank parameters");
    const allowed = new Set(o.state.allowedFunctions);
    return parseTanMethods(o.state.bpd).filter((m) => allowed.has(m.securityFunction));
}

/**
 * Opens a dialog with the chosen method. Without a Kundensystem-ID it synchronises first; such
 * a dialog is ended and a fresh one opened with the new ID.
 */
export async function openDialog(o: DialogOptions, scaFor = "HKIDN"): Promise<{ dialog: Dialog; result: ScaResult }> {
    const f = o.state.securityFunction;
    if (f === "999" && !o.state.allowedFunctions.includes("999")) {
        throw new FintsSetupError("no_tan_method", "No TAN method chosen");
    }
    if (o.state.systemId === "0") {
        const sync = new Dialog(o, f);
        const result = await sync.init({ sync: true, scaFor });
        if (result.kind === "challenge") return { dialog: sync, result };
        await sync.end();
        if (o.state.systemId === "0") throw new FintsBankError([{ code: "9999", ref: "", text: "Die Bank hat keine Kundensystem-ID vergeben.", params: [] }]);
    }
    const dialog = new Dialog(o, f);
    return { dialog, result: await dialog.init({ scaFor }) };
}
