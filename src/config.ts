import { isAbsolute, join, resolve } from "node:path";

export interface OrchestratorConfig {
    readonly databasePath: string;
    readonly maxLiveAgents: number;
    readonly maxMessageBytes: number;
    readonly maxResultBytes: number;
    readonly maxPageSize: number;
    readonly launchTimeoutMs: number;
    readonly operationTimeoutMs: number;
    readonly leaseDurationMs: number;
    readonly messageTtlMs: number;
    readonly completionPollMs: number;
}

export interface ConfigContext {
    readonly sessionDir: string;
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULTS = {
    maxLiveAgents: 8,
    maxMessageBytes: 64 * 1024,
    maxResultBytes: 256 * 1024,
    maxPageSize: 100,
    launchTimeoutMs: 30_000,
    operationTimeoutMs: 15_000,
    leaseDurationMs: 60_000,
    messageTtlMs: 7 * 24 * 60 * 60 * 1000,
    completionPollMs: 500,
} as const;

function integer(
    env: Readonly<Record<string, string | undefined>>,
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}`);
    }
    return value;
}

export function resolveConfig(context: ConfigContext): OrchestratorConfig {
    const env = context.env ?? process.env;
    const configuredPath = env.PI_HERDR_DB?.trim();
    const databasePath = configuredPath
        ? isAbsolute(configuredPath)
            ? configuredPath
            : resolve(context.cwd, configuredPath)
        : join(context.sessionDir, "pi-herdr", "control.sqlite");

    return {
        databasePath,
        maxLiveAgents: integer(env, "PI_HERDR_MAX_AGENTS", DEFAULTS.maxLiveAgents, 1, 64),
        maxMessageBytes: integer(
            env,
            "PI_HERDR_MAX_MESSAGE_BYTES",
            DEFAULTS.maxMessageBytes,
            1_024,
            1024 * 1024,
        ),
        maxResultBytes: integer(
            env,
            "PI_HERDR_MAX_RESULT_BYTES",
            DEFAULTS.maxResultBytes,
            1_024,
            4 * 1024 * 1024,
        ),
        maxPageSize: integer(env, "PI_HERDR_MAX_PAGE_SIZE", DEFAULTS.maxPageSize, 1, 500),
        launchTimeoutMs: integer(
            env,
            "PI_HERDR_LAUNCH_TIMEOUT_MS",
            DEFAULTS.launchTimeoutMs,
            3_001,
            300_000,
        ),
        operationTimeoutMs: integer(
            env,
            "PI_HERDR_OPERATION_TIMEOUT_MS",
            DEFAULTS.operationTimeoutMs,
            250,
            300_000,
        ),
        leaseDurationMs: integer(
            env,
            "PI_HERDR_LEASE_DURATION_MS",
            DEFAULTS.leaseDurationMs,
            5_000,
            60 * 60 * 1000,
        ),
        messageTtlMs: integer(
            env,
            "PI_HERDR_MESSAGE_TTL_MS",
            DEFAULTS.messageTtlMs,
            60_000,
            90 * 24 * 60 * 60 * 1000,
        ),
        completionPollMs: integer(
            env,
            "PI_HERDR_COMPLETION_POLL_MS",
            DEFAULTS.completionPollMs,
            100,
            60_000,
        ),
    };
}

export const DEFAULT_ORCHESTRATOR_LIMITS = DEFAULTS;
