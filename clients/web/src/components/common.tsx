import { useState, type ReactNode } from "react";
import { Dialog as RDialog } from "radix-ui";
import { AlertTriangle, Check, Info, Landmark, Plus, Search, X, type LucideIcon } from "lucide-react";
import { fmt, fmtSigned, splitAmount } from "../lib/format";
import { ui, useUi } from "../lib/ui";
import { badgeText, unreadLabel } from "../lib/unread";
import { Ic } from "./icons";

/** Number of new bookings as a small pill; nothing without any. */
export function NewBadge({ count, className = "" }: { count: number; className?: string }) {
    if (count <= 0) return null;
    return (
        <span className={`badge-new ${className}`} title={unreadLabel(count)}>
            <span aria-hidden="true">{badgeText(count)}</span>
            <span className="sr-only">{unreadLabel(count)}</span>
        </span>
    );
}

/** An amount; blurred while amounts are hidden (H). */
export function Amt({ cents, signed = false, className = "", as: As = "span" }: { cents: number; signed?: boolean; className?: string; as?: "span" | "b" }) {
    return <As className={`amt ${signed && cents > 0 ? "pos" : ""} ${className}`}>{signed ? fmtSigned(cents) : fmt(cents)}</As>;
}

export function BigAmount({ cents, className = "" }: { cents: number; className?: string }) {
    const [main, dec] = splitAmount(cents);
    return (
        <div className={`amt ${className}`}>
            {main}
            <span className="dec">{dec}</span>
        </div>
    );
}

/** Dialog: scrim, card, title with close button. */
export function Modal({
    title,
    children,
    onClose,
    narrow = false,
    wide = false,
    labelOnly = false,
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    narrow?: boolean;
    wide?: boolean;
    labelOnly?: boolean;
}) {
    return (
        <RDialog.Root open onOpenChange={(open) => !open && onClose()}>
            <RDialog.Portal>
                <div className="modal-wrap">
                    <RDialog.Overlay className="scrim" />
                    <RDialog.Content className={`modal ${narrow ? "narrow" : wide ? "wide" : ""}`} aria-describedby={undefined}>
                        {labelOnly ? (
                            <>
                                <RDialog.Title className="sr-only">{title}</RDialog.Title>
                                {children}
                            </>
                        ) : (
                            <div className="m-body">
                                <div className="d-top">
                                    <RDialog.Title asChild>
                                        <h2>{title}</h2>
                                    </RDialog.Title>
                                    <RDialog.Close className="icon-btn" aria-label="Schließen">
                                        <Ic icon={X} />
                                    </RDialog.Close>
                                </div>
                                {children}
                            </div>
                        )}
                    </RDialog.Content>
                </div>
            </RDialog.Portal>
        </RDialog.Root>
    );
}

/** Messages: they pause while pointer or focus is on them; errors stay until closed. */
export function Toasts() {
    const toasts = useUi((s) => s.toasts);
    return (
        <div className="toasts" aria-live="polite">
            {toasts.map((t) => (
                <div
                    key={t.id}
                    className={`toast ${t.tone}`}
                    role={t.tone === "error" ? "alert" : "status"}
                    onPointerEnter={() => ui.pauseToast(t.id)}
                    onPointerLeave={() => ui.resumeToast(t.id)}
                    onFocus={() => ui.pauseToast(t.id)}
                    onBlur={() => ui.resumeToast(t.id)}
                >
                    <Ic icon={t.tone === "error" ? AlertTriangle : t.tone === "info" ? Info : Check} size={16} />
                    <span>{t.text}</span>
                    <button type="button" className="toast-x" aria-label="Meldung schließen" onClick={() => ui.dismissToast(t.id)}>
                        <Ic icon={X} size={14} />
                    </button>
                </div>
            ))}
        </div>
    );
}

/**
 * Asks before something is deleted or replaced. The confirm button names the action; it is red
 * only for deleting and removing. `onConfirm` returns false when it failed: then the dialog stays
 * open and the error message shows.
 */
export function ConfirmDialog({
    title,
    text,
    confirm,
    danger,
    onConfirm,
}: {
    title: string;
    text: string;
    confirm: string;
    danger?: boolean;
    onConfirm: () => Promise<boolean | void> | boolean | void;
}) {
    const [busy, setBusy] = useState(false);
    return (
        <Modal title={title} onClose={() => ui.close()} narrow>
            <p className="muted">{text}</p>
            <div className="actions">
                <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>
                    Abbrechen
                </button>
                <Button
                    className={danger ? "btn-danger" : "btn-primary"}
                    busy={busy}
                    autoFocus
                    onClick={async () => {
                        setBusy(true);
                        try {
                            if ((await onConfirm()) === false) return;
                            ui.close();
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {confirm}
                </Button>
            </div>
        </Modal>
    );
}

/** A button that shows a spinner instead of its symbol and is disabled while `busy`. */
export function Button({ busy = false, icon, iconSize = 15, className = "", disabled, children, ...rest }: { busy?: boolean; icon?: LucideIcon; iconSize?: number } & React.ComponentProps<"button">) {
    return (
        <button type="button" className={`btn ${className}`} disabled={busy || disabled} aria-busy={busy || undefined} {...rest}>
            {busy ? <Spinner size={iconSize} /> : icon && <Ic icon={icon} size={iconSize} />}
            {children}
        </button>
    );
}

/** An empty list or page; the default symbol is for "nothing found". */
export function Empty({ icon = Search, title, text, action }: { icon?: LucideIcon; title: string; text?: string; action?: ReactNode }) {
    return (
        <div className="empty">
            <span className="acc-ic">
                <Ic icon={icon} size={20} />
            </span>
            <b>{title}</b>
            {text && <p>{text}</p>}
            {action}
        </div>
    );
}

/**
 * The one empty state for "no own bank connection yet", the same on every page. `reason` says why the
 * page needs one; `offline` adds the way to an offline account (for pages that work without a bank).
 */
export function NoBankAccess({ reason, offline = false }: { reason?: string; offline?: boolean }) {
    return (
        <div className="empty">
            <span className="acc-ic">
                <Ic icon={Landmark} size={20} />
            </span>
            <b>Noch keine Bankverbindung</b>
            <p>
                {reason && `${reason} `}
                Richte eine Bankverbindung ein, dann ruft MBM Salden und Umsätze bei deiner Bank ab. Bei Banken mit FinTS kannst du dann auch überweisen und Aufträge sehen.
            </p>
            <div className="empty-actions">
                <Button className="btn-primary" icon={Landmark} onClick={() => ui.open({ kind: "bankSetup" })}>
                    Bankverbindung einrichten
                </Button>
                {offline && (
                    <Button icon={Plus} onClick={() => ui.open({ kind: "addAccount", offline: true })}>
                        Offline-Konto anlegen
                    </Button>
                )}
            </div>
        </div>
    );
}

export function Hint({ children, tone }: { children: ReactNode; tone?: "ok" | "bad" }) {
    return (
        <p className={`hint ${tone ?? ""}`} role={tone === "bad" ? "alert" : undefined}>
            {tone === "bad" && <Ic icon={AlertTriangle} size={14} />}
            {children}
        </p>
    );
}

export function Kbd({ children }: { children: ReactNode }) {
    return <span className="kbd">{children}</span>;
}

export function Spinner({ size = 15 }: { size?: number }) {
    return (
        <span className="spin" style={{ display: "grid" }}>
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.2-8.6" />
            </svg>
        </span>
    );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
            <span />
        </button>
    );
}
