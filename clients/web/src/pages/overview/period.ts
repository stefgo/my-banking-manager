import { addDaysIso, todayIso, toIsoDate } from "@mbm/shared";

export type Period = "month" | "lastMonth" | "30" | "90";

export const PERIOD_LABELS: Record<Period, string> = {
    month: "Dieser Monat",
    lastMonth: "Letzter Monat",
    "30": "Letzte 30 Tage",
    "90": "Letzte 90 Tage",
};

/** First and last day of a card's period. */
export function periodBounds(p: Period, today = todayIso()): { from: string; to: string } {
    const [y, m] = today.split("-").map(Number) as [number, number];
    switch (p) {
        case "month":
            return { from: toIsoDate(new Date(y, m - 1, 1)), to: today };
        case "lastMonth":
            return { from: toIsoDate(new Date(y, m - 2, 1)), to: toIsoDate(new Date(y, m - 1, 0)) };
        case "30":
            return { from: addDaysIso(today, -29), to: today };
        case "90":
            return { from: addDaysIso(today, -89), to: today };
    }
}
