import type { LucideIcon, LucideProps } from "lucide-react";
import {
    Apple, ArrowLeftRight, Baby, Banknote, Bike, BookOpen, Briefcase, Bus, CalendarClock, Camera, Car, CarFront, Cat,
    ChartLine, CirclePlay, Coffee, Coins, CreditCard, Croissant, Dog, Droplets, Dumbbell, Euro, Flame, Folder, Fuel,
    Gamepad2, Gift, GraduationCap, HandCoins, Heart, HeartPulse, House, KeyRound, Lamp, Landmark, Layers, Music, Package,
    PartyPopper, Percent, PiggyBank, Pill, PillBottle, Pizza, Plane, Receipt, Scissors, ShieldCheck, Shirt, ShoppingBag,
    ShoppingBasket, ShoppingCart, Smartphone, Sofa, SquareParking, Star, Stethoscope, Store, Tag, Ticket, TrainFront,
    TreePalm, Tv, Undo2, User, Users, Utensils, Wallet, WalletCards, Wifi, Wine, Wrench, Zap,
} from "lucide-react";
import type { CategoryIndex } from "../lib/tree";
import { categoryColor } from "../lib/tree";

/** Lucide symbol per stored icon key (see shared/src/symbols.ts). */
const SYMBOLS: Record<string, LucideIcon> = {
    wallet: Wallet, "wallet-cards": WalletCards, "credit-card": CreditCard, banknote: Banknote, coins: Coins,
    "piggy-bank": PiggyBank, landmark: Landmark, "hand-coins": HandCoins, percent: Percent, receipt: Receipt,
    briefcase: Briefcase, euro: Euro, "chart-line": ChartLine, "arrow-left-right": ArrowLeftRight, "undo-2": Undo2,
    house: House, "key-round": KeyRound, zap: Zap, flame: Flame, droplets: Droplets, sofa: Sofa, lamp: Lamp,
    wrench: Wrench, "shield-check": ShieldCheck, wifi: Wifi, smartphone: Smartphone, tv: Tv,
    "shopping-cart": ShoppingCart, "shopping-basket": ShoppingBasket, croissant: Croissant, utensils: Utensils,
    coffee: Coffee, pizza: Pizza, wine: Wine, apple: Apple, car: Car, "car-front": CarFront, fuel: Fuel,
    "train-front": TrainFront, bus: Bus, bike: Bike, plane: Plane, "square-parking": SquareParking, ticket: Ticket,
    "circle-play": CirclePlay, music: Music, "tree-palm": TreePalm, gift: Gift, dumbbell: Dumbbell,
    "book-open": BookOpen, "gamepad-2": Gamepad2, camera: Camera, "party-popper": PartyPopper,
    "shopping-bag": ShoppingBag, package: Package, shirt: Shirt, "pill-bottle": PillBottle, scissors: Scissors,
    "calendar-clock": CalendarClock, store: Store, "heart-pulse": HeartPulse, stethoscope: Stethoscope, pill: Pill,
    users: Users, user: User, baby: Baby, dog: Dog, cat: Cat, "graduation-cap": GraduationCap, folder: Folder,
    layers: Layers, tag: Tag, star: Star, heart: Heart,
};

/** A UI icon with the stroke of the design. */
export function Ic({ icon: Icon, size = 18, strokeWidth = 1.75, ...rest }: { icon: LucideIcon } & LucideProps) {
    return <Icon className="ic" size={size} strokeWidth={strokeWidth} aria-hidden="true" {...rest} />;
}

/** A chosen symbol of an account, group or category. */
export function Sym({ name, size = 18 }: { name: string; size?: number }) {
    const Icon = SYMBOLS[name] ?? Tag;
    return <Icon className="syi" size={size} strokeWidth={1.9} aria-hidden="true" />;
}

/** Tile with symbol in the chosen colour. */
export function Tile({ icon, color, size = 14, className = "" }: { icon: string; color: string; size?: number; className?: string }) {
    return (
        <span className={`acc-ic tone k-${color || "neutral"} ${className}`} aria-hidden="true">
            <Sym name={icon} size={size} />
        </span>
    );
}

/** Tile of a category; without category a dashed question mark. */
export function CatTile({ idx, id, size = 14, className = "" }: { idx: CategoryIndex; id: number | null; size?: number; className?: string }) {
    const c = id !== null ? idx.byId.get(id) : undefined;
    if (!c) return <span className={`acc-ic sym-none ${className}`} aria-hidden="true">?</span>;
    return <Tile icon={c.icon} color={categoryColor(idx, id)} size={size} className={className} />;
}

/** The MBM mark. */
export function Mark({ size = 18 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 9.5 12 4.5l8.5 5" />
            <path d="M6.5 12v5.5M10.2 12v5.5M13.8 12v5.5M17.5 12v5.5" />
            <path d="M4 20.5h16" />
        </svg>
    );
}
