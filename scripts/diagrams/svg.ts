// Renders a diagram as a self-contained SVG file: boxes, edges clipped at the box borders, groups.
// The file carries its own style and background and follows the reader's light or dark setting, so
// it reads the same as an image on GitHub and on the documentation site.

export interface Box {
    id: string;
    x: number; // centre
    y: number; // centre
    w: number;
    h: number;
    /** Text in the box; the id if left out. */
    label?: string;
    /** Smaller lines under the label. */
    sub?: string[];
    /** Style class: a domain (d-…) draws a coloured stripe, any other class colours the box. */
    cls: string;
    /** A dashed frame with a caption behind other boxes; edges can start at it. */
    group?: string;
}

export interface Edge {
    from: string;
    to: string;
    /** cascade (solid), setnull (dashed), restrict (warning colour), logical (dotted), flow (solid). */
    style?: "cascade" | "setnull" | "restrict" | "logical" | "flow";
    /** Drawn in the accent colour. */
    accent?: boolean;
    /** Corner points between the two boxes. */
    via?: { x: number; y: number }[];
    /** Label at the middle of the longest segment; "\n" breaks lines. */
    label?: string;
    dx?: number;
    dy?: number;
    anchor?: "start" | "middle" | "end";
}

export interface Diagram {
    width: number;
    height: number;
    /** What the picture shows, for readers who cannot see it. */
    title: string;
    boxes: Box[];
    edges: Edge[];
    /** Extra SVG drawn behind the edges (e.g. a divider). */
    behind?: string;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r = (n: number): number => Math.round(n * 10) / 10;

/** Where the line from the centre of `box` towards `to` leaves the box. */
function clip(box: Box, to: { x: number; y: number }): { x: number; y: number } {
    const dx = to.x - box.x;
    const dy = to.y - box.y;
    const tx = dx === 0 ? Infinity : box.w / 2 / Math.abs(dx);
    const ty = dy === 0 ? Infinity : box.h / 2 / Math.abs(dy);
    const t = Math.min(tx, ty);
    return { x: box.x + dx * t, y: box.y + dy * t };
}

// MBM's palette (clients/web/src/styles/app.css): light first, dark for prefers-color-scheme.
const STYLE = `
svg { --bg: #FFFFFF; --frame: #E2E2EA; --box: #F6F6FA; --box-line: #E2E2EA; --fg: #14151A; --muted: #646878; --faint: #9A9DAB;
    --iris: #2F55D4; --iris-soft: #E9EDFA; --pos: #0F9D63; --warn: #B7791F; --neg: #D63A4A;
    --d-user: #5B47F0; --d-bank: #0B85AE; --d-acc: #2F6FD6; --d-tx: #0F9D63; --d-cat: #B7791F; --d-ord: #C2417B; --d-misc: #7A7F90; }
@media (prefers-color-scheme: dark) {
    svg { --bg: #12141C; --frame: #262A37; --box: #181B26; --box-line: #2C3040; --fg: #ECEDF2; --muted: #8B90A3; --faint: #5D6276;
        --iris: #4F7BFF; --iris-soft: #1C2440; --pos: #3DDC97; --warn: #F5B54A; --neg: #FF6B7A;
        --d-user: #A497FF; --d-bank: #67D4F5; --d-acc: #7CB7FF; --d-tx: #3DDC97; --d-cat: #F5B54A; --d-ord: #F38BB8; --d-misc: #A0A5B8; }
}
.bg { fill: var(--bg); stroke: var(--frame); }
text { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
.box { fill: var(--box); stroke: var(--box-line); }
.d-user { --d: var(--d-user); } .d-bank { --d: var(--d-bank); } .d-acc { --d: var(--d-acc); } .d-tx { --d: var(--d-tx); }
.d-cat { --d: var(--d-cat); } .d-ord { --d: var(--d-ord); } .d-misc { --d: var(--d-misc); }
.stripe { fill: var(--d); }
.name { fill: var(--fg); font-size: 12.5px; font-weight: 600; }
.sub { fill: var(--muted); font-size: 10.5px; }
.edge { fill: none; stroke: var(--muted); stroke-width: 1.3; }
.edge.setnull { stroke-dasharray: 5 4; }
.edge.logical { stroke-dasharray: 1.5 3.5; stroke-width: 1.6; }
.edge.restrict { stroke: var(--warn); stroke-width: 1.6; }
.edge.accent { stroke: var(--iris); }
.head { fill: var(--muted); } .head.restrict { fill: var(--warn); } .head.accent { fill: var(--iris); }
.label { fill: var(--muted); font-size: 10.5px; paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round; }
.divider { stroke: var(--frame); stroke-dasharray: 2 4; }
.group { fill: none; stroke: var(--faint); stroke-dasharray: 5 4; }
.glabel { fill: var(--muted); font-size: 11px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.k-secret { fill: var(--box); stroke: var(--muted); stroke-dasharray: 4 3; }
.k-file { fill: var(--box); stroke: var(--box-line); }
.k-key { fill: var(--iris-soft); stroke: var(--iris); }
.k-field { fill: var(--box); stroke: var(--box-line); }
.k-plain { fill: none; stroke: var(--faint); stroke-dasharray: 2 3; }
.s-run { fill: var(--iris-soft); stroke: var(--iris); }
.s-wait { fill: var(--box); stroke: var(--box-line); }
.s-ok { fill: var(--box); stroke: var(--pos); stroke-width: 1.6; }
.s-bad { fill: var(--box); stroke: var(--neg); stroke-width: 1.6; }
.s-warn { fill: var(--box); stroke: var(--warn); stroke-width: 1.6; }
.s-end { fill: var(--box); stroke: var(--muted); }
`;

const HEADS = ["plain", "restrict", "accent"] as const;

export function renderSvg(d: Diagram): string {
    const byId = new Map(d.boxes.map((b) => [b.id, b]));
    const out: string[] = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}" role="img" aria-labelledby="title">`);
    out.push(`<title id="title">${esc(d.title)}</title>`);
    out.push(`<style>${STYLE}</style>`);
    out.push(
        `<defs>${HEADS.map(
            (h) => `<marker id="head-${h}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" class="head ${h}"/></marker>`,
        ).join("")}</defs>`,
    );
    out.push(`<rect class="bg" x="0.5" y="0.5" width="${d.width - 1}" height="${d.height - 1}" rx="14"/>`);
    if (d.behind) out.push(d.behind);

    for (const b of d.boxes.filter((b) => b.group !== undefined)) {
        const x = b.x - b.w / 2;
        const y = b.y - b.h / 2;
        out.push(`<rect class="group" x="${r(x)}" y="${r(y)}" width="${b.w}" height="${b.h}" rx="12"/>`);
        out.push(`<text class="glabel" x="${r(x + 12)}" y="${r(y + 18)}">${esc(b.group ?? "")}</text>`);
    }

    const labels: string[] = [];
    for (const e of d.edges) {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) throw new Error(`Edge ${e.from} -> ${e.to}: unknown box`);
        const via = e.via ?? [];
        const points = [clip(a, via[0] ?? b), ...via, clip(b, via[via.length - 1] ?? a)];
        const style = e.style ?? "cascade";
        const head = e.accent ? "accent" : style === "restrict" ? "restrict" : "plain";
        out.push(`<path class="edge ${style}${e.accent ? " accent" : ""}" d="M${points.map((p) => `${r(p.x)},${r(p.y)}`).join(" L")}" marker-end="url(#head-${head})"/>`);
        if (e.label) {
            let mid = points[0]!;
            let longest = -1;
            for (let i = 0; i < points.length - 1; i++) {
                const p = points[i]!;
                const q = points[i + 1]!;
                const len = Math.hypot(q.x - p.x, q.y - p.y);
                if (len > longest) {
                    longest = len;
                    mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
                }
            }
            const x = r(mid.x + (e.dx ?? 0));
            const lines = e.label.split("\n");
            const y = r(mid.y + (e.dy ?? 0) + 4 - (lines.length - 1) * 6.5);
            const spans = lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : 13}">${esc(l)}</tspan>`).join("");
            labels.push(`<text class="label" x="${x}" y="${y}" text-anchor="${e.anchor ?? "middle"}">${spans}</text>`);
        }
    }

    for (const b of d.boxes.filter((b) => b.group === undefined)) {
        const x = b.x - b.w / 2;
        const y = b.y - b.h / 2;
        const domain = b.cls.startsWith("d-");
        const tx = r(b.x + (domain ? 2 : 0));
        out.push(`<g class="${b.cls}">`);
        out.push(`<rect class="${domain ? "box" : b.cls}" x="${r(x)}" y="${r(y)}" width="${b.w}" height="${b.h}" rx="7"/>`);
        if (domain) out.push(`<rect class="stripe" x="${r(x)}" y="${r(y)}" width="5" height="${b.h}" rx="2"/>`);
        out.push(`<text class="name" x="${tx}" y="${r(y + 20.5)}" text-anchor="middle">${esc(b.label ?? b.id)}</text>`);
        (b.sub ?? []).forEach((s, i) => out.push(`<text class="sub" x="${tx}" y="${r(y + 34.5 + i * 13)}" text-anchor="middle">${esc(s)}</text>`));
        out.push(`</g>`);
    }
    out.push(...labels);
    out.push("</svg>");
    return out.join("\n") + "\n";
}
