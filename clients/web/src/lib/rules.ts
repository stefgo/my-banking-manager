// Applying rules to existing bookings always goes through a preview the user confirms.

import { routes } from "@mbm/shared";
import { call, errorText } from "./api";
import { ui } from "./ui";

/**
 * Loads what the rules would categorize and opens the confirmation dialog. With `ruleId` only
 * that rule counts; `created` tells the dialog the rule was just added.
 */
export async function reviewRules(opts: { ruleId?: number; created?: boolean } = {}): Promise<void> {
    try {
        const preview = await call(routes.previewRules, { query: { ruleId: opts.ruleId } });
        if (preview.total === 0) {
            ui.toast(opts.created ? "Regel angelegt · keine Umsätze ohne Kategorie passen" : "Keine Umsätze ohne Kategorie passen");
            return;
        }
        ui.open({ kind: "applyRules", ruleId: opts.ruleId, created: opts.created, preview });
    } catch (err) {
        ui.toast(errorText(err), "error");
    }
}
