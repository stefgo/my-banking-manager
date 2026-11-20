// Reading the object tree fast-xml-parser builds, by path and without knowing the schema.

type X = Record<string, unknown> | undefined;

export const obj = (v: unknown): X => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
/** Text of an element, also when it carries attributes ("#text"). */
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : (obj(v)?.["#text"] as string | undefined) ?? "");
export const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => obj(o)?.[k], v);

/** A decimal amount ("12.5") in cents; null if it is no amount or has more than two decimal places. */
export function decimalCents(value: string): number | null {
    if (!/^\d+(\.\d+)?$/.test(value)) return null;
    const [whole, frac = ""] = value.split(".");
    if (frac.replace(/0+$/, "").length > 2) return null;
    return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}
