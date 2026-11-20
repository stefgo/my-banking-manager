import type { ColorKey, IconKey } from "./symbols.js";

export interface DefaultCategory {
    name: string;
    icon: IconKey;
    color?: ColorKey;
    /** Starts as the preset category of counter bookings; the user can move the preset or drop it. */
    counterDefault?: boolean;
    excludedFromStats?: boolean;
    children?: { name: string; icon: IconKey }[];
}

/** The category tree a new installation starts with. Every name, symbol and colour can be changed. */
export const DEFAULT_CATEGORIES: DefaultCategory[] = [
    {
        name: "Einkommen",
        icon: "coins",
        color: "green",
        children: [
            { name: "Gehalt", icon: "briefcase" },
            { name: "Haushaltsbeitrag", icon: "hand-coins" },
            { name: "Zinsen", icon: "percent" },
            { name: "Erstattungen", icon: "undo-2" },
        ],
    },
    {
        name: "Wohnen",
        icon: "house",
        color: "violet",
        children: [
            { name: "Miete", icon: "key-round" },
            { name: "Energie", icon: "zap" },
            { name: "Versicherungen", icon: "shield-check" },
            { name: "Gebühren & Beiträge", icon: "receipt" },
            { name: "Einrichtung", icon: "sofa" },
        ],
    },
    {
        name: "Lebensmittel",
        icon: "shopping-cart",
        color: "amber",
        children: [
            { name: "Supermarkt", icon: "shopping-basket" },
            { name: "Bäckerei", icon: "croissant" },
        ],
    },
    {
        name: "Mobilität",
        icon: "car",
        color: "teal",
        children: [
            { name: "Tanken", icon: "fuel" },
            { name: "Bahn", icon: "train-front" },
            { name: "Fahrzeugfinanzierung", icon: "car-front" },
        ],
    },
    {
        name: "Freizeit",
        icon: "ticket",
        color: "pink",
        children: [
            { name: "Streaming & Musik", icon: "circle-play" },
            { name: "Konzerte & Events", icon: "music" },
            { name: "Urlaub", icon: "tree-palm" },
            { name: "Geschenke", icon: "gift" },
        ],
    },
    {
        name: "Einkaufen",
        icon: "shopping-bag",
        color: "blue",
        children: [
            { name: "Online-Handel", icon: "package" },
            { name: "Ratenkauf", icon: "calendar-clock" },
            { name: "Drogerie", icon: "pill-bottle" },
        ],
    },
    { name: "Bargeld", icon: "banknote", color: "neutral" },
    { name: "Umbuchung", icon: "arrow-left-right", color: "neutral", counterDefault: true, excludedFromStats: true },
];

/** The account groups a new installation starts with. */
export const DEFAULT_ACCOUNT_GROUPS: { name: string; icon: IconKey; color: ColorKey; children?: { name: string; icon: IconKey; color: ColorKey }[] }[] = [
    {
        name: "Privat",
        icon: "user",
        color: "neutral",
        children: [
            { name: "Alltag", icon: "wallet-cards", color: "neutral" },
            { name: "Rücklagen", icon: "layers", color: "neutral" },
        ],
    },
];
