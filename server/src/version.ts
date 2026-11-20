import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/**
 * The version this server reports: MBM_VERSION, set by the image build (1.2.0 for a release,
 * dev-abc1234 otherwise), or else that of its package, which a release sets.
 */
export function serverVersion(env: string | undefined = process.env.MBM_VERSION): string {
    return env?.trim() || pkg.version;
}
