// Prints what a bank offers over FinTS, from an anonymous dialog (no credentials). Writes
// nothing to disk; the output goes to the terminal only. The product ID comes from .env in the
// repository root (or MBM_FINTS_PRODUCT_ID in the environment).
//
//   npm run bank-info -w connectors/fints -- <BLZ> <FinTS address>

import { fetchBankParameters } from "../dialog/anonymous.js";
import { parseTanMethods } from "../segments/tan.js";
import { camtFormats } from "../segments/jobs.js";
import { deleteNeedsData, orderRules } from "../segments/orders.js";
import { vopParameters } from "../segments/payments.js";
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
for (const id of ["HKTAN", "HKTAB", "HKSPA", "HKSAL", "HKKAZ", "HKCAZ", "HKKKU", "DKKKU", "HKCCS", "HKIPZ", "HKVPP", "HKCDB", "HKCDE", "HKCDN", "HKCDL", "HKCSE", "HKCSA", "HKCSB", "HKCSL"]) {
    console.log(`  ${id.padEnd(6)} ${versions(id).padEnd(8)} ${bpd.pinTan?.tanRequired[id] === undefined ? "" : bpd.pinTan.tanRequired[id] ? "TAN" : "no TAN"}`);
}
const caz = bpd.jobs.HKCAZ?.at(-1);
if (caz) console.log("\ncamt formats offered:", (caz.params[0] ?? []).slice(3).join(", "), "→ we use:", camtFormats(caz.params).join(", ") || "none");
console.log("\nTwo-step methods:");
for (const m of parseTanMethods(bpd)) {
    console.log(`  ${m.securityFunction} ${m.name} (${m.dkName || "?"}, HKTAN ${m.hktanVersion}${m.decoupled ? `, decoupled: first query after ${m.decoupled.firstDelay}s, then every ${m.decoupled.nextDelay}s, max ${m.decoupled.maxPolls}` : ""}, medium ${["not allowed", "optional", "required"][m.mediumRequired] ?? m.mediumRequired})`);
}
// Raw parameters of the jobs for orders and payments, as the bank sends them (DEG components joined
// with ":", elements with "+"); public bank parameters, no customer data.
console.log("\nParameters of orders and payments (per version):");
for (const id of ["HKCCS", "HKIPZ", "HKVPP", "HKVPA", "HKSPA", "HKCDB", "HKCDE", "HKCDN", "HKCDL", "HKCSB", "HKCSE", "HKCSA", "HKCSL"]) {
    for (const j of bpd.jobs[id] ?? []) {
        const params = j.params.map((el) => el.map((c) => (typeof c === "string" ? c : `<${c.length} bytes>`)).join(":")).join("+");
        console.log(`  ${id} v${j.version} (max. ${j.maxJobs} per message): ${params || "–"}`);
    }
}
// The same values as MBM reads them
const rules = orderRules(bpd);
const rhythm = (r: { months: number[]; monthDays: number[]; weeks: number[]; weekDays: number[] }) =>
    `every ${r.months.join("/") || "–"} months on days ${r.monthDays.join(",") || "–"}; every ${r.weeks.join("/") || "–"} weeks on weekdays ${r.weekDays.join(",") || "–"}`;
console.log("\nAs MBM reads them:");
console.log("  Verification of payee for:", vopParameters(bpd)?.jobs.join(", ") || "–");
if (rules?.scheduled) console.log(`  Scheduled transfer: ${rules.scheduled.minDays}–${rules.scheduled.maxDays} days ahead`);
if (rules?.scheduledChange) console.log(`  Change of a scheduled transfer: ${rules.scheduledChange.minDays}–${rules.scheduledChange.maxDays} days ahead`);
if (rules?.standing) console.log(`  Standing order: first run ${rules.standing.minDays}–${rules.standing.maxDays} days ahead, ${rhythm(rules.standing)}`);
if (rules?.standingChange) {
    const c = rules.standingChange.changeable;
    const keys = Object.keys(c) as (keyof typeof c)[];
    console.log(`  Change of a standing order: ${rhythm(rules.standingChange)}; changeable: ${keys.filter((k) => c[k]).join(", ")}; not: ${keys.filter((k) => !c[k]).join(", ") || "–"}`);
}
if (bpd.jobs.HKCSL) console.log(`  Deleting a scheduled transfer sends its data: ${deleteNeedsData(bpd, "HKCSL") ? "yes" : "no"}`);
if (bpd.jobs.HKCDL) console.log(`  Deleting a standing order sends its data: ${deleteNeedsData(bpd, "HKCDL") ? "yes" : "no"}`);
console.log("\nAll jobs:", Object.keys(bpd.jobs).sort().join(" "));
