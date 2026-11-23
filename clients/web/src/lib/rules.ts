// Ways into the rule pages from places without a router hook. The router registers itself here, so
// this file does not import it. A draft stays in memory only: it holds bank texts, which never go
// into a URL or the browser's storage.

import type { RuleEdit } from "@mbm/shared";

export interface RuleDraft {
    name?: string;
    query: string;
    categoryId: number | null;
    edits: RuleEdit[];
}

export type RuleIntent = { kind: "draft"; draft: RuleDraft } | { kind: "edit"; ruleId: number };

let goRun: ((ruleId?: number) => void) | null = null;
let goRules: (() => void) | null = null;
let pending: RuleIntent | null = null;

export function registerRuleNavigation(run: (ruleId?: number) => void, rules: () => void): void {
    goRun = run;
    goRules = rules;
}

/** Opens the page that checks and runs the rules; nothing is written before it is confirmed. */
export const openRunRules = (ruleId?: number): void => goRun?.(ruleId);

/** Opens the rules with a filled-in form or with one rule being edited. */
export function openRuleForm(intent: RuleIntent): void {
    pending = intent;
    goRules?.();
}

/** What the rule page should open with; handed out once. */
export function takeRuleIntent(): RuleIntent | null {
    const intent = pending;
    pending = null;
    return intent;
}
