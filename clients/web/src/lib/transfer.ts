// Transfers in the web client: texts for states and the verification of payee, the form's
// checks, and how other places start a transfer with prefilled data.

import { useNavigate } from "@tanstack/react-router";
import {
    BIC_PATTERN,
    addDaysIso,
    cleanIban,
    firstRunFrom,
    isBankingDay,
    orderDateRange,
    recurrenceLabel,
    scheduledDateProblem,
    standingOrderDates,
    standingOrderProblem,
    todayIso,
    toBankingDay,
    groupIban,
    ibanLength,
    ibanProblem,
    joinRemittance,
    needsBic,
    parseAmount,
    REMITTANCE_LINE_MAX,
    REMITTANCE_LINES,
    SEPA_NAME_MAX,
    SEPA_REMITTANCE_MAX,
    sepaCharsMessage,
    TRANSFER_MAX_CENTS,
    type ConnectorOrderRules,
    type ConnectorRecurrence,
    type Transfer,
    type TransferExecution,
    type TransferExecutionRequest,
    type TransferStatus,
    type VopResult,
} from "@mbm/shared";
import { dateText } from "./format";
import type { FieldErrors } from "./fields";
import { ui, type TransferDraft } from "./ui";

export const STATUS_LABEL: Record<TransferStatus, string> = {
    submitting: "wird gesendet",
    awaiting_vop_confirm: "wartet auf deine Bestätigung",
    awaiting_tan: "wartet auf die Freigabe",
    executed: "ausgeführt",
    rejected: "abgelehnt",
    failed: "nicht gesendet",
    cancelled: "abgebrochen",
    unknown: "Ausgang unbekannt",
};

export type Tone = "ok" | "warn" | "bad" | "neutral";

export const isRunning = (s: TransferStatus): boolean => s === "submitting" || s === "awaiting_vop_confirm" || s === "awaiting_tan";

/** Waits for something the user does. */
export const needsUser = (s: TransferStatus): boolean => s === "awaiting_vop_confirm" || s === "awaiting_tan";

export const VOP_VIEW: Record<VopResult, { tone: Tone; title: string } | null> = {
    match: { tone: "ok", title: "Name passt" },
    close_match: { tone: "warn", title: "Name passt fast" },
    no_match: { tone: "bad", title: "Name passt nicht" },
    not_applicable: { tone: "warn", title: "Name konnte nicht geprüft werden" },
    pending: { tone: "warn", title: "Ergebnis der Prüfung steht noch aus" },
    none: null,
};

/** Results after which the user has to tick a box before going on. */
export const needsSecondConfirm = (r: VopResult): boolean => r === "no_match" || r === "not_applicable" || r === "pending";

export interface TransferForm {
    accountId: string;
    payeeName: string;
    payeeIban: string;
    /** Only sent for SEPA countries outside the EEA (`needsBic`). */
    payeeBic: string;
    amount: string;
    /** The lines of the remittance information; the bank gets them joined (`joinRemittance`). */
    remittance: string[];
    instant: boolean;
    pin: string;
    /** Now, on a date (scheduled transfer) or as a standing order. */
    execution: TransferExecution;
    /** `date`: the day, JJJJ-MM-TT; "" while none is chosen. */
    date: string;
    /** `standing`: the rhythm. */
    unit: "month" | "week";
    every: number;
    executionDay: number;
    firstDate: string;
    /** "" = without end. */
    lastDate: string;
}

export const emptyLines = (): string[] => Array.from({ length: REMITTANCE_LINES }, () => "");

export const emptyForm = (accountId = ""): TransferForm => ({
    accountId,
    payeeName: "",
    payeeIban: "",
    payeeBic: "",
    amount: "",
    remittance: emptyLines(),
    instant: false,
    pin: "",
    execution: "now",
    date: "",
    unit: "month",
    every: 1,
    executionDay: 1,
    firstDate: "",
    lastDate: "",
});

// ---------- Execution: now, on a date, standing order ----------

/** What an account allows, as `GET /api/transfers/accounts` reports it. */
export interface ExecutionAccount {
    transfer: boolean;
    instant: boolean;
    scheduled: boolean;
    standing: boolean;
    orderRules: ConnectorOrderRules | null;
}

export const EXECUTION_LABEL: Record<TransferExecution, string> = { now: "Sofort", date: "Am Datum", standing: "Regelmäßig" };

/** The ways the account can pay: a new scheduled transfer or standing order needs the bank's rules. */
export function executionsOf(a: ExecutionAccount | undefined): TransferExecution[] {
    if (!a) return ["now"];
    const out: TransferExecution[] = [];
    if (a.transfer || a.instant) out.push("now");
    if (a.scheduled && a.orderRules?.scheduled) out.push("date");
    if (a.standing && a.orderRules?.standing) out.push("standing");
    return out;
}

const MONTH_RHYTHM: Record<number, string> = { 1: "monatlich", 3: "vierteljährlich", 6: "halbjährlich", 12: "jährlich" };

/** "monatlich", "alle 2 Monate", "wöchentlich", "alle 2 Wochen". */
export const rhythmLabel = (unit: "month" | "week", every: number): string =>
    unit === "week" ? (every === 1 ? "wöchentlich" : `alle ${every} Wochen`) : (MONTH_RHYTHM[every] ?? `alle ${every} Monate`);

const WEEKDAY = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

/** "am 15.", "am Monatsende", "Freitag". */
export function dayLabel(unit: "month" | "week", day: number): string {
    if (unit === "week") return WEEKDAY[day - 1] ?? String(day);
    return { 99: "am Monatsende", 98: "am vorletzten Tag", 97: "am drittletzten Tag" }[day] ?? `am ${day}.`;
}

/**
 * The rhythms the bank allows, as choices. `keep` (the order's own rhythm, for a change) is
 * offered even if the bank no longer lists it.
 */
export function rhythmOptions(rules: { months: number[]; weeks: number[] } | null | undefined, keep?: { unit: "month" | "week"; every: number }): { unit: "month" | "week"; every: number; label: string }[] {
    const out = [
        ...(rules?.months ?? []).map((n) => ({ unit: "month" as const, every: n, label: rhythmLabel("month", n) })),
        ...(rules?.weeks ?? []).map((n) => ({ unit: "week" as const, every: n, label: rhythmLabel("week", n) })),
    ];
    if (keep && !out.some((o) => o.unit === keep.unit && o.every === keep.every)) out.unshift({ ...keep, label: rhythmLabel(keep.unit, keep.every) });
    return out;
}

/** The days of execution the bank allows; 97 and 98 (counted from the end) are offered only to `keep` them. */
export function dayOptions(unit: "month" | "week", rules: { monthDays: number[]; weekDays: number[] } | null | undefined, keep?: number): { value: number; label: string }[] {
    const days = unit === "week" ? (rules?.weekDays ?? []) : (rules?.monthDays ?? []).filter((d) => d <= 31 || d === 99);
    const out = days.map((d) => ({ value: d, label: dayLabel(unit, d) }));
    if (keep !== undefined && !days.includes(keep)) out.unshift({ value: keep, label: dayLabel(unit, keep) });
    return out;
}

/** The earliest first run of a rhythm, after the bank's lead time. */
export function earliestFirstRun(rules: { minDays: number; maxDays: number }, r: { unit: "month" | "week"; executionDay: number }, today = todayIso()): string {
    return firstRunFrom(r, orderDateRange(rules, today).earliest);
}

export const recurrenceOfForm = (f: TransferForm): ConnectorRecurrence => ({ firstDate: f.firstDate, unit: f.unit, every: f.every, executionDay: f.executionDay, lastDate: f.lastDate || null });

/** The execution as the server takes it. */
export function executionOf(f: TransferForm): TransferExecutionRequest {
    if (f.execution === "date") return { kind: "date", date: f.date };
    if (f.execution === "standing") return { kind: "standing", ...recurrenceOfForm(f) };
    return { kind: "now" };
}

/** A date with the banking day it would run on, if that differs: "05.12.2026 (ausgeführt am 07.12.2026)". */
export function dateWithBankingDay(iso: string): string {
    if (!iso || isBankingDay(iso)) return dateText(iso);
    return `${dateText(iso)} (voraussichtlich ausgeführt am ${dateText(toBankingDay(iso))})`;
}

/** The rhythm in words with its dates: "monatlich am 1., ab 01.12.2026, unbefristet". */
export const rhythmText = (r: ConnectorRecurrence): string => `${recurrenceLabel(r)}, ab ${dateText(r.firstDate)}, ${r.lastDate ? `bis ${dateText(r.lastDate)}` : "unbefristet"}`;

/** The next runs of a rhythm from today on, for the preview below the fields. */
export function nextRuns(r: ConnectorRecurrence, count = 3, today = todayIso()): string[] {
    if (!r.firstDate) return [];
    return standingOrderDates(r, today, addDaysIso(today, 800)).slice(0, count);
}

/** When it runs, in words: "am nächsten Bankarbeitstag", "am 05.12.2026", "monatlich am 1., ab …". */
export function executionText(f: { execution: TransferExecution; instant: boolean; executionDate: string | null; recurrence: ConnectorRecurrence | null }): string {
    if (f.execution === "date") return f.executionDate ? `am ${dateWithBankingDay(f.executionDate)}` : "";
    if (f.execution === "standing") return f.recurrence ? rhythmText(f.recurrence) : "";
    return f.instant ? "sofort, in Sekunden beim Empfänger" : "am nächsten Bankarbeitstag";
}

/** What a transfer of the history is: "Überweisung", "Dauerauftrag", "Änderung des Dauerauftrags", … */
export function kindLabel(t: Pick<Transfer, "execution" | "action" | "instant">): string {
    if (t.execution === "now") return t.instant ? "Echtzeitüberweisung" : "Überweisung";
    const noun = t.execution === "date" ? "Terminüberweisung" : "Dauerauftrag";
    if (t.action === "change") return `Änderung ${t.execution === "date" ? "der Terminüberweisung" : "des Dauerauftrags"}`;
    if (t.action === "delete") return `Löschung ${t.execution === "date" ? "der Terminüberweisung" : "des Dauerauftrags"}`;
    return noun;
}

/** The title of an executed transfer or order. */
export function executedTitle(t: Pick<Transfer, "execution" | "action" | "instant" | "unconfirmed">): string {
    if (t.execution === "now") return t.instant ? (t.unconfirmed ? "Echtzeitüberweisung eingereicht" : "Echtzeitüberweisung ausgeführt") : "Überweisung ausgeführt";
    const noun = t.execution === "date" ? "Terminüberweisung" : "Dauerauftrag";
    return `${noun} ${{ create: "angelegt", change: "geändert", delete: "gelöscht" }[t.action]}`;
}

/** Field ids of the execution, for the errors of the form. */
export const EXEC_FIELD = { date: "tr-date", rhythm: "tr-rhythm", first: "tr-first", last: "tr-last" } as const;

/** The error of the execution, at the field it belongs to. */
function executionProblems(f: TransferForm, rules: ConnectorOrderRules | null | undefined, today: string, mode: { change?: boolean; firstDateFixed?: boolean }): FieldErrors {
    if (f.execution === "date") {
        const r = mode.change ? rules?.scheduledChange : rules?.scheduled;
        if (!f.date) return { [EXEC_FIELD.date]: "Bitte das Datum wählen." };
        return { [EXEC_FIELD.date]: r ? (scheduledDateProblem(r, f.date, today) ?? undefined) : undefined };
    }
    if (f.execution === "standing") {
        const r = mode.change ? rules?.standingChange : rules?.standing;
        if (!f.firstDate) return { [EXEC_FIELD.first]: "Bitte die erste Ausführung wählen." };
        const problem = r ? standingOrderProblem(r, recurrenceOfForm(f), today, { firstDateFixed: mode.firstDateFixed }) : null;
        if (!problem) return {};
        const at = problem.startsWith("Erste") ? EXEC_FIELD.first : problem.startsWith("Letzte") || problem.startsWith("Die letzte") ? EXEC_FIELD.last : EXEC_FIELD.rhythm;
        return { [at]: problem };
    }
    return {};
}

/** The BIC the transfer carries: only where the form offers it, and only if one is entered. */
export const bicToSend = (f: TransferForm): string | null => {
    const bic = f.payeeBic.trim().toUpperCase();
    return bic && needsBic(cleanIban(f.payeeIban)) ? bic : null;
};

/** The longest IBAN there is (ISO 13616). */
const IBAN_MAX = 34;

/**
 * An IBAN as typed, in its paper form (groups of four) while it is entered, and where the caret
 * goes: behind the same character it was behind before. `pos` is the caret in `raw`. Never longer
 * than the IBAN of its country, or than 34 characters while the country is not known.
 */
export function ibanAsTyped(raw: string, pos: number): { value: string; caret: number } {
    const all = cleanIban(raw);
    const clean = all.slice(0, ibanLength(all) ?? IBAN_MAX);
    const before = Math.min(cleanIban(raw.slice(0, pos)).length, clean.length);
    const value = groupIban(clean);
    // After the fourth character of a group the caret stays in front of the space
    return { value, caret: before === 0 ? 0 : before + Math.floor((before - 1) / 4) };
}

/**
 * Characters that can still be written: on in the last line used and in the empty lines below
 * it, and at most what the 140 of SEPA leave, where each further line costs its joining space.
 */
export function remittanceLeft(lines: readonly string[]): number {
    let avail = SEPA_REMITTANCE_MAX - joinRemittance(lines).length;
    let k = lines.length - 1;
    while (k >= 0 && !lines[k]!.trim()) k--;
    let left = 0;
    if (k >= 0) {
        const take = Math.max(0, Math.min(REMITTANCE_LINE_MAX - lines[k]!.length, avail));
        left += take;
        avail -= take;
    }
    for (let i = k + 1; i < lines.length; i++) {
        const sep = i > 0 && k >= 0 ? 1 : 0;
        const take = Math.min(REMITTANCE_LINE_MAX, avail - sep);
        if (take <= 0) break;
        left += take;
        avail -= take + sep;
        k = i;
    }
    return Math.max(0, left);
}

function remittanceProblem(lines: string[]): string | undefined {
    const long = lines.findIndex((l) => l.trim().length > REMITTANCE_LINE_MAX);
    if (long >= 0) return `Zeile ${long + 1} hat mehr als ${REMITTANCE_LINE_MAX} Zeichen.`;
    const text = joinRemittance(lines);
    if (text.length > SEPA_REMITTANCE_MAX) return `Höchstens ${SEPA_REMITTANCE_MAX} Zeichen, mit je einem Leerzeichen zwischen den Zeilen.`;
    return sepaCharsMessage(text) ?? undefined;
}

/**
 * The form's errors by field id; the server checks the same once more. `rules` are the bank's
 * rules for orders; `mode.change` checks against the rules for changes.
 */
export function checkTransfer(f: TransferForm, pinRequired: boolean, rules?: ConnectorOrderRules | null, today = todayIso(), mode: { change?: boolean; firstDateFixed?: boolean } = {}): FieldErrors {
    const cents = parseAmount(f.amount);
    const iban = cleanIban(f.payeeIban);
    const name = f.payeeName.trim();
    return {
        "tr-acc": f.accountId ? undefined : "Bitte ein Konto wählen.",
        "tr-name": !name ? "Bitte den Empfänger eingeben." : name.length > SEPA_NAME_MAX ? `Höchstens ${SEPA_NAME_MAX} Zeichen.` : (sepaCharsMessage(name) ?? undefined),
        "tr-iban": !iban ? "Bitte die IBAN eingeben." : (ibanProblem(iban) ?? undefined),
        "tr-bic": bicToSend(f) !== null && !BIC_PATTERN.test(bicToSend(f)!) ? "Die BIC hat 8 oder 11 Buchstaben und Ziffern." : undefined,
        "tr-amount": cents === null || cents <= 0 ? "Bitte einen Betrag größer als 0 eingeben." : cents > TRANSFER_MAX_CENTS ? "Der Betrag ist zu groß." : undefined,
        "tr-purpose": remittanceProblem(f.remittance),
        "tr-pin": pinRequired && !f.pin ? "Bitte die PIN eingeben." : undefined,
        ...executionProblems(f, rules, today, mode),
    };
}

/**
 * A request ID (UUID v4) for one transfer form. `crypto.randomUUID` exists only in a secure
 * context (HTTPS or localhost); `getRandomValues` everywhere.
 */
export function newRequestId(): string {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Bank code of a German IBAN, for the bank's name from the directory; null otherwise. */
export const blzOfIban = (iban: string): string | null => {
    const s = cleanIban(iban);
    return /^DE\d{20}$/.test(s) ? s.slice(4, 12) : null;
};

/** Opens the transfer page with the dialog of a prefilled form. */
export function useStartTransfer() {
    const navigate = useNavigate();
    return (draft: TransferDraft = {}) => {
        ui.newTransfer(draft);
        void navigate({ to: "/transfer" });
    };
}
