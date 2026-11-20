// Prints what a bank offers over FinTS, from an anonymous dialog (no credentials). Writes
// nothing to disk; the output goes to the terminal only. The product ID comes from .env in the
// repository root (or MBM_FINTS_PRODUCT_ID in the environment).
//
//   npm run bank-info -w connectors/fints -- <BLZ> <FinTS address>

import { fetchBankParameters } from "../dialog/anonymous.js";
import { parseTanMethods } from "../segments/tan.js";
import { camtFormats } from "../segments/jobs.js";
import { httpTransport } from "../transport/http.js";

const [blz, url] = process.argv.slice(2);
const productId = process.env.MBM_FINTS_PRODUCT_ID?.trim();
if (!blz || !url || !productId) {
    console.error("Usage: npm run bank-info -w connectors/fints -- <BLZ> <FinTS address>");
    if (!productId) console.error("MBM_FINTS_PRODUCT_ID is missing: put it into .env in the repository root (see .env.example).");
    process.exit(1);
}

const result = await fetchBankParameters({ blz, product: { id: productId, version: "0.1.0" }, transport: httpTransport(url) });
const bpd = result.bpd;
console.log("Return codes:", result.codes.map((c) => `${c.code} ${c.text}`).join(" | "));
if (!bpd) {
    console.log("No bank parameters received.");
    process.exit(0);
}
const versions = (id: string) => (bpd.jobs[id] ?? []).map((j) => j.version).join(",") || "–";
console.log(`\n${bpd.bankName} (BLZ ${bpd.blz}), BPD version ${bpd.version}, HBCI ${bpd.hbciVersions.join(",")}, PIN/TAN ${bpd.pinTan ? "yes" : "no"}`);
console.log("\nJobs we use (versions offered):");
for (const id of ["HKTAN", "HKTAB", "HKSPA", "HKSAL", "HKKAZ", "HKCAZ", "HKKKU", "DKKKU", "HKCCS", "HKIPZ", "HKVPP", "HKCDB", "HKCDE", "HKCDN", "HKCDL", "HKCSE", "HKCSB", "HKCSL"]) {
    console.log(`  ${id.padEnd(6)} ${versions(id).padEnd(8)} ${bpd.pinTan?.tanRequired[id] === undefined ? "" : bpd.pinTan.tanRequired[id] ? "TAN" : "no TAN"}`);
}
const caz = bpd.jobs.HKCAZ?.at(-1);
if (caz) console.log("\ncamt formats offered:", (caz.params[0] ?? []).slice(3).join(", "), "→ we use:", camtFormats(caz.params).join(", ") || "none");
console.log("\nTwo-step methods:");
for (const m of parseTanMethods(bpd)) {
    console.log(`  ${m.securityFunction} ${m.name} (${m.dkName || "?"}, HKTAN ${m.hktanVersion}${m.decoupled ? `, decoupled: first query after ${m.decoupled.firstDelay}s, then every ${m.decoupled.nextDelay}s, max ${m.decoupled.maxPolls}` : ""}, medium ${["not allowed", "optional", "required"][m.mediumRequired] ?? m.mediumRequired})`);
}
console.log("\nAll jobs:", Object.keys(bpd.jobs).sort().join(" "));
