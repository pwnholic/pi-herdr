import { spawn } from "node:child_process";

export type CommandTermination =
    | "exited"
    | "timed_out"
    | "aborted"
    | "output_limit"
    | "spawn_error";

export interface CommandInvocation {
    readonly executable: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CommandExecution {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly termination: CommandTermination;
    readonly error?: Error;
}

/** Injectable boundary used by the Herdr adapter. It must never invoke a shell. */
export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandExecution>;

export interface NodeCommandRunnerOptions {
    readonly maxOutputBytes?: number;
    readonly forceKillAfterMs?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Production command runner backed by spawn(2). Arguments remain an argv array,
 * so names, prompts, paths, and environment values are never shell-interpreted.
 */
export function createNodeCommandRunner(options: NodeCommandRunnerOptions = {}): CommandRunner {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const forceKillAfterMs = options.forceKillAfterMs ?? 250;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
        throw new RangeError("maxOutputBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(forceKillAfterMs) || forceKillAfterMs < 0) {
        throw new RangeError("forceKillAfterMs must be a non-negative safe integer");
    }

    return (invocation) =>
        new Promise<CommandExecution>((resolve) => {
            if (invocation.signal?.aborted) {
                resolve({
                    exitCode: null,
                    stdout: "",
                    stderr: "",
                    termination: "aborted",
                });
                return;
            }
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let outputBytes = 0;
            let termination: CommandTermination = "exited";
            let spawnError: Error | undefined;
            let settled = false;
            let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

            const child = spawn(invocation.executable, [...invocation.args], {
                cwd: invocation.cwd,
                env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
                stdio: ["ignore", "pipe", "pipe"],
                shell: false,
                windowsHide: true,
            });

            const terminate = (reason: CommandTermination): void => {
                if (termination !== "exited") return;
                termination = reason;
                child.kill("SIGTERM");
                forceKillTimer = setTimeout(() => child.kill("SIGKILL"), forceKillAfterMs);
                forceKillTimer.unref?.();
            };

            const append = (target: Buffer[], chunk: Buffer | string): void => {
                const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                outputBytes += value.byteLength;
                if (outputBytes <= maxOutputBytes) target.push(value);
                else terminate("output_limit");
            };

            child.stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
            child.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));
            child.on("error", (error) => {
                spawnError = error;
                termination = "spawn_error";
            });

            const timeout = setTimeout(() => terminate("timed_out"), invocation.timeoutMs);
            timeout.unref?.();

            const onAbort = (): void => terminate("aborted");
            invocation.signal?.addEventListener("abort", onAbort, { once: true });
            if (invocation.signal?.aborted) onAbort();

            child.on("close", (exitCode) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (forceKillTimer) clearTimeout(forceKillTimer);
                invocation.signal?.removeEventListener("abort", onAbort);
                resolve({
                    exitCode,
                    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                    stderr: Buffer.concat(stderrChunks).toString("utf8"),
                    termination,
                    ...(spawnError ? { error: spawnError } : {}),
                });
            });
        });
}
