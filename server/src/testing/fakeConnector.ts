// A fake connector on a temporary Unix socket: answers connector routes by script and records
// what it received. Server tests never run FinTS and never reach a bank.

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectorRoutes, type ConnectorRoutes } from "@mbm/shared";

export type FakeReply = { status?: number; json: unknown };
export type FakeHandler = (body: any, id: string | undefined) => FakeReply | unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface FakeConnector {
    socket: string;
    received: { route: keyof ConnectorRoutes; body: any; id?: string }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    on(route: keyof ConnectorRoutes, handler: FakeHandler): void;
    close(): Promise<void>;
}

export async function startFakeConnector(): Promise<FakeConnector> {
    const dir = mkdtempSync(path.join(tmpdir(), "mbm-fc-"));
    const socket = path.join(dir, "c.sock");
    const handlers = new Map<string, FakeHandler>();
    const received: FakeConnector["received"] = [];
    const routes = Object.entries(connectorRoutes).map(([name, def]) => ({ name: name as keyof ConnectorRoutes, method: def.method, re: new RegExp(`^${def.path.replace(":id", "([^/]+)")}$`) }));
    handlers.set("info", () => ({ name: "fints", version: "test", productConfigured: true, capabilities: ["accounts"] }));

    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const r = routes.find((x) => x.method === req.method && x.re.test(req.url ?? ""));
            const id = r ? (req.url ?? "").match(r.re)?.[1] : undefined;
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
            if (r) received.push({ route: r.name, body, id });
            const h = r && handlers.get(r.name);
            const out = h ? h(body, id) : { status: 500, json: { error: "internal", message: "no handler" } };
            const reply = out && typeof out === "object" && "json" in out ? (out as FakeReply) : { json: out };
            res.statusCode = reply.status ?? 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(reply.json));
        });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return {
        socket,
        received,
        on: (route, handler) => void handlers.set(route, handler),
        close: () =>
            new Promise((resolve) => {
                server.close(() => {
                    rmSync(dir, { recursive: true, force: true });
                    resolve();
                });
                server.closeAllConnections();
            }),
    };
}
