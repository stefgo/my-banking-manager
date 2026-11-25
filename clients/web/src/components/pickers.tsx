import { useMemo, useState, type ReactNode } from "react";
import { DropdownMenu, Popover } from "radix-ui";
import { Check, ChevronDown, Search, type LucideIcon } from "lucide-react";
import { COLORS, ICON_GROUPS } from "@mbm/shared";
import type { PickItem } from "./pickItems";
import { Ic, Sym, Tile } from "./icons";
import { MAX_INDENT } from "../lib/tree";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");


/**
 * A searchable list in a popover; arrow keys move, Enter picks. With `selected` it checks several
 * values and stays open, so each pick toggles one.
 */
export function Picker({
    trigger,
    items,
    value,
    selected,
    onPick,
    placeholder = "Suchen …",
    open: openProp,
    onOpenChange,
}: {
    trigger: ReactNode;
    items: PickItem[];
    value?: string;
    selected?: string[];
    onPick: (value: string) => void;
    placeholder?: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}) {
    const [openState, setOpenState] = useState(false);
    const open = openProp ?? openState;
    const setOpen = (o: boolean) => {
        setOpenState(o);
        onOpenChange?.(o);
        if (!o) setQ("");
    };
    const [q, setQ] = useState("");
    const [i, setI] = useState(0);
    const shown = useMemo(() => {
        const nq = fold(q.trim());
        return nq ? items.filter((x) => fold(`${x.label} ${x.search ?? ""}`).includes(nq)).map((x) => ({ ...x, depth: 0 })) : items;
    }, [items, q]);
    const pick = (v: string) => {
        if (!selected) setOpen(false);
        onPick(v);
    };
    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            <Popover.Portal>
                {/* React bubbles events through portals: a click here must not reach a clickable ancestor of the trigger (e.g. a transaction row) */}
                <Popover.Content className="pop-content" align="start" sideOffset={6} collisionPadding={12} onClick={(e) => e.stopPropagation()}>
                    <div className="pop" role="dialog">
                        <label className="pop-in">
                            <Ic icon={Search} size={15} />
                            <input
                                autoFocus
                                value={q}
                                placeholder={placeholder}
                                aria-label={placeholder}
                                onChange={(e) => {
                                    setQ(e.target.value);
                                    setI(0);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === "ArrowDown") {
                                        e.preventDefault();
                                        setI((n) => Math.min(n + 1, shown.length - 1));
                                    } else if (e.key === "ArrowUp") {
                                        e.preventDefault();
                                        setI((n) => Math.max(n - 1, 0));
                                    } else if (e.key === "Enter" && shown[i]) {
                                        e.preventDefault();
                                        pick(shown[i]!.value);
                                    }
                                }}
                            />
                        </label>
                        <div className="pop-list" role="listbox">
                            {shown.length === 0 && <div className="muted small" style={{ padding: "10px" }}>Nichts gefunden</div>}
                            {shown.map((x, n) => (
                                <button
                                    key={x.value}
                                    type="button"
                                    role="option"
                                    aria-selected={n === i}
                                    aria-checked={selected ? selected.includes(x.value) : x.value === value}
                                    className={`pop-item ${n === i ? "on" : ""} ${x.top ? "top" : ""}`}
                                    style={{ "--d": Math.min(x.depth ?? 0, MAX_INDENT) } as React.CSSProperties}
                                    onMouseEnter={() => setI(n)}
                                    onClick={() => pick(x.value)}
                                >
                                    {x.icon}
                                    <span>{x.label}</span>
                                    {x.hint && <small>{x.hint}</small>}
                                </button>
                            ))}
                        </div>
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

/** Trigger of a picker: symbol, current value and a chevron; `set` highlights a chosen value. */
export function PickerButton({ icon, set = false, className = "", children, ...rest }: { icon?: ReactNode; set?: boolean } & React.ComponentProps<"button">) {
    return (
        <button type="button" className={`picker-btn ${set ? "set" : ""} ${className}`} {...rest}>
            {icon}
            {children}
            <Ic icon={ChevronDown} size={14} />
        </button>
    );
}

/** A short fixed list in a dropdown menu; the trigger shows the current choice. */
export function Choice<T extends string>({
    icon,
    label,
    options,
    value,
    set = false,
    display,
    onPick,
}: {
    icon: LucideIcon;
    label: string;
    options: { value: T; label: string }[];
    value: T;
    /** Highlights the trigger like an active filter. */
    set?: boolean;
    /** Text of the trigger instead of the label of the current option. */
    display?: string;
    onPick: (value: T) => void;
}) {
    const current = display ?? options.find((o) => o.value === value)?.label ?? "";
    return (
        <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger className={`picker-btn ${set ? "set" : ""}`} aria-label={`${label}: ${current}`}>
                <Ic icon={icon} size={15} />
                {current}
                <Ic icon={ChevronDown} size={14} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu-content" align="start" sideOffset={6} collisionPadding={12}>
                    <div className="menu-label">{label}</div>
                    {options.map((o) => (
                        <DropdownMenu.Item key={o.value} aria-checked={o.value === value} onSelect={() => onPick(o.value)}>
                            {o.label}
                            {o.value === value && (
                                <span className="menu-check">
                                    <Ic icon={Check} size={15} />
                                </span>
                            )}
                        </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

/**
 * Symbol and colour chooser. `inheritColor` offers "wie Hauptkategorie". `side="right"` suits rows
 * in a tall list: beside its anchor the popover can shift vertically to stay in the window.
 */
export function StylePicker({
    side = "bottom",
    trigger,
    name,
    kindName,
    icon,
    color,
    inheritColor,
    onChange,
    open,
    onOpenChange,
}: {
    side?: "bottom" | "right";
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    trigger: ReactNode;
    name: string;
    kindName: string;
    icon: string;
    color: string | null;
    inheritColor?: string;
    onChange: (patch: { icon?: string; color?: string | null }) => void;
}) {
    const [q, setQ] = useState("");
    const eff = color ?? inheritColor ?? "neutral";
    const nq = fold(q.trim());
    return (
        <Popover.Root
            open={open}
            onOpenChange={(o) => {
                if (!o) setQ("");
                onOpenChange?.(o);
            }}
        >
            {/* Controlled from a menu: the symbol is only the anchor, a click on it does not open */}
            {open === undefined ? <Popover.Trigger asChild>{trigger}</Popover.Trigger> : <Popover.Anchor asChild>{trigger}</Popover.Anchor>}
            <Popover.Portal>
                <Popover.Content className="pop-content" side={side} align="start" sideOffset={6} collisionPadding={12}>
                    <div className="pop sty" role="dialog" aria-label="Symbol und Farbe">
                        <div className="sty-head">
                            <Tile icon={icon} color={eff} size={20} />
                            <span>
                                <b>{name}</b>
                                <small>{kindName}</small>
                            </span>
                        </div>
                        <div className="sty-sec">
                            <span className="label">Farbe</span>
                            <div className="swatches">
                                {inheritColor && (
                                    <button
                                        type="button"
                                        className={`sw inherit k-${inheritColor}`}
                                        aria-pressed={color === null}
                                        title="Wie Hauptkategorie"
                                        aria-label="Wie Hauptkategorie"
                                        onClick={() => onChange({ color: null })}
                                    />
                                )}
                                {COLORS.map(([k, label]) => (
                                    <button key={k} type="button" className={`sw k-${k}`} aria-pressed={color === k} title={label} aria-label={label} onClick={() => onChange({ color: k })}>
                                        {color === k && <Ic icon={Check} size={13} strokeWidth={2.6} />}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <label className="pop-in sty-search">
                            <Ic icon={Search} size={15} />
                            <input autoFocus placeholder="Symbol suchen …" aria-label="Symbol suchen" value={q} onChange={(e) => setQ(e.target.value)} />
                        </label>
                        <div className="sty-grid">
                            {ICON_GROUPS.map((g) => {
                                const hits = g.icons.filter(([k, l]) => !nq || fold(`${k} ${l} ${g.name}`).includes(nq));
                                if (!hits.length) return null;
                                return (
                                    <div key={g.name}>
                                        <span className="label">{g.name}</span>
                                        <div className="sy-row">
                                            {hits.map(([k, l]) => (
                                                <button key={k} type="button" className={`sy k-${eff}`} aria-pressed={icon === k} title={l.split(" ")[0]} aria-label={l.split(" ")[0]} onClick={() => onChange({ icon: k })}>
                                                    <Sym name={k} size={18} />
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

