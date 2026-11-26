// Takes every screenshot in docs/assets/screenshots/.
//
//     npm run screenshots              # build the web client, then capture
//     npm run screenshots -- --no-build
//
// No MBM server, no database, no connector and no bank are involved. The built web client is
// served by serve.ts, and every request to /api is answered inside the browser from the invented
// data in fixtures.ts. Each answer is checked against the response schema of its route in
// shared/src/api.ts: an answer that no longer fits stops the run, so the fixtures cannot drift
// away from the API unnoticed.
//
// Three things keep the output the same from run to run, so a capture does not change every image:
// the browser's clock is frozen to fixtures.FIXED_NOW, the timezone and locale are fixed, and the
// version comes from the root package.json.

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { routes, type RouteDef } from "@mbm/shared";
import { serve } from "./serve.js";
import * as fx from "./fixtures.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_ROOT = path.join(REPO, "clients/web/dist");
const OUT = path.join(REPO, "docs/assets/screenshots");
const PORT = 4183;

/** Wide enough for the sidebar, the overview's two columns and the detail drawer beside the list. */
const WIDTH = 1440;
const START_HEIGHT = 900;
const SCALE = 2;
/** Bounds of the fitted height: an application, not a scroll of one. */
const MIN_HEIGHT = 640;
const MAX_HEIGHT = 1500;
const CONTENT_MARGIN = 24;
const PHONE = { width: 390, height: 844 };

const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string }).version;

type Theme = "dark" | "light";
type ServerState = "setup" | "locked" | "ready";

interface Shot {
    name: string;
    route: string;
    /** Default: both. Only the shots on docs/index.md are pairs, see scripts/screenshots/README.md. */
    themes?: Theme[];
    state?: ServerState;
    /** A fixed viewport instead of one fitted to the content. */
    viewport?: { width: number; height: number };
    phone?: boolean;
    /** State the URL cannot carry (an open drawer or dialog); runs once the route has settled. */
    prepare?: (page: Page) => Promise<void>;
}

const LEBENSMITTEL = fx.categories.find((c) => c.name === "Lebensmittel")!.id;

/** The invented file the import pictures read. */
const importSample = { name: "umsaetze-2026.csv", mimeType: "text/csv", buffer: Buffer.from(fx.importSampleCsv) };

const SHOTS: Shot[] = [
    // Pairs for the start page of the documentation
    { name: "uebersicht", route: "/" },
    { name: "umsaetze", route: `/transactions?scope=account:${fx.GIRO}` },
    { name: "ueberweisen", route: "/transfer" },
    { name: "auftraege", route: "/orders" },
    // Single dark shots for the pages below it
    { name: "anmelden", route: "/", state: "locked", themes: ["dark"], viewport: { width: 1000, height: 760 } },
    { name: "einrichten", route: "/", state: "setup", themes: ["dark"], viewport: { width: 1000, height: 900 } },
    {
        name: "umsatz-details",
        route: `/transactions?scope=account:${fx.GIRO}`,
        themes: ["dark"],
        prepare: async (page) => {
            await page.getByText("Versandhaus Nordlicht").first().click();
        },
    },
    { name: "kategorien", route: `/transactions?ctx=cat&cat=${LEBENSMITTEL}`, themes: ["dark"] },
    { name: "suche", route: `/transactions`, themes: ["dark"], prepare: (page) => search(page, "gegenseite:Frischemarkt betrag:>50") },
    { name: "bargeld", route: `/transactions?scope=account:${fx.CASH}`, themes: ["dark"] },
    { name: "paypal", route: `/transactions?scope=account:${fx.PAYPAL}`, themes: ["dark"] },
    {
        name: "ueberweisung-formular",
        route: "/transfer",
        themes: ["dark"],
        viewport: { width: WIDTH, height: 1180 },
        prepare: async (page) => {
            await page.getByRole("button", { name: "Neue Überweisung" }).first().click();
            await page.getByRole("button", { name: /Elektro Funke GmbH/ }).first().click();
            // The chip leaves the focus in the amount
            await page.keyboard.type("238,50");
            await page.keyboard.press("Tab");
            await page.keyboard.type("Rechnung RE-2026-1203");
        },
    },
    {
        name: "auftrag-details",
        route: "/orders",
        themes: ["dark"],
        // The details with their buttons are taller than the list
        viewport: { width: WIDTH, height: 900 },
        prepare: async (page) => {
            await page.getByText("Hausverwaltung Lindenhof GmbH").first().click();
        },
    },
    {
        name: "auftrag-neu",
        route: "/orders",
        themes: ["dark"],
        viewport: { width: WIDTH, height: 1180 },
        prepare: async (page) => {
            await page.getByRole("button", { name: "Neuer Auftrag" }).click();
            await page.getByPlaceholder("Name oder Firma").fill("Mia Muster");
            await page.getByPlaceholder("DE00 0000 0000 0000 0000 00").fill("DE44500105179438371294");
            await page.getByPlaceholder("0,00").fill("50,00");
            await page.locator("#tr-purpose").fill("Taschengeld");
            await page.locator("#tr-name").blur();
        },
    },
    { name: "einstellungen-konten", route: "/settings?tab=accounts", themes: ["dark"] },
    {
        name: "konto-hinzufuegen",
        route: "/settings?tab=accounts",
        themes: ["dark"],
        // A small dialog: on the full page it would be a stamp in a large blurred picture
        viewport: { width: 1200, height: 720 },
        prepare: async (page) => {
            await page.getByRole("button", { name: "Konto hinzufügen" }).first().click();
        },
    },
    {
        name: "psd2-einrichten",
        route: "/settings?tab=accounts",
        themes: ["dark"],
        viewport: { width: 1200, height: 820 },
        prepare: async (page) => {
            await page.getByRole("button", { name: "Konto hinzufügen" }).first().click();
            await page.getByRole("button", { name: /Bank über PSD2/ }).click();
        },
    },
    { name: "einstellungen-regeln", route: "/settings?tab=rules", themes: ["dark"] },
    { name: "einstellungen-profil", route: "/settings?tab=profile", themes: ["dark"] },
    { name: "einstellungen-benutzer", route: "/settings?tab=users", themes: ["dark"] },
    { name: "einstellungen-system", route: "/settings?tab=system", themes: ["dark"] },
    { name: "einstellungen-importe", route: "/settings?tab=imports", themes: ["dark"] },
    {
        name: "import-pruefen",
        route: `/import?account=${fx.CASH}`,
        themes: ["dark"],
        prepare: async (page) => {
            await page.locator('.imp-file input[type="file"]').setInputFiles(importSample);
            await page.locator(".wb-nav").waitFor();
            await page.getByRole("button", { name: "Weiter", exact: true }).click();
            await page.getByRole("button", { name: "Weiter zur Prüfung" }).click();
            await page.locator(".rv-filter").waitFor();
        },
    },
    {
        name: "importformat-bearbeiten",
        route: "/import-format?key=builtin:moneymoney",
        themes: ["dark"],
        viewport: { width: WIDTH, height: 980 },
        prepare: async (page) => {
            await page.locator('.wb-sample input[type="file"]').setInputFiles(importSample);
            await page.locator(".wb-nav").waitFor();
        },
    },
    { name: "einstellungen-protokoll", route: "/settings?tab=activity", themes: ["dark"] },
    { name: "handy-uebersicht", route: "/", themes: ["dark"], phone: true },
    { name: "handy-umsaetze", route: `/transactions?scope=account:${fx.GIRO}`, themes: ["dark"], phone: true },
];

async function search(page: Page, text: string): Promise<void> {
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
}

// ---------- Answers ----------

interface Request {
    params: Record<string, unknown>;
    query: Record<string, unknown>;
    body: unknown;
}

type Answer = (r: Request, ctx: { theme: Theme; state: ServerState }) => unknown;

const OK = { ok: true };

const ANSWERS: Partial<Record<keyof typeof routes, Answer>> = {
    status: (_, ctx) => ({ state: ctx.state, version: VERSION, webBuild: null, webTheme: ctx.theme }),
    me: () => fx.me,
    profile: (_, ctx) => fx.profile(ctx.theme),
    clientSettings: (_, ctx) => fx.profile(ctx.theme).settings,
    setSetting: () => OK,
    listGroups: () => fx.groups,
    listAccounts: () => fx.accounts,
    listCategories: () => fx.categoryList,
    listRules: () => fx.rules,
    listTransactions: (r) => fx.listTransactions(r.query as unknown as fx.TxQuery),
    unreadCounts: () => fx.unreadCounts(),
    markRead: () => ({ changed: 0 }),
    series: (r) => fx.series(r.query as Parameters<typeof fx.series>[0]),
    cashflow: (r) => fx.cashflow(r.query as Parameters<typeof fx.cashflow>[0]),
    categorySums: (r) => fx.categorySums(r.query as Parameters<typeof fx.categorySums>[0]),
    payees: () => fx.payees(),
    listOrders: (r) => fx.ordersInScope(String(r.query.scope)),
    upcomingOrders: (r) => fx.upcoming(r.query as Parameters<typeof fx.upcoming>[0]),
    listUsers: () => fx.users,
    listDevices: () => fx.devices,
    activity: () => fx.activity,
    listImports: () => fx.imports,
    listImportFormats: () => fx.importFormats,
    detectImportFormat: () => ({ format: fx.importPreview.format, formatKey: fx.importPreview.formatKey }),
    importPreview: () => fx.importPreview,
    listConnections: () => fx.connections,
    lastOfferedAccounts: (r) => (Number(r.params.id) === 2 ? fx.paypalOfferedAccounts : fx.offeredAccounts),
    connectorStatus: () => fx.connectorStatus.map((c) => ({ ...c, version: VERSION })),
    bankDirectory: () => fx.bankDirectory,
    searchBanks: (r) => fx.searchBanks(String(r.query.q)),
    listSync: () => [],
    transferAccounts: () => fx.transferAccounts,
    listTransfers: () => fx.transfers,
    getTransfer: (r) => fx.transfers.find((t) => t.id === r.params.id),
    listPayees: () => fx.transferPayees,
};

// Fixed paths before paths with a placeholder, as Fastify decides: /api/transfers/payees is not
// /api/transfers/:id
const ROUTES = Object.entries(routes as Record<string, RouteDef>)
    .map(([name, def]) => ({
        name: name as keyof typeof routes,
        def,
        re: new RegExp(`^${def.path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`),
        placeholders: (def.path.match(/:/g) ?? []).length,
    }))
    .sort((a, b) => a.placeholders - b.placeholders);

/** Answers that did not fit their schema, or requests without an answer. A clean run has none. */
const problems: string[] = [];

async function mockApi(page: Page, ctx: { theme: Theme; state: ServerState }): Promise<void> {
    await page.route("**/api/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const match = ROUTES.find((r) => r.def.method === req.method() && r.re.test(url.pathname));
        const fulfill = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (!match) {
            problems.push(`unknown route ${req.method()} ${url.pathname}`);
            return fulfill(404, { error: "not_found", message: "Unbekannte Route" });
        }
        const answer = ANSWERS[match.name];
        if (!answer) {
            problems.push(`no answer for ${match.name} (${req.method()} ${url.pathname})`);
            return fulfill(500, { error: "unmocked", message: `Keine Antwort für ${match.name}` });
        }
        const def = match.def as RouteDef & { params?: import("zod").ZodType; query?: import("zod").ZodType; response: import("zod").ZodType };
        const raw = req.postData();
        const params = def.params?.safeParse(match.re.exec(url.pathname)?.groups ?? {});
        const query = def.query?.safeParse(Object.fromEntries(url.searchParams));
        if (params?.success === false || query?.success === false) {
            problems.push(`${match.name}: the client sent parameters the route refuses (${url.pathname}${url.search})`);
            return fulfill(400, { error: "bad_request", message: "Ungültige Anfrage" });
        }
        const request: Request = {
            params: (params?.data ?? {}) as Record<string, unknown>,
            query: (query?.data ?? {}) as Record<string, unknown>,
            body: raw ? JSON.parse(raw) : undefined,
        };
        const body = answer(request, ctx);
        const checked = def.response.safeParse(body);
        if (!checked.success) {
            problems.push(`${match.name}: the answer does not fit the schema\n${checked.error.issues.slice(0, 5).map((i) => `      ${i.path.join(".")}: ${i.message}`).join("\n")}`);
        }
        return fulfill(200, body);
    });
    // Server events: the connection opens and stays quiet, as on a server where nothing changes
    await page.routeWebSocket("**/api/events", () => {});
}

// ---------- Capture ----------

function reportPageErrors(page: Page): void {
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    page.on("console", (msg) => {
        if (msg.type() === "error" && !msg.text().includes("status of 4")) problems.push(`console: ${msg.text()}`);
    });
}

/** Waits until the lazy routes have mounted and the entry transitions have run. */
async function settle(page: Page): Promise<void> {
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(700);
}

/** A render error leaves the router's error page behind: a good picture of the wrong thing. */
async function assertRendered(page: Page, route: string): Promise<void> {
    const text = await page.evaluate(() => document.body.textContent ?? "");
    if (text.includes("Something went wrong") || text.includes("Not Found")) throw new Error(`${route} shows an error page instead of the app`);
}

/** Shrinks or grows the viewport to the height the page fills, so short pages are not half empty. */
async function fitToContent(page: Page): Promise<void> {
    const needed = await page.evaluate((margin) => {
        const main = document.querySelector("main");
        if (!main || main.children.length === 0) return document.documentElement.scrollHeight;
        const bottom = Math.max(...[...main.children].map((c) => c.getBoundingClientRect().bottom));
        return bottom + main.scrollTop + margin;
    }, CONTENT_MARGIN);
    const height = Math.min(Math.max(Math.ceil(needed), MIN_HEIGHT), MAX_HEIGHT);
    await page.setViewportSize({ width: WIDTH, height });
    await page.waitForTimeout(300);
}

async function capture(context: BrowserContext, origin: string, shot: Shot, theme: Theme): Promise<void> {
    const page = await context.newPage();
    reportPageErrors(page);
    await page.clock.setFixedTime(fx.FIXED_NOW);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await mockApi(page, { theme, state: shot.state ?? "ready" });
    await page.setViewportSize(shot.phone ? PHONE : (shot.viewport ?? { width: WIDTH, height: START_HEIGHT }));
    await page.goto(`${origin}${shot.route}`);
    await settle(page);
    await assertRendered(page, shot.route);
    if (shot.prepare) {
        await shot.prepare(page);
        await settle(page);
        await assertRendered(page, shot.route);
    }
    if (!shot.viewport && !shot.phone) await fitToContent(page);
    const file = path.join(OUT, `${shot.name}-${theme}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    const { width, height } = page.viewportSize()!;
    console.log(`  ✓ ${path.relative(REPO, file)}  (${width}x${height})`);
    await page.close();
}

async function main(): Promise<void> {
    if (!process.argv.includes("--no-build")) {
        console.log("Building the web client …");
        execFileSync("npm", ["run", "build", "-w", "clients/web"], { cwd: REPO, stdio: "ignore" });
    }
    if (!fs.existsSync(path.join(WEB_ROOT, "index.html"))) {
        console.error(`No built web client in ${path.relative(REPO, WEB_ROOT)}. Drop --no-build.`);
        process.exit(1);
    }
    const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    fs.mkdirSync(OUT, { recursive: true });

    const site = await serve(WEB_ROOT, PORT);
    const browser = await chromium.launch();
    try {
        for (const phone of [false, true]) {
            const context = await browser.newContext({
                viewport: phone ? PHONE : { width: WIDTH, height: START_HEIGHT },
                deviceScaleFactor: SCALE,
                isMobile: phone,
                hasTouch: phone,
                locale: "de-DE",
                timezoneId: fx.TIMEZONE,
                reducedMotion: "reduce",
            });
            for (const shot of SHOTS.filter((s) => !!s.phone === phone && (only.length === 0 || only.includes(s.name)))) {
                for (const theme of shot.themes ?? (["light", "dark"] as Theme[])) await capture(context, site.origin, shot, theme);
            }
            await context.close();
        }
    } finally {
        await browser.close();
        await site.close();
    }
    if (problems.length) {
        console.error(`\n${problems.length} problem(s):`);
        for (const p of [...new Set(problems)]) console.error(`  ! ${p}`);
        process.exit(1);
    }
}

main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
});
