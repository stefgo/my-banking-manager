// Turns the bank code file of the Deutsche Bundesbank (fixed-width text, ISO 8859-1, "blz-aktuell-
// txt-data.txt" from bundesbank.de → Bankleitzahlen → Download) into server/data-static/blz.json,
// the copy the image brings along. The running server keeps its own copy up to date
// (server/src/services/bankdirectory.ts). Usage: npm run blz -- <file>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { directoryProblem, formatDirectory, parseBlzText } from "../server/src/services/bankdirectory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2];
if (!source) {
    console.error("Usage: npm run blz -- <blz-aktuell-txt-data.txt>");
    process.exit(1);
}

const rows = parseBlzText(readFileSync(source));
const problem = directoryProblem(rows);
if (problem) {
    console.error(problem);
    process.exit(1);
}
const target = path.join(root, "server", "data-static", "blz.json");
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, formatDirectory({ source: path.basename(source), generated: new Date().toISOString().slice(0, 10), banks: rows }));
console.log(`Wrote ${path.relative(root, target)} (${rows.length} banks).`);
