// Starts the Enable Banking connector on its Unix socket (image mbm-enablebanking). Configuration
// from the environment: MBM_ENABLEBANKING_SOCKET, the path of the socket (default
// /run/mbm/enablebanking.sock), and what setup.ts reads.

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { buildApi } from "./api/server.js";
import { connectorSetup } from "./setup.js";

const setup = connectorSetup();
const socket = process.env.MBM_ENABLEBANKING_SOCKET || "/run/mbm/enablebanking.sock";
const { app } = buildApi(setup.options);

// A socket left over from a crash would block listen(). The folder is missing on a first local start.
if (existsSync(socket)) rmSync(socket);
mkdirSync(dirname(socket), { recursive: true });
await app.listen({ path: socket });
chmodSync(socket, 0o660);
console.log(`MBM Enable Banking connector ${setup.version} listening on ${socket}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        void app.close().then(() => process.exit(0));
    });
}
