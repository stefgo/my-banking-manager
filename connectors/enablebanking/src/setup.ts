// Configuration of the Enable Banking connector from the environment:
//   MBM_VERSION   version this connector reports (default: package version; set by the image build)
// The application ID and key of each user come with every call from the server, never from here.

import { readFileSync } from "node:fs";
import type { ApiOptions } from "./api/server.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export function connectorSetup(env: NodeJS.ProcessEnv = process.env): { version: string; options: ApiOptions } {
    const version = env.MBM_VERSION?.trim() || pkg.version;
    return { version, options: { version } };
}
