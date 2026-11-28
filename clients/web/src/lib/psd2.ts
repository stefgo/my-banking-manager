// PSD2 bank accesses through Enable Banking in the web client. Application ID and private key live
// only in the state of the open dialog and in the request that carries them; the approval at the
// bank comes back over /bank-callback, whose code and state never go into browser storage.

import type { BankConnection, BankLogin } from "@mbm/shared";
import { refreshBank } from "./bank";
import { dateText } from "./format";
import { ui } from "./ui";

export const CALLBACK_PATH = "/bank-callback";
/** Always allowed as redirect: nothing listens there, the user pastes the address by hand. */
export const LOCALHOST_CALLBACK = `https://localhost${CALLBACK_PATH}`;

/** The redirect back to this MBM, as it has to be registered in the Enable Banking application. */
export const ownCallback = (origin: string = window.location.origin): string => `${origin}${CALLBACK_PATH}`;

/** Days before its end from which an approval is pointed out. */
export const CONSENT_WARN_DAYS = 14;

export type RedirectResult = { kind: "code"; state: string; code: string } | { kind: "error"; error: string; description: string } | { kind: "invalid" };

/** What the bank's redirect brought back: from the address of /bank-callback or one pasted by hand. */
export function readRedirect(address: string | URLSearchParams): RedirectResult {
    let params: URLSearchParams;
    if (typeof address === "string") {
        try {
            params = new URL(address.trim()).searchParams;
        } catch {
            return { kind: "invalid" };
        }
    } else {
        params = address;
    }
    const error = params.get("error");
    if (error) return { kind: "error", error, description: params.get("error_description") ?? "" };
    const state = params.get("state") ?? "";
    const code = params.get("code") ?? "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(state) || !code || code.length > 2_000) return { kind: "invalid" };
    return { kind: "code", state, code };
}

/** The bank's refusal in words; the bank's own text when it gives one. */
export function redirectErrorText(error: string, description: string): string {
    if (error === "access_denied") return `Die Freigabe wurde bei der Bank abgelehnt oder abgebrochen${description ? ` (${description})` : ""}.`;
    return `Die Bank hat die Freigabe nicht erteilt: ${description || error}`;
}

/** Whole days until the approval ends; negative when it has ended. */
export const consentDaysLeft = (until: string, now: number = Date.now()): number => Math.floor((Date.parse(until) - now) / 86_400_000);

/** „Freigabe bis 25.05.2027“, „Freigabe läuft in 3 Tagen ab“, „Freigabe abgelaufen“; null without approval. */
export function consentText(until: string | null, now: number = Date.now()): { text: string; attn: boolean } | null {
    if (!until) return null;
    const days = consentDaysLeft(until, now);
    if (Date.parse(until) <= now) return { text: "Freigabe abgelaufen", attn: true };
    if (days < 1) return { text: "Freigabe läuft heute ab", attn: true };
    if (days < CONSENT_WARN_DAYS) return { text: `Freigabe läuft in ${days === 1 ? "einem Tag" : `${days} Tagen`} ab (${dateText(until.slice(0, 10))})`, attn: true };
    return { text: `Freigabe bis ${dateText(until.slice(0, 10))}`, attn: false };
}

/**
 * The approval to point out at a login: with several approvals (PayPal: one per account) the one
 * that ends first, named after its accounts; else as `consentText`. `names`: account id → name.
 */
export function loginConsentText(login: Pick<BankLogin, "consentUntil" | "accountConsents">, names: ReadonlyMap<number, string>, now: number = Date.now()): { text: string; attn: boolean } | null {
    const ends = login.accountConsents;
    if (new Set(ends.map((e) => e.until)).size < 2) return consentText(ends[0]?.until ?? login.consentUntil, now);
    const first = ends.reduce((a, b) => (Date.parse(b.until) < Date.parse(a.until) ? b : a));
    const t = consentText(first.until, now)!;
    const who = ends.filter((e) => e.until === first.until).map((e) => names.get(e.accountId)).filter(Boolean);
    return who.length ? { text: `${who.map((n) => `„${n}“`).join(", ")}: ${t.text}`, attn: t.attn } : t;
}

/** Several approvals with different ends: each account then shows its own. */
export const hasSeveralConsents = (login: Pick<BankLogin, "accountConsents"> | null | undefined): boolean => new Set((login?.accountConsents ?? []).map((e) => e.until)).size > 1;

export const isPsd2 = (c: Pick<BankConnection, "kind">): boolean => c.kind === "psd2";

/** Countries Enable Banking serves (EEA), German names; Germany first. */
export const PSD2_COUNTRIES: { code: string; name: string }[] = [
    { code: "DE", name: "Deutschland" },
    ...[
        ["AT", "Österreich"], ["BE", "Belgien"], ["BG", "Bulgarien"], ["CY", "Zypern"], ["CZ", "Tschechien"], ["DK", "Dänemark"], ["EE", "Estland"], ["ES", "Spanien"],
        ["FI", "Finnland"], ["FR", "Frankreich"], ["GR", "Griechenland"], ["HR", "Kroatien"], ["HU", "Ungarn"], ["IE", "Irland"], ["IS", "Island"], ["IT", "Italien"],
        ["LI", "Liechtenstein"], ["LT", "Litauen"], ["LU", "Luxemburg"], ["LV", "Lettland"], ["MT", "Malta"], ["NL", "Niederlande"], ["NO", "Norwegen"], ["PL", "Polen"],
        ["PT", "Portugal"], ["RO", "Rumänien"], ["SE", "Schweden"], ["SI", "Slowenien"], ["SK", "Slowakei"],
    ]
        .map(([code, name]) => ({ code: code!, name: name! }))
        .sort((a, b) => a.name.localeCompare(b.name, "de")),
];

/** A key file as text: only small files that look like a PEM key. */
export async function readKeyFile(file: File): Promise<string> {
    if (file.size > 20_000) throw new Error("Die Datei ist zu groß für einen privaten Schlüssel.");
    const text = (await file.text()).trim();
    if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error("Die Datei enthält keinen privaten Schlüssel im PEM-Format.");
    return text;
}

/**
 * After an approval: a new access, or one the approval brought new accounts to, goes on with taking
 * over accounts; a renewed one says so.
 */
export function afterConsent(c: BankConnection & { newAccounts: number }): void {
    refreshBank();
    if (c.myLogin?.status === "setup" || c.newAccounts > 0) {
        ui.open({ kind: "bankSetup", connectionId: c.id, start: "accounts" });
        return;
    }
    const until = c.myLogin?.consentUntil;
    ui.toast(`Freigabe bei ${c.name} erteilt${until ? `, gültig bis ${dateText(until.slice(0, 10))}` : ""}`);
    ui.close();
}
