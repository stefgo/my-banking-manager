// Writes the diagrams of the documentation to docs/assets/diagrams/ (npm run diagrams).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { keys, overview, transferStates } from "./figures.js";
import { renderSvg, type Diagram } from "./svg.js";

const OUT = path.resolve(import.meta.dirname, "../../docs/assets/diagrams");

const files: Record<string, Diagram> = {
    "datenbank-tabellen.svg": overview,
    "datenbank-schluessel.svg": keys,
    "ueberweisung-zustaende.svg": transferStates,
};

mkdirSync(OUT, { recursive: true });
for (const [name, diagram] of Object.entries(files)) {
    writeFileSync(path.join(OUT, name), renderSvg(diagram));
    console.log(`docs/assets/diagrams/${name}`);
}
