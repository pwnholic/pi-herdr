export type ControlPlaneErrorCode =
    | "VALIDATION_FAILED"
    | "NOT_FOUND"
    | "CONFLICT"
    | "REVISION_CONFLICT"
    | "INVALID_TRANSITION"
    | "LEASE_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "STORAGE_CLOSED"
    | "MIGRATION_FAILED";

export interface ErrorOptions {
    readonly cause?: unknown;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly retryable?: boolean;
}

export class ControlPlaneError extends Error {
    readonly code: ControlPlaneErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly retryable: boolean;

    constructor(code: ControlPlaneErrorCode, message: string, options: ErrorOptions = {}) {
        super(message, { cause: options.cause });
        this.name = new.target.name;
        this.code = code;
        this.details = Object.freeze({ ...options.details });
        this.retryable = options.retryable ?? false;
    }
}

export class ValidationError extends ControlPlaneError {
    constructor(message: string, details?: Readonly<Record<string, unknown>>) {
        super("VALIDATION_FAILED", message, details === undefined ? {} : { details });
    }
}

export class NotFoundError extends ControlPlaneError {
    constructor(entity: string, identifier: string) {
        super("NOT_FOUND", `${entity} not found: ${identifier}`, {
            details: { entity, identifier },
        });
    }
}

export class ConflictError extends ControlPlaneError {
    constructor(message: string, details?: Readonly<Record<string, unknown>>, cause?: unknown) {
        super("CONFLICT", message, {
            ...(cause === undefined ? {} : { cause }),
            ...(details === undefined ? {} : { details }),
        });
    }
}

export class RevisionConflictError extends ControlPlaneError {
    constructor(entity: string, identifier: string, expected: number, actual: number) {
        super("REVISION_CONFLICT", `Stale ${entity} revision for ${identifier}`, {
            details: { entity, identifier, expected, actual },
            retryable: true,
        });
    }
}

export class InvalidTransitionError extends ControlPlaneError {
    constructor(entity: string, identifier: string, from: string, to: string) {
        super("INVALID_TRANSITION", `Invalid ${entity} transition ${from} -> ${to}`, {
            details: { entity, identifier, from, to },
        });
    }
}

export class LeaseConflictError extends ControlPlaneError {
    constructor(entity: string, identifier: string, owner?: string) {
        super("LEASE_CONFLICT", `Active lease prevents mutation of ${entity} ${identifier}`, {
            details: { entity, identifier, owner },
            retryable: true,
        });
    }
}

export class IdempotencyConflictError extends ControlPlaneError {
    constructor(scope: string, key: string) {
        super("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", {
            details: { scope, key },
        });
    }
}

export class StorageClosedError extends ControlPlaneError {
    constructor() {
        super("STORAGE_CLOSED", "Control-plane storage is closed");
    }
}

export class MigrationError extends ControlPlaneError {
    constructor(message: string, cause?: unknown) {
        super("MIGRATION_FAILED", message, { cause });
    }
}
