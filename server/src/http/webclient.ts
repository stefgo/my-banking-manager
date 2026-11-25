import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The web client this server delivers. */
export interface WebClient {
    /** Changes with every change of the client: index.html names each script and style by its hash. */
    build: string;
    /** index.html carrying the build in `<meta name="mbm-build">`, which a window compares. */
    html: string;
}

/** Reads the built client in `webRoot`; null without one (also under the Vite dev server). */
export function loadWebClient(webRoot: string): WebClient | null {
    const file = webRoot ? path.join(webRoot, "index.html") : "";
    if (!file || !existsSync(file)) return null;
    const source = readFileSync(file, "utf8");
    const build = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const meta = `<meta name="mbm-build" content="${build}" />`;
    const html = source.includes("</head>") ? source.replace("</head>", `    ${meta}\n    </head>`) : `${meta}\n${source}`;
    return { build, html };
}
