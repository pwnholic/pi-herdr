import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiHerdrRuntime, type RuntimeDependencies } from "./pi/runtime.ts";
import { registerPiHerdrTools } from "./pi/tools.ts";

export interface ExtensionRegistrationOptions extends Omit<RuntimeDependencies, "extensionPath"> {
    readonly extensionPath?: string;
}

/** Register handlers and schemas only; durable/external resources open on session_start. */
export function registerPiHerdrExtension(
    pi: ExtensionAPI,
    options: ExtensionRegistrationOptions = {},
): PiHerdrRuntime {
    const environment = options.environment ?? process.env;
    const childProcess =
        environment.PI_HERDR_AGENT_ID !== undefined || environment.PI_HERDR_PARENT_ID !== undefined;
    const runtime = new PiHerdrRuntime(pi, {
        ...options,
        environment,
        extensionPath: options.extensionPath ?? fileURLToPath(import.meta.url),
        onError:
            options.onError ??
            ((error) => {
                const message =
                    error instanceof Error ? (error.stack ?? error.message) : String(error);
                process.stderr.write(`[pi-herdr] ${message}\n`);
            }),
    });

    registerPiHerdrTools(pi, runtime, childProcess);
    pi.on("session_start", async (_event, ctx) => runtime.start(ctx));
    pi.on("session_shutdown", async (_event, _ctx) => runtime.stop());
    pi.on("agent_start", (_event, _ctx) => runtime.onAgentStart());
    pi.on("agent_end", (event, _ctx) => runtime.onAgentEnd(event));
    pi.on("agent_settled", async (_event, ctx) => runtime.onAgentSettled(ctx));
    return runtime;
}

export default function piHerdrExtension(pi: ExtensionAPI): void {
    registerPiHerdrExtension(pi);
}
