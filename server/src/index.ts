import { pino } from "pino";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPrettyOutput } from "./logFormat.js";
import { Vault } from "./vault.js";

const config = loadConfig();
const prettyOutput = process.stdout.isTTY ? await createPrettyOutput() : undefined;
const logger = pino(
    {
        level: config.logLevel,
        // Never log credentials or bank data
        redact: { paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.recoveryKey", "*.pin", "*.code", "*.privateKey", "*.credentials", "*.state", "*.sessionId"], remove: true },
    },
    prettyOutput,
);

const vault = new Vault(config, logger);
const { app } = await buildApp(config, vault, logger);

await app.listen({ host: config.host, port: config.port });
logger.info(`My Banking Manager on port ${config.port}, ${vault.state() === "setup" ? "not set up yet" : vault.state()}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        await app.close();
        vault.close();
        process.exit(0);
    });
}
