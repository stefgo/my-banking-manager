import { ArrowLeftRight } from "lucide-react";
import { chipDate } from "../lib/orders";
import { Amt } from "./common";
import { Ic } from "./icons";

/** One order or one run of an order: date chip, payee, a line of details, amount. */
export function OrderRow({
    date,
    name,
    detail,
    amount,
    internal,
    selected = false,
    onClick,
}: {
    /** Day it runs; null for an order that has ended. */
    date: string | null;
    name: string;
    detail: string;
    amount: number;
    /** The payee is an own account. */
    internal: boolean;
    selected?: boolean;
    onClick: () => void;
}) {
    const chip = date ? chipDate(date) : null;
    return (
        <button type="button" className={`up ${selected ? "sel" : ""} ${chip ? "" : "ended"}`} aria-pressed={selected || undefined} onClick={onClick}>
            <span className="datechip" aria-hidden={!chip || undefined}>
                {chip ? (
                    <>
                        <b>{chip[0]}</b>
                        <span>{chip[1]}</span>
                    </>
                ) : (
                    <span>Ende</span>
                )}
            </span>
            <span className="up-main">
                <b>{name || "—"}</b>
                <small>
                    {internal && <Ic icon={ArrowLeftRight} size={12} aria-label="Umbuchung auf ein eigenes Konto" />}
                    <span>{detail}</span>
                </small>
            </span>
            {/* An order is a debit of its account */}
            <Amt cents={-amount} className="up-amt" />
        </button>
    );
}
