// Invented data for the screenshots in docs/. Every answer the web client gets during a capture
// comes from here (see capture.ts), and capture.ts checks each one against the response schema of
// its route in shared/src/api.ts.
//
// Nothing here is real: names, IBANs (examples from documentation and test data), amounts. The
// figures are not written out but derived from one list of bookings, so the balance in the header,
// the chart, the group sums and the cashflow card agree with each other the way they do in MBM.
//
// The clock is fixed: TODAY is the day the screenshots show, and every date below is relative to
// it. capture.ts freezes the browser's clock to FIXED_NOW, so "Heute" and "seit Monatsbeginn" stay
// the same from run to run.

import {
    fundingOrder,
    payLaterPairs,
    runFunding,
    BUILTIN_IMPORT_FORMATS,
    columnsFromFormat,
    addDaysIso,
    ibanProblem,
    CARD_CONFIGS,
    DEFAULT_CARDS,
    DEFAULT_CATEGORIES,
    nextStandingOrderDate,
    parseTxQuery,
    standingOrderDates,
    toTxQueryTarget,
    matchTxQuery,
    type Account,
    type AccountGroup,
    type BankConnection,
    type Category,
    type Order,
    type Rule,
    type Transaction,
    type TxRange,
    type ImportPreview,
} from "@mbm/shared";

export const TODAY = "2026-11-20";
/** Mid-morning in Berlin, so "Heute" and "Gestern" fall on the days of the bookings. */
export const FIXED_NOW = new Date("2026-11-20T10:30:00+01:00");
export const TIMEZONE = "Europe/Berlin";

const at = (date: string, time = "08:00:00") => `${date}T${time}.000Z`;
const NO_INFO = { attributes: [], notes: "" };

// ---------- Users and the signed-in session ----------

export const me = { id: 1, name: "Alex", deviceId: 1, sessionLocked: false, sessionIdleMinutes: 10 };

export const users = [
    { id: 1, name: "Alex", totpActive: true, createdAt: at("2026-05-02", "17:12:00"), lastLoginAt: at(TODAY, "09:28:00") },
    { id: 2, name: "Sam", totpActive: true, createdAt: at("2026-05-02", "17:40:00"), lastLoginAt: at("2026-11-19", "19:05:00") },
];

export const devices = [
    { id: 1, userId: 1, name: "Firefox auf macOS", kind: "web", createdAt: at("2026-10-30", "18:02:00"), lastSeenAt: at(TODAY, "09:28:00"), current: true },
    { id: 2, userId: 1, name: "Safari auf iPhone", kind: "web", createdAt: at("2026-09-14", "07:45:00"), lastSeenAt: at("2026-11-19", "07:51:00"), current: false },
    { id: 3, userId: 2, name: "Chrome auf Windows", kind: "web", createdAt: at("2026-08-03", "20:10:00"), lastSeenAt: at("2026-11-19", "19:05:00"), current: false },
    { id: 4, userId: 1, name: "MacBook", kind: "device", createdAt: at("2026-11-01", "12:00:00"), lastSeenAt: at(TODAY, "08:15:00"), current: false },
];

// ---------- Account groups and accounts ----------

export const groups: AccountGroup[] = [
    { id: 1, parentId: null, name: "Privat", icon: "user", color: "neutral", position: 0, info: NO_INFO },
    { id: 2, parentId: 1, name: "Alltag", icon: "wallet-cards", color: "neutral", position: 0, info: NO_INFO },
    { id: 3, parentId: 1, name: "Rücklagen", icon: "layers", color: "neutral", position: 1, info: NO_INFO },
];

interface AccountSeed {
    id: number;
    kind: Account["kind"];
    connectionId: number | null;
    name: string;
    icon: Account["icon"];
    color: Account["color"];
    groupId: number;
    position: number;
    iban: string | null;
    cardNumber: string | null;
    /** Balance before the first booking below. */
    start: number;
}

const ACCOUNT_SEEDS: AccountSeed[] = [
    { id: 1, kind: "giro", connectionId: 1, name: "Girokonto", icon: "landmark", color: "blue", groupId: 2, position: 0, iban: "DE02120300000000202051", cardNumber: null, start: 215000 },
    { id: 2, kind: "credit_card", connectionId: 1, name: "Kreditkarte", icon: "credit-card", color: "violet", groupId: 2, position: 1, iban: null, cardNumber: "4910 •••• •••• 1234", start: 0 },
    // At 0 as most PayPal accounts: payments come from bank account or card
    { id: 6, kind: "giro", connectionId: 2, name: "PayPal", icon: "wallet", color: "sky", groupId: 2, position: 2, iban: null, cardNumber: null, start: 0 },
    { id: 4, kind: "other", connectionId: null, name: "Bargeld", icon: "banknote", color: "green", groupId: 2, position: 3, iban: null, cardNumber: null, start: 15000 },
    { id: 3, kind: "savings", connectionId: 1, name: "Tagesgeld", icon: "piggy-bank", color: "teal", groupId: 3, position: 0, iban: "DE89370400440532013000", cardNumber: null, start: 1200000 },
    { id: 5, kind: "other", connectionId: null, name: "Urlaubskasse", icon: "tree-palm", color: "amber", groupId: 3, position: 1, iban: null, cardNumber: null, start: 60000 },
];

export const GIRO = 1;
export const CARD = 2;
export const SAVINGS = 3;
export const CASH = 4;
export const HOLIDAY = 5;
export const PAYPAL = 6;

// ---------- Bank access ----------

const LAST_SYNC = at(TODAY, "09:29:12");

export const connections: BankConnection[] = [
    {
        id: 1,
        kind: "fints",
        name: "Sparkasse",
        bankName: "Sparkasse Musterstadt",
        blz: "12030000",
        bic: "BYLADEM1001",
        fintsUrl: "https://banking.example.org/fints",
        psd2: null,
        icon: "landmark",
        color: "red",
        myLogin: {
            id: 1,
            loginHint: "alex•••",
            status: "ready",
            tanMethod: { id: "923", name: "S-pushTAN" },
            tanMedium: "iPhone von Alex",
            savePin: true,
            lastSyncAt: LAST_SYNC,
            lastError: null,
            consentUntil: null,
        },
        otherLogins: [{ userName: "Sam", status: "ready" }],
        accountCount: 3,
    },
    {
        id: 2,
        kind: "psd2",
        name: "PayPal",
        bankName: "PayPal",
        blz: "",
        bic: null,
        fintsUrl: "",
        psd2: { aspsp: "PayPal", country: "DE" },
        icon: "wallet",
        color: "sky",
        myLogin: {
            id: 2,
            loginHint: "App ••••5d6e",
            status: "ready",
            tanMethod: null,
            tanMedium: null,
            savePin: true,
            lastSyncAt: LAST_SYNC,
            lastError: null,
            consentUntil: "2027-05-14T09:31:00.000Z",
        },
        otherLogins: [],
        accountCount: 1,
    },
];

export const connectorStatus = [
    { name: "fints", embedded: true, reachable: true, version: null as string | null, productConfigured: true },
    { name: "enablebanking", embedded: true, reachable: true, version: null as string | null, productConfigured: true },
];

/** „Einstellungen → Versionen“; server and connectors get the version of the package. */
export const versions = {
    webBuild: "3f9a2c71d04b8e65",
    node: "26.13.1",
    sqlite: "3.53.4",
    sqliteCiphers: "2.4.0",
    schema: "0017-booking-edits",
};

export const bankDirectory = {
    banks: 3412,
    generated: "2026-11-02",
    origin: "download" as const,
    autoUpdate: true,
    checkedAt: at(TODAY, "06:00:04"),
    lastError: null,
};

// ---------- Categories ----------

/** The start tree of a new installation (shared/src/defaults.ts), numbered in its order. */
const baseCategories: Omit<Category, "count">[] = [];
{
    let id = 0;
    DEFAULT_CATEGORIES.forEach((c, i) => {
        const parentId = ++id;
        baseCategories.push({ id: parentId, parentId: null, name: c.name, icon: c.icon, color: c.color ?? null, position: i, excludedFromStats: !!c.excludedFromStats, counterDefault: !!c.counterDefault, info: NO_INFO });
        c.children?.forEach((ch, j) => baseCategories.push({ id: ++id, parentId, name: ch.name, icon: ch.icon, color: null, position: j, excludedFromStats: false, counterDefault: false, info: NO_INFO }));
    });
}

const cat = (name: string): number => {
    const c = baseCategories.find((x) => x.name === name);
    if (!c) throw new Error(`fixtures: no category "${name}"`);
    return c.id;
};

// ---------- Bookings ----------

/** A small deterministic generator, so amounts vary without changing between runs. */
let seed = 20261120;
const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};
const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));

export const transactions: Transaction[] = [];
let nextTxId = 1;

interface Booking {
    account: number;
    date: string;
    amount: number;
    name: string;
    remittance: string;
    category: string | null;
    iban?: string | null;
    pending?: boolean;
    counterOf?: number;
    /** Added by MBM (PayPal): the payment whose money this booking says where it came from. */
    fundingOf?: number;
    /** The category came by itself (a move between own pockets), not by a rule. */
    auto?: boolean;
    /** Booking text of the bank; by default guessed from the booking. */
    bookingText?: string;
    /** References the bank sent; none by default. */
    refs?: Partial<Pick<Transaction, "reference" | "customerReference" | "bankReference">>;
}

function bookingTextOf(b: Booking, kind: string): string {
    if (b.bookingText) return b.bookingText;
    if (kind === "credit_card") return "Kartenumsatz";
    if (b.amount > 0) return "Gutschrift";
    if (b.category === "Umbuchung") return "Überweisung";
    return b.remittance.includes("Kartenzahlung") ? "Kartenzahlung" : "Lastschrift";
}

function book(b: Booking): Transaction | null {
    if (b.date > TODAY) return null;
    const seedAccount = ACCOUNT_SEEDS.find((a) => a.id === b.account)!;
    const bank = seedAccount.connectionId !== null;
    const t: Transaction = {
        id: nextTxId++,
        accountId: b.account,
        bookingDate: b.date,
        valueDate: bank ? b.date : null,
        amount: b.amount,
        currency: "EUR",
        counterpartyName: b.name,
        ultimateParty: "",
        counterpartyIban: b.iban ?? null,
        remittance: b.remittance,
        bookingText: bank ? bookingTextOf(b, seedAccount.kind) : "",
        reference: "",
        customerReference: "",
        bankReference: "",
        ...b.refs,
        mandateId: "",
        creditorId: "",
        counterpartyBic: "",
        counterpartyAccount: "",
        counterpartyBankCode: "",
        status: b.pending ? "pending" : "booked",
        source: bank ? "bank" : "manual",
        importId: null,
        counterTransactionId: b.counterOf ?? null,
        isReturn: false,
        returnReason: "",
        returnOfId: null,
        returnedById: null,
        fundingOfId: b.fundingOf ?? null,
        fundedById: null,
        categoryId: b.category ? cat(b.category) : null,
        categorySource: b.category ? (b.auto ? "auto" : bank ? "rule" : "manual") : null,
        createdAt: at(b.date, "09:29:12"),
        // What the last fetches brought is new for Alex; what MBM added is never new
        unread: bank && b.date >= "2026-11-18" && !b.fundingOf,
        edits: { counterparty: null, remittance: null },
        original: null,
        deletedAt: null,
    };
    transactions.push(t);
    return t;
}

/** A booking and its counter booking in another own account. */
function transfer(from: number, to: number, date: string, amount: number, remittance: string, fromName: string, toName: string) {
    const out = book({ account: from, date, amount: -amount, name: toName, remittance, category: "Umbuchung" });
    if (out) book({ account: to, date, amount, name: fromName, remittance, category: "Umbuchung", counterOf: ACCOUNT_SEEDS.find((a) => a.id === to)!.connectionId === null ? out.id : undefined });
}

const IBAN = {
    landlord: "DE75512108001245126199",
    utility: "DE02500105170137075030",
    employer: "DE12500105170648489890",
    insurance: "DE02300209000106531065",
    sam: "DE91100000000123456789",
};

const MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
let cardSum = 0;
for (const m of MONTHS) {
    const d = (day: number) => `${m}-${String(day).padStart(2, "0")}`;
    const [, mm] = m.split("-");
    const month = `${mm}/2026`;

    book({ account: GIRO, date: d(1), amount: -112000, name: "Hausverwaltung Lindenhof GmbH", remittance: `Miete ${month} Whg. 3. OG links`, category: "Miete", iban: IBAN.landlord });
    book({ account: GIRO, date: d(2), amount: -8900, name: "Stadtwerke Musterstadt", remittance: "Abschlag Strom und Gas, Vertrag 4471-22", category: "Energie", iban: IBAN.utility });
    book({ account: GIRO, date: d(2), amount: 40000, name: "Sam Beispiel", remittance: "Haushalt", category: "Haushaltsbeitrag", iban: IBAN.sam });
    book({ account: GIRO, date: d(5), amount: -4210, name: "Versicherung Zuversicht AG", remittance: "Haftpflicht und Hausrat", category: "Versicherungen", iban: IBAN.insurance });
    for (const day of [4, 11, 18, 25]) book({ account: GIRO, date: d(day), amount: -between(3800, 9600), name: "Frischemarkt Sonnenhof", remittance: "Kartenzahlung", category: "Supermarkt" });
    for (const day of [6, 13, 20]) book({ account: GIRO, date: d(day), amount: -between(320, 890), name: "Bäckerei Kornblume", remittance: "Kartenzahlung", category: "Bäckerei" });
    for (const day of [8, 23]) book({ account: GIRO, date: d(day), amount: -between(5200, 7400), name: "Tankstelle am Ring", remittance: "Kartenzahlung", category: "Tanken" });
    book({ account: GIRO, date: d(12), amount: -between(1400, 3200), name: "Drogerie Blau", remittance: "Kartenzahlung", category: "Drogerie" });

    // Cash: taken from the giro account, spent at the market
    const cash = book({ account: GIRO, date: d(14), amount: -20000, name: "Geldautomat Hauptstraße", remittance: "Bargeldauszahlung", category: "Bargeld" });
    if (cash) book({ account: CASH, date: d(14), amount: 20000, name: "Girokonto", remittance: "Abhebung", category: "Umbuchung", counterOf: cash.id });
    for (const day of [15, 22, 29]) book({ account: CASH, date: d(day), amount: -between(900, 2400), name: "Wochenmarkt", remittance: "Obst und Gemüse", category: "Lebensmittel" });
    book({ account: CASH, date: d(17), amount: -between(2500, 4500), name: "Eiscafé Venezia", remittance: "", category: "Freizeit" });

    // Credit card: subscriptions and online orders, settled from the giro account the next month
    if (cardSum) {
        book({ account: GIRO, date: d(10), amount: -cardSum, name: "Kreditkartenabrechnung", remittance: `Abrechnung Kreditkarte`, category: "Umbuchung" });
        book({ account: CARD, date: d(10), amount: cardSum, name: "Ausgleich vom Girokonto", remittance: "Abrechnung", category: "Umbuchung" });
    }
    cardSum = 0;
    const card = (day: number, amount: number, name: string, remittance: string, category: string) => {
        if (book({ account: CARD, date: d(day), amount: -amount, name, remittance, category })) cardSum += amount;
    };
    card(3, 1299, "Streamio Europe", "Monatsabo Familie", "Streaming & Musik");
    card(9, between(2400, 8900), "Versandhaus Nordlicht", `Bestellung 4711-${mm}`, "Online-Handel");
    card(21, 999, "Klangwelle Music", "Premium", "Streaming & Musik");

    book({ account: GIRO, date: d(16), amount: -50000, name: "Tagesgeld", remittance: "Sparrate", category: "Umbuchung", iban: "DE89370400440532013000" });
    book({ account: SAVINGS, date: d(16), amount: 50000, name: "Alex Beispiel", remittance: "Sparrate", category: "Umbuchung" });
    book({ account: GIRO, date: d(27), amount: 348750, name: "Beispiel Werke GmbH", remittance: `Gehalt ${month}`, category: "Gehalt", iban: IBAN.employer });
    book({ account: SAVINGS, date: d(30), amount: between(380, 460), name: "Sparkasse Musterstadt", remittance: "Zinsgutschrift", category: "Zinsen" });
    transfer(GIRO, HOLIDAY, d(28), 10000, "Sparrate Urlaub", "Girokonto", "Urlaubskasse");
}

// A few bookings that are not monthly
book({ account: GIRO, date: "2026-07-18", amount: -38900, name: "Reisebüro Fernweh", remittance: "Anzahlung Ferienwohnung Ostsee", category: "Urlaub" });
book({ account: HOLIDAY, date: "2026-08-12", amount: -64000, name: "Ferienwohnung Dünenblick", remittance: "Restzahlung 2 Wochen", category: "Urlaub" });
book({ account: GIRO, date: "2026-09-26", amount: -24900, name: "Möbelhaus Eiche", remittance: "Regal Wohnzimmer", category: "Einrichtung" });
book({ account: CARD, date: "2026-10-21", amount: -6400, name: "Konzerthaus Musterstadt", remittance: "2 Karten Jazzabend", category: "Konzerte & Events" });
book({
    account: GIRO,
    date: "2026-11-17",
    amount: 2490,
    name: "Versandhaus Nordlicht",
    remittance: "Erstattung Rücksendung 4711-11",
    category: "Erstattungen",
    refs: { reference: "RT-4711-11-0042", customerReference: "GUTSCHRIFT-2026-11", bankReference: "2026111700381" },
});
book({ account: GIRO, date: "2026-11-19", amount: -1890, name: "Pizzeria Da Marco", remittance: "Kartenzahlung", category: "Freizeit" });
// PayPal over PSD2: no purpose, the counterparty's e-mail in its place, the PayPal transaction number as bank reference
const paypal = (date: string, amount: number, name: string, email: string, category: string, bookingText: string, ref: string) =>
    book({ account: PAYPAL, date, amount, name, remittance: email, category, bookingText, refs: { bankReference: ref } });
paypal("2026-08-14", -1999, "Spielwerkstatt Holzwurm", "verkauf@holzwurm.example", "Online-Handel", "Zahlung", "1AB23456CD789012E");
paypal("2026-09-03", -4590, "Kartenhaus Tickets", "tickets@kartenhaus.example", "Konzerte & Events", "Zahlung", "2BC34567DE890123F");
paypal("2026-10-05", -8900, "Möbelhaus Eichenhain", "kontakt@eichenhain.example", "Online-Handel", "Zahlung", "6FA78901BC234567K");
paypal("2026-10-12", -2750, "Gartenwelt Online", "shop@gartenwelt.example", "Online-Handel", "Zahlung", "3CD45678EF901234G");
paypal("2026-10-20", 2750, "Gartenwelt Online", "shop@gartenwelt.example", "Erstattungen", "Erstattung", "4DE56789FA012345H");
// The purchase at Eichenhain with "Pay in 30 days": its repayment, a move between own pockets
book({ account: PAYPAL, date: "2026-11-04", amount: -8900, name: "PayPal (Europe) S.à r.l. et Cie, S.C.A.", remittance: "", category: "Umbuchung", auto: true, bookingText: "Rückzahlung Später bezahlen", refs: { bankReference: "7AB89012CD345678L" } });
paypal("2026-11-15", -1290, "Rösterei Bohnenglück", "hallo@bohnenglueck.example", "Freizeit", "Zahlung", "5EF67890AB123456J");
// What PayPal does not report, worked out as the server does it (services/paypalfunding.ts)
{
    const own = transactions
        .filter((t) => t.accountId === PAYPAL)
        .map((t) => ({ t, amount: t.amount, date: t.bookingDate, repayment: t.bookingText === "Rückzahlung Später bezahlen", purchase: t.amount < 0 && t.bookingText === "Zahlung" }));
    const onCredit = new Set(payLaterPairs(own).keys());
    const ordered = fundingOrder(own);
    const run = runFunding(
        ordered.map((i) => ({ amount: i.amount, date: i.date, onCredit: onCredit.has(i) })),
        ACCOUNT_SEEDS.find((a) => a.id === PAYPAL)!.start,
    );
    ordered.forEach((i, n) => {
        const payLater = onCredit.has(i);
        const amount = payLater ? -i.amount : run.outside[n]!;
        if (amount <= 0) return;
        const purpose = i.repayment ? "für Rückzahlung Später bezahlen" : `für Zahlung an ${i.t.counterpartyName}`;
        const added = payLater
            ? book({ account: PAYPAL, date: i.date, amount, name: "PayPal Später bezahlen", remittance: purpose, category: "Umbuchung", auto: true, bookingText: "Später bezahlen", fundingOf: i.t.id })
            : book({ account: PAYPAL, date: i.date, amount, name: "Bankkonto oder Karte", remittance: purpose, category: "Umbuchung", auto: true, bookingText: "Abbuchung", fundingOf: i.t.id });
        if (added) i.t.fundedById = added.id;
    });
}
book({ account: GIRO, date: "2026-11-20", amount: -2499, name: "Buchhandlung Seitenweise", remittance: "Kartenzahlung", category: null });
book({ account: GIRO, date: "2026-11-20", amount: -3745, name: "Frischemarkt Sonnenhof", remittance: "Kartenzahlung", category: "Supermarkt", pending: true });

transactions.sort((a, b) => b.bookingDate.localeCompare(a.bookingDate) || b.id - a.id);

/** A booking the user deleted: kept apart from the others, so that it counts nowhere, as on the server. */
function deleted(b: Booking, when: string): Transaction {
    const t = book(b)!;
    transactions.pop();
    return { ...t, unread: false, deletedAt: when };
}

/** For the deleted bookings in the settings; only those of the bank, one entered by hand goes for good. */
export const deletedTransactions: Transaction[] = [
    deleted({ account: GIRO, date: "2026-11-14", amount: -3745, name: "Frischemarkt Sonnenhof", remittance: "Kartenzahlung", category: "Supermarkt" }, at("2026-11-15", "17:42:08")),
    deleted({ account: GIRO, date: "2026-10-02", amount: -1999, name: "Streamingdienst Flimmer", remittance: "Lastschrift Probeabo", category: null }, at("2026-10-05", "08:12:40")),
    deleted({ account: CARD, date: "2026-11-09", amount: -12900, name: "Hotel Seeblick", remittance: "Reservierung, storniert", category: null }, at("2026-11-11", "19:03:51")),
    deleted({ account: PAYPAL, date: "2026-11-03", amount: -2450, name: "Kleinanzeigen Versand", remittance: "Doppelt gebucht", category: null }, at("2026-11-04", "09:27:15")),
].sort((a, b) => b.bookingDate.localeCompare(a.bookingDate) || b.id - a.id);

// ---------- Derived: accounts, categories ----------

const sumOf = (list: Transaction[]) => list.reduce((s, t) => s + t.amount, 0);

export const accounts: Account[] = ACCOUNT_SEEDS.map((s) => {
    const own = transactions.filter((t) => t.accountId === s.id);
    const pending = own.filter((t) => t.status === "pending");
    return {
        id: s.id,
        kind: s.kind,
        connectionId: s.connectionId,
        name: s.name,
        icon: s.icon,
        color: s.color,
        groupId: s.groupId,
        position: s.position,
        hidden: false,
        iban: s.iban,
        cardNumber: s.cardNumber,
        currency: "EUR",
        openingBalance: s.connectionId === null ? s.start : null,
        balance: s.start + sumOf(own),
        pendingSum: sumOf(pending),
        pendingCount: pending.length,
        transactionCount: own.length,
        createdAt: at("2026-05-02", "17:30:00"),
        info: s.id === GIRO ? { attributes: [{ key: "Kontoinhaber", value: "Alex und Sam Beispiel" }], notes: "" } : NO_INFO,
    };
});

const startOf = (id: number) => ACCOUNT_SEEDS.find((a) => a.id === id)!.start;

export const categories: Category[] = baseCategories.map((c) => ({ ...c, count: transactions.filter((t) => t.categoryId === c.id).length }));

export const categoryList = {
    items: categories,
    uncategorized: transactions.filter((t) => t.categoryId === null).length,
    none: { parentId: null, position: null },
};

// ---------- The search syntax, for the list, the rules and their hit counts ----------

function groupPath(id: number | null): string[] {
    const names: string[] = [];
    for (let g = groups.find((x) => x.id === id); g; g = groups.find((x) => x.id === g!.parentId)) names.push(g.name);
    return names;
}
function categoryPath(id: number | null): string[] {
    const names: string[] = [];
    for (let c = categories.find((x) => x.id === id); c; c = categories.find((x) => x.id === c!.parentId)) names.push(c.name);
    return names;
}
function targetOf(t: Transaction) {
    const a = accounts.find((x) => x.id === t.accountId)!;
    return toTxQueryTarget({
        counterparty: t.counterpartyName,
        ultimateParty: t.ultimateParty,
        remittance: t.remittance,
        bookingText: t.bookingText,
        iban: t.counterpartyIban,
        amount: t.amount,
        category: categories.find((c) => c.id === t.categoryId)?.name ?? "",
        categoryPath: categoryPath(t.categoryId),
        uncategorized: t.categoryId === null,
        accountPath: [a.name, ...groupPath(a.groupId)],
        accountIban: a.iban,
        bookingDate: t.bookingDate,
        unread: t.unread,
    });
}

const RULES: [string, string][] = [
    ["gegenseite:Frischemarkt", "Supermarkt"],
    ["gegenseite:Hausverwaltung", "Miete"],
    ['gegenseite:"Stadtwerke Musterstadt"', "Energie"],
    ["zweck:Gehalt iban:DE12500105170648489890", "Gehalt"],
    ["gegenseite:Tankstelle", "Tanken"],
    ["gegenseite:Bäckerei", "Bäckerei"],
    ["gegenseite:Streamio ODER gegenseite:Klangwelle", "Streaming & Musik"],
    ["zweck:Zinsgutschrift", "Zinsen"],
];

const parsedRules = RULES.map(([query, category]) => {
    const parsed = parseTxQuery(query, { mode: "rule" });
    if (!parsed.ok) throw new Error(`fixtures: rule "${query}": ${parsed.error}`);
    return { query, category, node: parsed.query };
});

export const rules: Rule[] = parsedRules.map((r, i) => ({
    id: i + 1,
    name: "",
    query: r.query,
    categoryId: cat(r.category),
    accountIds: null,
    extracts: [],
    edits: [],
    position: i,
    active: true,
    hits: transactions.filter((t) => matchTxQuery(r.node, targetOf(t))).length,
    wins: transactions.filter((t) => parsedRules.find((x) => matchTxQuery(x.node, targetOf(t)))?.query === r.query).length,
}));

// A fetched booking no rule matches got its category by hand
for (const t of transactions) {
    if (t.categorySource === "rule" && !parsedRules.some((r) => matchTxQuery(r.node, targetOf(t)))) t.categorySource = "manual";
}

// ---------- Queries the client sends ----------

/** Accounts of a scope: one account, a group with its subgroups, or all. */
export function accountsInScope(scope: string): number[] {
    if (scope === "all") return accounts.map((a) => a.id);
    const [kind, raw] = scope.split(":");
    const id = Number(raw);
    if (kind === "account") return accounts.some((a) => a.id === id) ? [id] : [];
    const below = new Set([id]);
    for (let grew = true; grew; ) {
        grew = false;
        for (const g of groups) {
            if (g.parentId !== null && below.has(g.parentId) && !below.has(g.id)) {
                below.add(g.id);
                grew = true;
            }
        }
    }
    return accounts.filter((a) => a.groupId !== null && below.has(a.groupId)).map((a) => a.id);
}

/** First and last day of a range, as the server reckons them (server/src/services/transactions.ts). */
export function rangeBounds(range: TxRange): { from: string | null; to: string | null } {
    const [y, m] = TODAY.split("-").map(Number) as [number, number];
    const iso = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
    switch (range) {
        case "month":
            return { from: iso(y, m, 1), to: null };
        case "last":
            return { from: iso(y, m - 1, 1), to: iso(y, m, 0) };
        case "30":
            return { from: addDaysIso(TODAY, -29), to: null };
        case "90":
            return { from: addDaysIso(TODAY, -89), to: null };
        case "365":
            return { from: addDaysIso(TODAY, -364), to: null };
        case "all":
            return { from: null, to: null };
    }
}

function categorySubtree(id: number): number[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const c of categories) if (c.parentId === out[i]) out.push(c.id);
    return out;
}

export interface TxQuery {
    scope: string;
    range?: TxRange;
    from?: string;
    to?: string;
    q?: string;
    category: string;
    dir: "all" | "in" | "out";
    pending?: boolean;
    deleted?: boolean;
    limit: number;
}

export function listTransactions(f: TxQuery) {
    const ids = new Set(accountsInScope(f.scope));
    const bounds = f.range ? rangeBounds(f.range) : { from: null, to: null };
    const from = f.from ?? bounds.from;
    const to = f.to ?? bounds.to;
    let rows = (f.deleted ? deletedTransactions : transactions).filter((t) => ids.has(t.accountId) && (!from || t.bookingDate >= from) && (!to || t.bookingDate <= to));
    if (f.category !== "all") {
        const picked = f.category.split(",");
        const cats = new Set(picked.filter((x) => x !== "none").flatMap((x) => categorySubtree(Number(x))));
        rows = rows.filter((t) => (t.categoryId === null ? picked.includes("none") : cats.has(t.categoryId)));
    }
    if (f.dir === "in") rows = rows.filter((t) => t.amount > 0);
    if (f.dir === "out") rows = rows.filter((t) => t.amount < 0);
    if (f.pending) rows = rows.filter((t) => t.status === "pending");
    if (f.q) {
        const parsed = parseTxQuery(f.q.trim());
        if (parsed.ok && parsed.query) rows = rows.filter((t) => matchTxQuery(parsed.query, targetOf(t)));
    }
    return { items: rows.slice(0, f.limit), total: sumOf(rows), count: rows.length, truncated: rows.length > f.limit };
}

export function unreadCounts() {
    const per = new Map<number, number>();
    for (const t of transactions) if (t.unread) per.set(t.accountId, (per.get(t.accountId) ?? 0) + 1);
    return { accounts: [...per].map(([accountId, count]) => ({ accountId, count })), total: [...per.values()].reduce((s, n) => s + n, 0) };
}

const SERIES_MAX_DAYS = 730;

export function series(q: { scope: string; days: number; range?: TxRange; from?: string; to?: string; forecastDays: number }) {
    const ids = new Set(accountsInScope(q.scope));
    const own = transactions.filter((t) => ids.has(t.accountId));
    const first = own.reduce<string | null>((m, t) => (m === null || t.bookingDate < m ? t.bookingDate : m), null);
    const firstBooking = () => (first && first < TODAY ? first : addDaysIso(TODAY, -29));
    let from = addDaysIso(TODAY, -(q.days - 1));
    let to = TODAY;
    if (q.from || q.to) {
        to = q.to && q.to < TODAY ? q.to : TODAY;
        from = q.from ?? firstBooking();
        if (from < addDaysIso(to, -(SERIES_MAX_DAYS - 1))) from = addDaysIso(to, -(SERIES_MAX_DAYS - 1));
    } else if (q.range) {
        const b = rangeBounds(q.range);
        to = b.to ?? TODAY;
        from = b.from ?? firstBooking();
    }
    const balanceAt = (date: string) => [...ids].reduce((s, id) => s + startOf(id), 0) + sumOf(own.filter((t) => t.bookingDate <= date));
    const points: { date: string; balance: number }[] = [];
    for (let d = from; d <= to; d = addDaysIso(d, 1)) points.push({ date: d, balance: balanceAt(d) });
    const last = points.at(-1);
    return { points, forecast: q.forecastDays > 0 && last?.date === TODAY ? forecast([...ids], last.balance, q.forecastDays) : [] };
}

/** Income and expenses without own transfers (categories excluded from figures). */
const counts = (t: Transaction) => !categories.find((c) => c.id === t.categoryId)?.excludedFromStats;

export function cashflow(q: { scope: string; from: string; to: string }) {
    const ids = new Set(accountsInScope(q.scope));
    const rows = transactions.filter((t) => ids.has(t.accountId) && t.bookingDate >= q.from && t.bookingDate <= q.to && counts(t));
    return { income: sumOf(rows.filter((t) => t.amount > 0)), expenses: sumOf(rows.filter((t) => t.amount < 0)), count: rows.length };
}

/** Income and expenses per day over the days of the balance series, counted like the cashflow. */
export function flows(q: { scope: string; days: number; range?: TxRange; from?: string; to?: string; category?: string; dir?: "all" | "in" | "out" }) {
    const ids = new Set(accountsInScope(q.scope));
    let rows = transactions.filter((t) => ids.has(t.accountId));
    // Picked categories count even when left out of figures otherwise, as on the server
    if (q.category && q.category !== "all") {
        const picked = q.category.split(",");
        const cats = new Set(picked.filter((x) => x !== "none").flatMap((x) => categorySubtree(Number(x))));
        rows = rows.filter((t) => (t.categoryId === null ? picked.includes("none") : cats.has(t.categoryId)));
    } else rows = rows.filter(counts);
    if (q.dir === "in") rows = rows.filter((t) => t.amount > 0);
    if (q.dir === "out") rows = rows.filter((t) => t.amount < 0);
    return {
        points: series({ ...q, forecastDays: 0 }).points.map(({ date }) => {
            const day = rows.filter((t) => t.bookingDate === date);
            return { date, income: sumOf(day.filter((t) => t.amount > 0)), expenses: sumOf(day.filter((t) => t.amount < 0)) };
        }),
    };
}

export function categorySums(q: { scope: string; from: string; to: string }) {
    const ids = new Set(accountsInScope(q.scope));
    const per = new Map<number | null, { amount: number; count: number }>();
    for (const t of transactions) {
        if (!ids.has(t.accountId) || t.bookingDate < q.from || t.bookingDate > q.to) continue;
        const e = per.get(t.categoryId) ?? { amount: 0, count: 0 };
        e.amount += t.amount;
        e.count += 1;
        per.set(t.categoryId, e);
    }
    return { sums: [...per].map(([categoryId, e]) => ({ categoryId, ...e })) };
}

// ---------- Orders ----------

const FETCHED = at(TODAY, "09:29:20");

interface StandingSeed {
    id: number;
    accountId: number;
    payeeName: string;
    payeeIban: string;
    amount: number;
    remittance: string;
    payeeAccountId: number | null;
    unit: "month" | "week";
    every: number;
    executionDay: number;
    firstDate: string;
    lastDate: string | null;
}

const STANDING: StandingSeed[] = [
    { id: 1, accountId: GIRO, payeeName: "Hausverwaltung Lindenhof GmbH", payeeIban: IBAN.landlord, amount: 112000, remittance: "Miete Whg. 3. OG links", payeeAccountId: null, unit: "month", every: 1, executionDay: 1, firstDate: "2024-03-01", lastDate: null },
    { id: 2, accountId: GIRO, payeeName: "Alex Beispiel", payeeIban: "DE89370400440532013000", amount: 50000, remittance: "Sparrate", payeeAccountId: SAVINGS, unit: "month", every: 1, executionDay: 16, firstDate: "2025-01-16", lastDate: null },
    { id: 3, accountId: GIRO, payeeName: "TSV Musterstadt e. V.", payeeIban: "DE68210501700012345678", amount: 4500, remittance: "Mitgliedsbeitrag Quartal", payeeAccountId: null, unit: "month", every: 3, executionDay: 1, firstDate: "2025-01-01", lastDate: null },
    { id: 4, accountId: GIRO, payeeName: "Bausparkasse Fundament", payeeIban: "DE27100777770209299700", amount: 15000, remittance: "Bausparvertrag 88 123 456", payeeAccountId: null, unit: "month", every: 1, executionDay: 99, firstDate: "2025-06-30", lastDate: null },
];

export const orders: Order[] = [
    ...STANDING.map((s) => ({
        id: s.id,
        accountId: s.accountId,
        payeeName: s.payeeName,
        payeeIban: s.payeeIban,
        payeeBic: null,
        amount: s.amount,
        remittance: s.remittance,
        payeeAccountId: s.payeeAccountId,
        nextDate: nextStandingOrderDate(s, TODAY),
        bankOrderId: `DA-${s.id}`,
        canChange: true,
        canDelete: true,
        fetchedAt: FETCHED,
        kind: "standing" as const,
        unit: s.unit,
        every: s.every,
        executionDay: s.executionDay,
        firstDate: s.firstDate,
        lastDate: s.lastDate,
    })),
    {
        id: 5,
        accountId: GIRO,
        payeeName: "Autohaus Weber",
        payeeIban: "DE44500105175407324931",
        payeeBic: null,
        amount: 38000,
        remittance: "Winterreifen Auftrag 2211",
        payeeAccountId: null,
        nextDate: "2026-12-03",
        bankOrderId: "TU-5",
        canChange: true,
        canDelete: true,
        fetchedAt: FETCHED,
        kind: "scheduled" as const,
        executionDate: "2026-12-03",
    },
];

const writes = { createScheduled: true, changeScheduled: true, deleteScheduled: true, createStanding: true, changeStanding: true, deleteStanding: true };
export const orderAccounts = [GIRO, SAVINGS].map((accountId) => ({ accountId, standingOrders: true, scheduledTransfers: true, needsApproval: false, fetchedAt: FETCHED, ...writes }));

/** What a Sparkasse allows for orders: lead times, monthly rhythms only, every part but the unit changeable. */
const MONTH_DAYS = [...Array.from({ length: 30 }, (_, i) => i + 1), 99];
const ORDER_RULES = {
    scheduled: { minDays: 1, maxDays: 360 },
    scheduledChange: { minDays: 1, maxDays: 360 },
    standing: { minDays: 0, maxDays: 9999, months: [1, 2, 3, 6, 12], monthDays: MONTH_DAYS, weeks: [], weekDays: [] },
    standingChange: {
        minDays: 0, maxDays: 9999, months: [1, 2, 3, 6, 12], monthDays: MONTH_DAYS, weeks: [], weekDays: [],
        changeable: { payeeAccount: true, payeeName: true, amount: true, remittance: true, firstDate: true, unit: false, every: true, executionDay: true, lastDate: true },
    },
};

function runsOf(from: string, to: string) {
    const out: { date: string; order: Order }[] = [];
    for (const o of orders) {
        if (o.kind === "standing") for (const date of standingOrderDates(o, from, to)) out.push({ date, order: o });
        else if (o.executionDate >= from && o.executionDate <= to) out.push({ date: o.executionDate, order: o });
    }
    return out;
}

export function upcoming(q: { scope: string; days: number; count: number }) {
    const ids = new Set(accountsInScope(q.scope));
    const items = runsOf(TODAY, addDaysIso(TODAY, q.days))
        .filter((r) => ids.has(r.order.accountId))
        .map(({ date, order: o }) => ({ date, orderId: o.id, kind: o.kind, accountId: o.accountId, payeeName: o.payeeName, remittance: o.remittance, amount: o.amount, payeeAccountId: o.payeeAccountId }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.payeeName.localeCompare(b.payeeName, "de") || a.orderId - b.orderId);
    return { items: items.slice(0, q.count) };
}

function forecast(ids: number[], balance: number, days: number) {
    const inScope = new Set(ids);
    const deltas = new Map<string, number>();
    let any = false;
    for (const { date, order: o } of runsOf(addDaysIso(TODAY, 1), addDaysIso(TODAY, days))) {
        const payee = o.payeeAccountId;
        const delta = (inScope.has(o.accountId) ? -o.amount : 0) + (payee !== null && inScope.has(payee) ? o.amount : 0);
        if (inScope.has(o.accountId) || (payee !== null && inScope.has(payee))) any = true;
        deltas.set(date, (deltas.get(date) ?? 0) + delta);
    }
    if (!any) return [];
    const points: { date: string; balance: number }[] = [];
    for (let d = addDaysIso(TODAY, 1); d <= addDaysIso(TODAY, days); d = addDaysIso(d, 1)) {
        balance += deltas.get(d) ?? 0;
        points.push({ date: d, balance });
    }
    return points;
}

export function ordersInScope(scope: string) {
    const ids = new Set(accountsInScope(scope));
    return { orders: orders.filter((o) => ids.has(o.accountId)), accounts: orderAccounts.filter((a) => ids.has(a.accountId)) };
}

// ---------- Transfers ----------

export const transferAccounts = [
    { id: GIRO, name: "Girokonto", iban: "DE02120300000000202051", connectionName: "Sparkasse", instant: true, payeeVerification: true, pinRequired: false, transfer: true, scheduled: true, standing: true, orderRules: ORDER_RULES },
    { id: SAVINGS, name: "Tagesgeld", iban: "DE89370400440532013000", connectionName: "Sparkasse", instant: false, payeeVerification: true, pinRequired: false, transfer: true, scheduled: true, standing: true, orderRules: ORDER_RULES },
];

const transfer1 = (id: number, date: string, payeeName: string, payeeIban: string, amount: number, remittance: string, extra: object = {}) => ({
    id,
    accountId: GIRO,
    createdBy: "Alex",
    mine: true,
    payeeName,
    payeeIban,
    payeeBic: null,
    amount,
    remittance,
    endToEndId: `MBM${date.replace(/-/g, "")}${id}`,
    instant: false,
    execution: "now" as "now" | "date" | "standing",
    action: "create" as "create" | "change" | "delete",
    executionDate: null as string | null,
    recurrence: null as { firstDate: string; unit: "month" | "week"; every: number; executionDay: number; lastDate: string | null } | null,
    orderId: null as number | null,
    bankOrderId: null as string | null,
    previous: null,
    status: "executed" as const,
    vop: { result: "match" as const, payeeName: null, reason: null, explanation: "", structured: false },
    challenge: null,
    bankMessage: "Auftrag ausgeführt.",
    bankReference: null,
    unconfirmed: false,
    transactionId: null,
    createdAt: at(date, "18:12:00"),
    finishedAt: at(date, "18:12:40"),
    ...extra,
});

export const transfers = [
    transfer1(4, "2026-11-18", "Elektro Funke GmbH", "DE08500105175658541611", 14280, "Rechnung RE-2026-1187", { instant: true }),
    transfer1(5, "2026-11-12", "Autohaus Weber", "DE44500105175407324931", 38000, "Winterreifen Auftrag 2211", {
        execution: "date",
        executionDate: "2026-12-03",
        orderId: 5,
        bankOrderId: "TU-5",
        bankMessage: "Auftrag zur Ausführung vorgemerkt.",
    }),
    transfer1(3, "2026-11-03", "Kita Sonnenschein", "DE13500105179211312312", 6500, "Essensgeld November", { createdBy: "Sam", mine: false }),
    transfer1(2, "2026-10-21", "Mia Muster", "DE44500105179438371294", 3200, "Konzertkarte", { vop: { result: "close_match", payeeName: "Mia Mustermann", reason: null, explanation: "", structured: false } }),
    transfer1(1, "2026-10-02", "Zahnarztpraxis Dr. Lächeln", "DE06500105178386297562", 8915, "Rechnung 2026-0912"),
];

export const transferPayees = {
    payees: [
        { id: 1, name: "Elektro Funke GmbH", iban: "DE08500105175658541611", bic: null, lastUsedAt: at("2026-11-18", "18:12:00") },
        { id: 2, name: "Kita Sonnenschein", iban: "DE13500105179211312312", bic: null, lastUsedAt: at("2026-11-03", "18:12:00") },
        { id: 3, name: "Mia Muster", iban: "DE44500105179438371294", bic: null, lastUsedAt: at("2026-10-21", "18:12:00") },
        { id: 4, name: "Zahnarztpraxis Dr. Lächeln", iban: "DE06500105178386297562", bic: null, lastUsedAt: at("2026-10-02", "18:12:00") },
    ],
    suggestions: [
        { name: "Stadtwerke Musterstadt", iban: IBAN.utility, bic: null, lastDate: "2026-11-02" },
        { name: "Versicherung Zuversicht AG", iban: IBAN.insurance, bic: null, lastDate: "2026-11-05" },
    ],
};

export function payees() {
    const seen = new Map<string, { name: string; iban: string | null; uses: number }>();
    for (const t of transactions) {
        const key = t.counterpartyName;
        const e = seen.get(key) ?? { name: t.counterpartyName, iban: t.counterpartyIban, uses: 0 };
        e.uses += 1;
        seen.set(key, e);
    }
    return [...seen.values()].sort((a, b) => b.uses - a.uses);
}

// ---------- Imports and activity ----------

export const importFormats = BUILTIN_IMPORT_FORMATS.map((f) => ({ key: f.key, id: null, name: f.name, builtin: true, definition: f.definition }));

// The invented file and preview of the import pictures
const SAMPLE_HEADER = ["Datum", "Wertstellung", "Kategorie", "Name", "Verwendungszweck", "Konto", "Bank", "Betrag", "Währung"];
const SAMPLE_IBAN = "DE02120300000000202051";
export const importSampleCsv = [
    SAMPLE_HEADER.join(";"),
    `18.11.2026;18.11.2026;;Hausverwaltung Lindenhof GmbH;Miete November, Umsatzart: Dauerauftrag, Referenz: MIETE-2026-11, Mandat: LH-4711;${SAMPLE_IBAN};BYLADEM1001;-950,00;EUR`,
    `17.11.2026;17.11.2026;;Frischemarkt;Umsatzart: Kartenzahlung;${SAMPLE_IBAN};BYLADEM1001;-42,18;EUR`,
    "",
].join("\n");

const previewRow = (line: number, date: string | null, amount: number | null, name: string, purpose: string, bookingText: string, over: Partial<ImportPreview["rows"][number]> = {}): ImportPreview["rows"][number] => ({
    line,
    date,
    amount,
    name,
    iban: SAMPLE_IBAN,
    counterpartyAccount: "",
    counterpartyBankCode: "",
    purpose,
    shownName: null,
    shownPurpose: null,
    bookingText,
    fillsBookingText: false,
    reference: "",
    customerReference: "",
    bankReference: "",
    mandateId: "",
    creditorId: "",
    counterpartyBic: "BYLADEM1001",
    fillsDetails: false,
    fills: [],
    pending: false,
    categoryId: null,
    newCategory: null,
    state: "new",
    storedCategoryId: null,
    categoryState: null,
    error: null,
    ...over,
});

const samplePreviewRows = [
    previewRow(1, "2026-11-18", -95000, "Hausverwaltung Lindenhof GmbH", "Miete November", "Dauerauftrag", { reference: "MIETE-2026-11", mandateId: "LH-4711" }),
    previewRow(2, "2026-11-17", -4218, "Frischemarkt", "", "Kartenzahlung"),
    previewRow(3, "2026-11-16", -1899, "Versandhaus Nordlicht", "Bestellung 20418", "Lastschrift"),
    previewRow(4, "2026-11-14", 320000, "Muster AG", "Gehalt November", "Lohn/Gehalt", { state: "duplicate", fillsBookingText: true, fills: ["bookingText"] }),
    previewRow(5, "2026-11-12", -6400, "Stadtwerke", "Abschlag November", "Lastschrift", { state: "duplicate", fillsDetails: true, fills: ["reference"], reference: "SW-2026-11" }),
    previewRow(6, "2026-11-10", -2750, "Buchhandlung am Markt", "Rechnung 881", "Überweisung", { state: "duplicate" }),
    previewRow(7, "2026-11-09", -1490, "Frischemarkt", "Wocheneinkauf", "Kartenzahlung", { state: "duplicate", categoryState: "empty", categoryId: cat("Supermarkt") }),
    previewRow(8, "2026-11-08", -3250, "Kaufhaus Mitte", "Bon 5521", "Kartenzahlung", { state: "duplicate", categoryState: "differs", storedCategoryId: cat("Supermarkt"), categoryId: cat("Miete") }),
    previewRow(9, null, -1200, "Unbekannt", "", "Lastschrift", { state: "invalid", error: "Datum „32.11.2026“ nicht lesbar" }),
];

const sampleFormat = BUILTIN_IMPORT_FORMATS.find((f) => f.key === "builtin:moneymoney")!.definition;

export const importPreview: ImportPreview = {
    header: SAMPLE_HEADER,
    columns: columnsFromFormat(sampleFormat, SAMPLE_HEADER),
    format: sampleFormat,
    formatKey: "builtin:moneymoney",
    rows: samplePreviewRows,
    newCategories: [],
    counts: { new: 3, duplicate: 5, invalid: 1, differs: 1, filled: 3 },
};

export const imports = [
    { id: 1, accountId: CASH, fileName: "kassenbuch-2026.csv", importedAt: at("2026-05-02", "17:52:00"), userName: "Alex", rows: 48, imported: 46, skipped: 2, remaining: 46 },
];

const ACTIVITY: [string, string, string, string | null, string | null][] = [
    [at(TODAY, "09:28:00"), "Alex", "login", null, "Firefox auf macOS"],
    [at(TODAY, "06:58:00"), "Alex", "unlock", null, null],
    [at("2026-11-19", "19:05:00"), "Sam", "login", null, "Chrome auf Windows"],
    [at("2026-11-15", "11:20:00"), "Alex", "reconcile", "Bargeld", null],
    [at("2026-11-14", "16:02:00"), "Alex", "counter_booking", "Bargeld", null],
    [at("2026-11-01", "12:00:00"), "Alex", "device_created", "MacBook", null],
    [at("2026-05-02", "17:52:00"), "Alex", "import", "Bargeld", "kassenbuch-2026.csv"],
    [at("2026-05-02", "17:40:00"), "Alex", "user_created", "Sam", null],
    [at("2026-05-02", "17:12:00"), "Alex", "setup", null, null],
];

export const activity = ACTIVITY.map(([createdAt, userName, action, target, details], i) => ({
    id: ACTIVITY.length - i,
    createdAt,
    userId: userName === "Alex" ? 1 : 2,
    userName,
    action,
    target,
    details,
}));

// ---------- Profile ----------

export function profile(theme: "dark" | "light") {
    return {
        settings: { theme, hideAmountsOnStart: false },
        // With every option written out, as the server stores a card
        cards: DEFAULT_CARDS.map((c, i) => ({ id: i + 1, position: i, type: c.type, width: c.width, height: null, title: null, config: CARD_CONFIGS[c.type].parse({}) })),
    };
}

// ---------- What the bank offered at the last account list ----------

const caps = (giro: boolean, card = false) => ({
    balance: true,
    transactions: !card,
    cardTransactions: card,
    transfer: giro,
    instantTransfer: giro,
    standingOrders: !card,
    scheduledTransfers: !card,
    standingOrdersTan: false,
    scheduledTransfersTan: false,
    payeeVerification: !card,
});

export const offeredAccounts = {
    accounts: [
        { externalId: "DE02120300000000202051", name: "Girokonto", iban: "DE02120300000000202051", cardNumber: null, owner: "Alex Beispiel", currency: "EUR", kind: "giro" as const, supported: true, capabilities: caps(true), accountId: GIRO, linked: true, ignored: false },
        { externalId: "4910123412341234", name: "Kreditkarte", iban: null, cardNumber: "4910 •••• •••• 1234", owner: "Alex Beispiel", currency: "EUR", kind: "credit_card" as const, supported: true, capabilities: caps(false, true), accountId: CARD, linked: true, ignored: false },
        { externalId: "DE89370400440532013000", name: "Tagesgeld", iban: "DE89370400440532013000", cardNumber: null, owner: "Alex Beispiel", currency: "EUR", kind: "savings" as const, supported: true, capabilities: caps(true), accountId: SAVINGS, linked: true, ignored: false },
        { externalId: "7001234567", name: "Depot", iban: null, cardNumber: null, owner: "Alex Beispiel", currency: "EUR", kind: "depot" as const, supported: false, capabilities: { ...caps(false), transactions: false, standingOrders: false, scheduledTransfers: false, payeeVerification: false }, accountId: null, linked: false, ignored: true },
    ],
    fetchedAt: at("2026-05-02", "17:25:00"),
};
/** The account list of the PayPal access (PSD2). */
export const paypalOfferedAccounts = {
    accounts: [
        { externalId: "PAYPALACCOUNT00000000000001", name: "PayPal", iban: null, cardNumber: null, owner: "Alex Beispiel", currency: "EUR", kind: "giro" as const, supported: true, capabilities: caps(false), accountId: PAYPAL, linked: true, ignored: false },
    ],
    fetchedAt: at("2026-11-15", "09:31:00"),
};


// Every IBAN above has to pass the client's own check, or a form in a screenshot shows an error
{
    const all = [...connections.map((c) => c.blz), ...accounts.map((a) => a.iban), ...transactions.map((t) => t.counterpartyIban), ...orders.map((o) => o.payeeIban), ...transferPayees.payees.map((p) => p.iban), ...transferPayees.suggestions.map((p) => p.iban), ...transfers.map((t) => t.payeeIban)];
    for (const iban of all.filter((x): x is string => !!x && x.startsWith("DE"))) {
        const problem = ibanProblem(iban);
        if (problem) throw new Error(`fixtures: IBAN ${iban}: ${problem}`);
    }
}

/** The bank directory, as far as the forms look a bank up: invented names for the codes above. */
export function searchBanks(q: string) {
    const blz = q.replace(/\s/g, "");
    return /^\d{8}$/.test(blz) ? [{ blz, name: "Beispielbank", place: "Musterstadt", bic: "BEISDEM1XXX" }] : [];
}
