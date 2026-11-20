// Symbols and colours of accounts, groups and categories. Only the key is stored; the web client
// draws Lucide icons, the macOS client SF Symbols. Every colour has a light and a dark tone in
// the clients.

export const ICON_GROUPS = [
    {
        name: "Geld",
        icons: [
            ["wallet", "Brieftasche Girokonto"],
            ["wallet-cards", "Karten Alltag"],
            ["credit-card", "Kreditkarte"],
            ["banknote", "Geldschein Bargeld"],
            ["coins", "Münzen Einkommen"],
            ["piggy-bank", "Sparschwein Sparen Tagesgeld Rücklagen"],
            ["landmark", "Bank"],
            ["hand-coins", "Zahlung Beitrag"],
            ["percent", "Zinsen Prozent"],
            ["receipt", "Beleg Gebühren"],
            ["briefcase", "Arbeit Gehalt"],
            ["euro", "Euro"],
            ["chart-line", "Depot Anlage"],
            ["arrow-left-right", "Umbuchung Transfer"],
            ["undo-2", "Erstattung zurück"],
        ],
    },
    {
        name: "Wohnen",
        icons: [
            ["house", "Haus Wohnen Haushalt"],
            ["key-round", "Schlüssel Miete"],
            ["zap", "Strom Energie"],
            ["flame", "Heizung Gas"],
            ["droplets", "Wasser"],
            ["sofa", "Möbel Einrichtung"],
            ["lamp", "Lampe"],
            ["wrench", "Reparatur Handwerker"],
            ["shield-check", "Versicherung"],
            ["wifi", "Internet"],
            ["smartphone", "Handy Telefon"],
            ["tv", "Fernsehen Rundfunk"],
        ],
    },
    {
        name: "Essen",
        icons: [
            ["shopping-cart", "Einkaufswagen Lebensmittel"],
            ["shopping-basket", "Korb Supermarkt"],
            ["croissant", "Bäckerei"],
            ["utensils", "Restaurant Essen"],
            ["coffee", "Kaffee Café"],
            ["pizza", "Pizza Lieferdienst"],
            ["wine", "Wein Getränke"],
            ["apple", "Obst Markt"],
        ],
    },
    {
        name: "Mobilität",
        icons: [
            ["car", "Auto Mobilität"],
            ["car-front", "Fahrzeug Finanzierung"],
            ["fuel", "Tanken Zapfsäule"],
            ["train-front", "Bahn Zug"],
            ["bus", "Bus Nahverkehr"],
            ["bike", "Fahrrad"],
            ["plane", "Flug Reise"],
            ["square-parking", "Parken"],
        ],
    },
    {
        name: "Freizeit",
        icons: [
            ["ticket", "Ticket Freizeit"],
            ["circle-play", "Streaming Video"],
            ["music", "Musik Konzerte"],
            ["tree-palm", "Urlaub Palme"],
            ["gift", "Geschenk"],
            ["dumbbell", "Sport Fitness"],
            ["book-open", "Buch Bildung"],
            ["gamepad-2", "Spiele"],
            ["camera", "Foto"],
            ["party-popper", "Feier Party"],
        ],
    },
    {
        name: "Einkaufen",
        icons: [
            ["shopping-bag", "Tasche Einkaufen"],
            ["package", "Paket Online"],
            ["shirt", "Kleidung"],
            ["pill-bottle", "Drogerie"],
            ["scissors", "Friseur"],
            ["calendar-clock", "Raten Ratenkauf Abo"],
            ["store", "Laden Geschäft"],
        ],
    },
    {
        name: "Gesundheit & Familie",
        icons: [
            ["heart-pulse", "Gesundheit"],
            ["stethoscope", "Arzt"],
            ["pill", "Apotheke Medikamente"],
            ["users", "Gemeinsam Familie"],
            ["user", "Person Privat"],
            ["baby", "Kind Baby"],
            ["dog", "Hund Haustier"],
            ["cat", "Katze Haustier"],
            ["graduation-cap", "Schule Studium"],
        ],
    },
    {
        name: "Sonstiges",
        icons: [
            ["folder", "Ordner Gruppe"],
            ["layers", "Stapel Rücklagen Gruppe"],
            ["tag", "Etikett Kategorie"],
            ["star", "Stern"],
            ["heart", "Herz Spende"],
        ],
    },
] as const satisfies readonly { name: string; icons: readonly (readonly [string, string])[] }[];

export type IconKey = (typeof ICON_GROUPS)[number]["icons"][number][0];

export const ICON_KEYS = ICON_GROUPS.flatMap((g) => g.icons.map(([key]) => key)) as IconKey[];

export const COLORS = [
    ["violet", "Violett"],
    ["indigo", "Indigo"],
    ["blue", "Blau"],
    ["sky", "Himmelblau"],
    ["teal", "Türkis"],
    ["green", "Grün"],
    ["lime", "Limette"],
    ["amber", "Bernstein"],
    ["orange", "Orange"],
    ["red", "Rot"],
    ["pink", "Rosa"],
    ["magenta", "Magenta"],
    ["neutral", "Neutral"],
] as const;

export type ColorKey = (typeof COLORS)[number][0];

export const COLOR_KEYS = COLORS.map(([key]) => key) as ColorKey[];

/** The twelve colours a new top-level category takes in turn (neutral is left out). */
export const ROTATING_COLORS = COLOR_KEYS.filter((c) => c !== "neutral");
