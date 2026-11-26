// The form of JSON answers without their contents: which fields occur, how often, of which kind
// (text, date, decimal …) and how long. Values are shown only for fields named in `showValues`
// (codes such as status or currency) and for booleans. Used by eb-info.

export interface FieldStats {
    /** Items in which the field occurs at least once. */
    items: number;
    /** Occurrences by kind: text, empty, date, datetime, decimal, number, boolean, null, object, array. */
    kinds: Map<string, number>;
    /** Shortest and longest text or array. */
    minLength: number;
    maxLength: number;
    /** Decimals with a minus sign. */
    negative: number;
    /** Counts per value; only for fields in `showValues` and booleans. */
    values: Map<string, number>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
/** Longer "codes" are left out: they could be free text after all. */
const MAX_VALUE_LENGTH = 60;

export function kindOf(value: string): string {
    if (value === "") return "empty";
    if (DATE.test(value)) return "date";
    if (DATETIME.test(value)) return "datetime";
    if (DECIMAL.test(value)) return "decimal";
    return "text";
}

export class Shape {
    readonly fields = new Map<string, FieldStats>();
    count = 0;

    constructor(private readonly showValues: ReadonlySet<string> = new Set()) {}

    add(item: unknown): void {
        this.count++;
        const seen = new Set<string>();
        this.walk(item, "", seen);
        for (const path of seen) this.stats(path).items++;
    }

    private stats(path: string): FieldStats {
        let s = this.fields.get(path);
        if (!s) {
            s = { items: 0, kinds: new Map(), minLength: Infinity, maxLength: -Infinity, negative: 0, values: new Map() };
            this.fields.set(path, s);
        }
        return s;
    }

    private walk(value: unknown, path: string, seen: Set<string>): void {
        const at = path || "(item)";
        seen.add(at);
        const s = this.stats(at);
        const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
        const length = (n: number) => {
            s.minLength = Math.min(s.minLength, n);
            s.maxLength = Math.max(s.maxLength, n);
        };
        if (value === null || value === undefined) {
            bump(s.kinds, "null");
        } else if (typeof value === "string") {
            const kind = kindOf(value);
            bump(s.kinds, kind);
            if (kind === "text") length(value.length);
            if (kind === "decimal" && value.startsWith("-")) s.negative++;
            if (this.showValues.has(at) && value.length <= MAX_VALUE_LENGTH) bump(s.values, value);
        } else if (typeof value === "boolean") {
            bump(s.kinds, "boolean");
            bump(s.values, String(value));
        } else if (typeof value === "number") {
            bump(s.kinds, "number");
            if (this.showValues.has(at)) bump(s.values, String(value));
        } else if (Array.isArray(value)) {
            bump(s.kinds, "array");
            length(value.length);
            for (const el of value) this.walk(el, `${path}[]`, seen);
        } else if (typeof value === "object") {
            bump(s.kinds, "object");
            for (const [k, v] of Object.entries(value)) this.walk(v, path ? `${path}.${k}` : k, seen);
        }
    }

    /** One line per field, sorted by path. */
    lines(): string[] {
        const out: string[] = [];
        const paths = [...this.fields.keys()].filter((p) => p !== "(item)").sort();
        const width = Math.max(20, ...paths.map((p) => p.length));
        for (const path of paths) {
            const s = this.fields.get(path)!;
            const kinds = [...s.kinds].map(([k, n]) => `${k} ${n}`).join(", ");
            const details: string[] = [];
            if (s.maxLength >= 0) details.push(s.minLength === s.maxLength ? `length ${s.minLength}` : `length ${s.minLength}–${s.maxLength}`);
            if (s.kinds.has("decimal")) details.push(`negative ${s.negative}`);
            if (s.values.size) {
                const top = [...s.values].sort((a, b) => b[1] - a[1]);
                details.push(top.slice(0, 15).map(([v, n]) => `${JSON.stringify(v)} ${n}`).join(", ") + (top.length > 15 ? ` … (${top.length} values)` : ""));
            }
            out.push(`  ${path.padEnd(width)}  ${`${s.items}/${this.count}`.padStart(9)}  ${kinds}${details.length ? `  · ${details.join(" · ")}` : ""}`);
        }
        return out;
    }
}
