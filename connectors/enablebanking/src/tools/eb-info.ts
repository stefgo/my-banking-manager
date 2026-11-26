// Shows what Enable Banking offers and in which form a bank's answers come, without their contents.
// Writes nothing to disk; the output goes to the terminal only. Application ID and the path of the
// private key come from .env in the repository root (or the environment):
//
//   MBM_EB_APP_ID=<application ID>   MBM_EB_KEY=<path of the .pem file, relative to the repository root>
//
//   npm run eb-info -w connectors/enablebanking -- banks [COUNTRY]
//       Banks of a country (default DE): public data of Enable Banking.
//   npm run eb-info -w connectors/enablebanking -- probe <BANK> [COUNTRY]
//       Approval at the bank, then accounts, balances and bookings, shown only as their form
//       (fields, kinds, lengths; values only for codes such as status or currency). The session is
//       closed at the end. Optional: MBM_EB_REDIRECT_URL (default https://localhost/bank-callback),
//       MBM_EB_DAYS (bookings of the last n days, default 90), MBM_EB_STRATEGY=longest (as far back
//       as the bank allows).

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createClient, EnableBankingError, type Client } from "../client.js";
import { readPrivateKey } from "../jwt.js";
import { Shape } from "./shape.js";

interface Aspsp {
    name: string;
    country: string;
    beta: boolean;
    maximum_consent_validity: number;
    psu_types: string[];
    auth_methods: { name?: string; approach: string; psu_type: string; hidden_method: boolean }[];
    required_psu_headers?: string[];
    bic?: string;
}

interface SessionAccount {
    uid?: string;
    [k: string]: unknown;
}

interface TransactionPage {
    transactions: Record<string, unknown>[];
    continuation_key?: string | null;
}

/** Relative paths in MBM_EB_KEY count from the repository root, where .env lies. */
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

const ACCOUNT_VALUES = new Set(["cash_account_type", "currency", "usage", "product", "psu_status", "account_id.other.scheme_name", "all_account_ids[].scheme_name", "credit_limit.currency"]);
const BALANCE_VALUES = new Set(["balance_type", "balance_amount.currency", "name"]);
const TRANSACTION_VALUES = new Set([
    "status",
    "credit_debit_indicator",
    "transaction_amount.currency",
    "bank_transaction_code.code",
    "bank_transaction_code.sub_code",
    "bank_transaction_code.description",
    "reference_number_schema",
    "exchange_rate.unit_currency",
    "exchange_rate.rate_type",
    "exchange_rate.instructed_amount.currency",
    "balance_after_transaction.currency",
    "creditor_account.other.scheme_name",
    "debtor_account.other.scheme_name",
]);

function usage(message?: string): never {
    if (message) console.error(message);
    console.error("Usage: npm run eb-info -w connectors/enablebanking -- banks [COUNTRY]");
    console.error("       npm run eb-info -w connectors/enablebanking -- probe <BANK> [COUNTRY]");
    console.error("MBM_EB_APP_ID and MBM_EB_KEY (path of the .pem file) come from .env in the repository root.");
    process.exit(1);
}

function client(): Client {
    const applicationId = process.env.MBM_EB_APP_ID?.trim();
    const keyPath = process.env.MBM_EB_KEY?.trim();
    if (!applicationId || !keyPath) usage("MBM_EB_APP_ID or MBM_EB_KEY is missing.");
    let pem: string;
    try {
        pem = readFileSync(resolve(REPO_ROOT, keyPath), "utf8");
    } catch {
        usage(`Cannot read the key file ${keyPath}.`);
    }
    try {
        return createClient({ applicationId, privateKey: readPrivateKey(pem) });
    } catch {
        usage("The key file holds no private RSA key in PEM form.");
    }
}

const days = (seconds: number) => Math.floor(seconds / 86_400);

async function banks(api: Client, country: string): Promise<Aspsp[]> {
    return (await api.get<{ aspsps: Aspsp[] }>("/aspsps", { country, service: "AIS" })).aspsps;
}

async function listBanks(api: Client, country: string): Promise<void> {
    const list = await banks(api, country);
    console.log(`${list.length} banks in ${country} (AIS):\n`);
    for (const a of list.sort((x, y) => x.name.localeCompare(y.name))) {
        const methods = [...new Set(a.auth_methods.filter((m) => !m.hidden_method).map((m) => `${m.psu_type}/${m.approach}`))].join(", ");
        console.log(`  ${a.name}${a.beta ? " (beta)" : ""} · consent up to ${days(a.maximum_consent_validity)} days · ${a.psu_types.join("/")} · ${methods || "–"}${a.required_psu_headers?.length ? ` · PSU headers: ${a.required_psu_headers.join(", ")}` : ""}`);
    }
}

function printShape(title: string, shape: Shape): void {
    console.log(`\n${title} (${shape.count}):`);
    for (const line of shape.lines()) console.log(line);
}

async function probe(api: Client, bankName: string, country: string): Promise<void> {
    const list = await banks(api, country);
    const aspsp = list.find((a) => a.name.toLowerCase() === bankName.toLowerCase());
    if (!aspsp) {
        const close = list.filter((a) => a.name.toLowerCase().includes(bankName.toLowerCase())).map((a) => a.name);
        usage(`No bank "${bankName}" in ${country}.${close.length ? ` Did you mean: ${close.join(", ")}?` : " See the list with: banks"}`);
    }
    const psuType = aspsp.psu_types.includes("personal") ? "personal" : aspsp.psu_types[0]!;
    console.log(`${aspsp.name} (${aspsp.country})${aspsp.beta ? " beta" : ""}: consent up to ${days(aspsp.maximum_consent_validity)} days, PSU type ${psuType}`);
    console.log(`  auth methods: ${aspsp.auth_methods.map((m) => `${m.name ?? "–"} ${m.psu_type}/${m.approach}${m.hidden_method ? " hidden" : ""}`).join("; ") || "–"}`);
    console.log(`  required PSU headers: ${aspsp.required_psu_headers?.join(", ") || "none"}`);

    // A short consent is enough for a look.
    const validUntil = new Date(Date.now() + Math.min(aspsp.maximum_consent_validity, 86_400) * 1000).toISOString();
    const state = randomBytes(16).toString("hex");
    const redirectUrl = process.env.MBM_EB_REDIRECT_URL?.trim() || "https://localhost/bank-callback";
    const auth = await api.post<{ url: string }>("/auth", { access: { valid_until: validUntil }, aspsp: { name: aspsp.name, country: aspsp.country }, state, redirect_url: redirectUrl, psu_type: psuType });

    console.log(`\nOpen this address in the browser and approve the access at the bank:\n\n  ${auth.url}\n`);
    console.log(`The bank then sends the browser to ${redirectUrl}?code=…; the page itself may fail to load.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const pasted = (await rl.question("Paste the full address from the address bar: ")).trim();
    rl.close();
    let back: URL;
    try {
        back = new URL(pasted);
    } catch {
        usage("That is no address.");
    }
    const error = back.searchParams.get("error");
    if (error) usage(`The bank refused: ${error} ${back.searchParams.get("error_description") ?? ""}`.trim());
    if (back.searchParams.get("state") !== state) usage("The address belongs to another approval (state differs).");
    const code = back.searchParams.get("code");
    if (!code) usage("The address holds no code.");
    console.log(`Redirect: ${back.protocol}//${back.host}${back.pathname} with ${[...back.searchParams.keys()].join(", ")}`);

    const session = await api.post<{ session_id: string; accounts: SessionAccount[]; access: { valid_until?: string } }>("/sessions", { code });
    try {
        console.log(`\nSession authorised; access valid for ${session.access.valid_until ? `${((Date.parse(session.access.valid_until) - Date.now()) / 3_600_000).toFixed(1)} hours` : "?"}.`);
        const accounts = new Shape(ACCOUNT_VALUES);
        for (const a of session.accounts) accounts.add(a);
        printShape("Accounts of the session", accounts);

        const strategy = process.env.MBM_EB_STRATEGY === "longest" ? "longest" : undefined;
        const windowDays = Number(process.env.MBM_EB_DAYS ?? "90") || 90;
        const dateFrom = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
        for (const [i, account] of session.accounts.entries()) {
            console.log(`\n=== Account ${i + 1} of ${session.accounts.length} ===`);
            if (!account.uid) {
                console.log("  no uid: the account cannot be read in this session.");
                continue;
            }
            const balances = new Shape(BALANCE_VALUES);
            try {
                for (const b of (await api.get<{ balances: unknown[] }>(`/accounts/${account.uid}/balances`)).balances) balances.add(b);
                printShape("Balances", balances);
            } catch (e) {
                console.log(`  balances failed: ${describe(e)}`);
            }

            const txs = new Shape(TRANSACTION_VALUES);
            let pages = 0;
            let continuationKey: string | undefined;
            const combos = new Map<string, number>();
            const datesByStatus = new Map<string, number>();
            const ids = { entry_reference: new Map<string, number>(), transaction_id: new Map<string, number>() };
            let earliest: string | null = null;
            const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
            try {
                do {
                    const page = await api.get<TransactionPage>(`/accounts/${account.uid}/transactions`, {
                        // "longest" searches back as far as the bank allows; a start date would limit it.
                        ...(strategy ? { strategy } : { date_from: dateFrom }),
                        ...(continuationKey ? { continuation_key: continuationKey } : {}),
                    });
                    pages++;
                    for (const t of page.transactions) {
                        txs.add(t);
                        const amount = String((t.transaction_amount as { amount?: unknown } | undefined)?.amount ?? "");
                        bump(combos, `${String(t.credit_debit_indicator)} with ${amount.startsWith("-") ? "negative" : "positive"} amount`);
                        const dates = ["booking_date", "value_date", "transaction_date"].filter((k) => typeof t[k] === "string" && t[k]).join("+") || "no date";
                        bump(datesByStatus, `${String(t.status)}: ${dates}`);
                        for (const k of ["entry_reference", "transaction_id"] as const) if (typeof t[k] === "string" && t[k]) bump(ids[k], t[k]);
                        // Some banks (PayPal) send only the transaction date.
                        const d = [t.booking_date, t.transaction_date, t.value_date].find((v): v is string => typeof v === "string" && v !== "");
                        if (d && (!earliest || d < earliest)) earliest = d;
                    }
                    continuationKey = page.continuation_key ?? undefined;
                } while (continuationKey && pages < 200);
            } catch (e) {
                console.log(`  bookings failed after ${pages} page(s): ${describe(e)}`);
            }
            printShape(`Bookings since ${strategy ? "as far back as possible" : `${windowDays} days`}, ${pages} page(s)`, txs);
            console.log("\n  Sign:", [...combos].map(([k, n]) => `${k} ${n}`).join(", ") || "–");
            console.log("  Dates per status:", [...datesByStatus].map(([k, n]) => `${k} ${n}`).join(", ") || "–");
            for (const [k, m] of Object.entries(ids)) {
                const doubles = [...m.values()].filter((n) => n > 1).length;
                console.log(`  ${k}: ${m.size} distinct, ${doubles} occurring more than once`);
            }
            if (earliest) console.log(`  Earliest booking: ${Math.round((Date.now() - Date.parse(earliest)) / 86_400_000)} days ago`);
        }
    } finally {
        await api
            .delete(`/sessions/${session.session_id}`)
            .then(() => console.log("\nSession closed."))
            .catch((e: unknown) => console.log(`\nClosing the session failed (${describe(e)}); it ends on its own within a day.`));
    }
}

function describe(e: unknown): string {
    if (e instanceof EnableBankingError) return `${e.status} ${e.code}: ${e.message}`;
    return e instanceof Error ? e.message : String(e);
}

const [command, arg1, arg2] = process.argv.slice(2);
try {
    if (command === "banks") await listBanks(client(), (arg1 ?? "DE").toUpperCase());
    else if (command === "probe" && arg1) {
        console.log("Shows only the form of the answers. Check the output before passing it on.\n");
        await probe(client(), arg1, (arg2 ?? "DE").toUpperCase());
    } else usage();
} catch (e) {
    console.error(`Failed: ${describe(e)}`);
    process.exit(1);
}
