export type OrchestratorErrorCode =
    | "NOT_READY"
    | "LIMIT_EXCEEDED"
    | "EXTERNAL_OPERATION_FAILED"
    | "RECOVERY_FAILED"
    | "SESSION_INVALID";

export interface OrchestratorErrorOptions {
    readonly cause?: unknown;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly retryable?: boolean;
}

export class OrchestratorError extends Error {
    readonly code: OrchestratorErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly retryable: boolean;

    constructor(
        code: OrchestratorErrorCode,
        message: string,
        options: OrchestratorErrorOptions = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = new.target.name;
        this.code = code;
        this.details = Object.freeze({ ...options.details });
        this.retryable = options.retryable ?? false;
    }
}
