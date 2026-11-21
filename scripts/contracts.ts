// Writes contracts/server-api.yaml and contracts/connector-api.yaml from the route lists in
// shared. With --check it only compares and fails when a file is out of date (CI).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { z } from "zod";
import { ApiError, ConnectorError, connectorRoutes, routes, type ConnectorRouteDef, type RouteDef } from "@mbm/shared";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Json = Record<string, unknown>;

/** Schemas with a `meta({ id })`: listed once under components, referenced from the routes. */
const named = new Map<string, unknown>();

const toComponentRefs = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(toComponentRefs);
    if (typeof node !== "object" || node === null) return node;
    return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, k === "$ref" && typeof v === "string" ? v.replace("#/$defs/", "#/components/schemas/") : toComponentRefs(v)]),
    );
};

const schema = (s: z.ZodType, io: "input" | "output"): Json => {
    const json = z.toJSONSchema(s, { io, unrepresentable: "any", target: "draft-2020-12" }) as Json;
    delete json.$schema;
    for (const [id, def] of Object.entries((json.$defs ?? {}) as Json)) {
        const component = toComponentRefs(def);
        if (named.has(id) && JSON.stringify(named.get(id)) !== JSON.stringify(component)) throw new Error(`Schema ${id} differs between input and output.`);
        named.set(id, component);
    }
    delete json.$defs;
    return toComponentRefs(json) as Json;
};

function parameters(def: { path: string; params?: z.ZodType; query?: z.ZodType }): Json[] {
    const out: Json[] = [];
    for (const [where, s] of [["path", def.params], ["query", def.query]] as const) {
        if (!s) continue;
        const json = schema(s, "input") as { properties?: Record<string, Json>; required?: string[] };
        for (const [name, prop] of Object.entries(json.properties ?? {})) {
            if (where === "path" && !def.path.includes(`:${name}`)) continue;
            out.push({ name, in: where, required: where === "path" || (json.required ?? []).includes(name), schema: prop });
        }
    }
    return out;
}

function operation(name: string, def: ConnectorRouteDef & { query?: z.ZodType }, extra: Json, errorRef: string): Json {
    const op: Json = { operationId: name, summary: def.summary, ...extra };
    const params = parameters(def);
    if (params.length) op.parameters = params;
    if (def.body) op.requestBody = { required: true, content: { "application/json": { schema: schema(def.body, "input") } } };
    op.responses = {
        "200": { description: "OK", content: { "application/json": { schema: schema(def.response, "output") } } },
        default: { description: "Error", content: { "application/json": { schema: { $ref: errorRef } } } },
    };
    return op;
}

// ---------- Server API ----------

const serverDoc: Json = {
    openapi: "3.1.0",
    info: {
        title: "My Banking Manager – Server-API",
        version: "1",
        description:
            "Generated from shared/src/api.ts by `npm run contracts`; do not edit by hand. Sign-in: the web client uses the HttpOnly cookie `mbm_session`, other clients send `Authorization: Bearer <device token>`. Events: WebSocket `/api/events` (see shared/src/events.ts).",
    },
    components: {
        securitySchemes: {
            session: { type: "apiKey", in: "cookie", name: "mbm_session" },
            device: { type: "http", scheme: "bearer" },
        },
        schemas: { ApiError: schema(ApiError, "output") },
    },
    paths: {} as Json,
};
for (const [name, def] of Object.entries(routes) as [string, RouteDef][]) {
    const p = def.path.replace(/:(\w+)/g, "{$1}");
    const security = def.access === "user" || def.access === "session" ? [{ session: [] }, { device: [] }] : [];
    const paths = serverDoc.paths as Record<string, Json>;
    paths[p] = { ...(paths[p] ?? {}), [def.method.toLowerCase()]: operation(name, def, { tags: [def.tag], security }, "#/components/schemas/ApiError") };
}
for (const id of [...named.keys()].sort()) ((serverDoc.components as Json).schemas as Json)[id] = named.get(id);

// ---------- Connector API ----------

const connectorDoc: Json = {
    openapi: "3.1.0",
    info: {
        title: "My Banking Manager – Konnektor-API",
        version: "1",
        description:
            "Generated from shared/src/connector-api.ts by `npm run contracts`; do not edit by hand. Served by every connector on a Unix socket that only the server mounts; no authentication. The connector keeps no data: the server sends bank, login and the opaque state with every call. A call that needs an approval answers with status `approval` and an operation id; the server then queries GET /v1/operations/{id} until the status is `done`.",
    },
    components: { schemas: { ConnectorError: schema(ConnectorError, "output") } },
    paths: {} as Json,
};
for (const [name, def] of Object.entries(connectorRoutes) as [string, ConnectorRouteDef][]) {
    const p = def.path.replace(/:(\w+)/g, "{$1}");
    const paths = connectorDoc.paths as Record<string, Json>;
    paths[p] = { ...(paths[p] ?? {}), [def.method.toLowerCase()]: operation(name, def, {}, "#/components/schemas/ConnectorError") };
}

// ---------- Write or check ----------

const files: [string, Json, number][] = [
    ["server-api.yaml", serverDoc, Object.keys(routes).length],
    ["connector-api.yaml", connectorDoc, Object.keys(connectorRoutes).length],
];
let stale = false;
for (const [file, doc, count] of files) {
    const target = path.join(root, "contracts", file);
    const yaml = `# Generated by scripts/contracts.ts — do not edit.\n${stringify(doc, { lineWidth: 0 })}`;
    if (process.argv.includes("--check")) {
        const current = existsSync(target) ? readFileSync(target, "utf8") : "";
        if (current !== yaml) {
            console.error(`contracts/${file} is out of date. Run \`npm run contracts\`.`);
            stale = true;
        } else {
            console.log(`contracts/${file} is up to date.`);
        }
    } else {
        writeFileSync(target, yaml);
        console.log(`Wrote ${path.relative(root, target)} (${count} routes).`);
    }
}
if (stale) process.exit(1);
