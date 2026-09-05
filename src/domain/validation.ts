import { ValidationError } from "./errors.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
    | JsonPrimitive
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

export const MAX_ALIAS_LENGTH = 32;
export const MAX_MESSAGE_BYTES = 1_048_576;
export const MAX_METADATA_BYTES = 65_536;
export const MAX_PAGE_SIZE = 100;

const ALIAS_PATTERN = /^[a-z][a-z0-9_-]*$/;

export function validateAlias(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_ALIAS_LENGTH ||
        !ALIAS_PATTERN.test(value)
    ) {
        throw new ValidationError(
            "alias must match Herdr live aliases: a lowercase letter followed by up to 31 lowercase letters, digits, underscores, or hyphens",
            { field: "alias" },
        );
    }
    return value;
}

export function validateLabel(value: unknown, field: string, maxLength = 128): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        value.trim() !== value
    ) {
        throw new ValidationError(
            `${field} must be a non-empty, unpadded string of at most ${maxLength} characters`,
            { field },
        );
    }
    return value;
}

export function validateOptionalLabel(
    value: unknown,
    field: string,
    maxLength = 256,
): string | undefined {
    if (value === undefined) return undefined;
    return validateLabel(value, field, maxLength);
}

export function validateNonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new ValidationError(`${field} must be a non-negative safe integer`, { field });
    }
    return value;
}

export function validatePositiveInteger(
    value: unknown,
    field: string,
    maximum = Number.MAX_SAFE_INTEGER,
): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > maximum
    ) {
        throw new ValidationError(
            `${field} must be a positive safe integer no greater than ${maximum}`,
            { field },
        );
    }
    return value;
}

export function validatePageLimit(value: unknown): number {
    return validatePositiveInteger(value ?? 50, "limit", MAX_PAGE_SIZE);
}

export function assertJsonValue(
    value: unknown,
    field: string,
    maximumBytes = MAX_METADATA_BYTES,
): asserts value is JsonValue {
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(value);
    } catch (cause) {
        throw new ValidationError(`${field} must be JSON serializable`, {
            field,
            cause: String(cause),
        });
    }
    if (serialized === undefined) {
        throw new ValidationError(`${field} must be a JSON value`, { field });
    }
    if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
        throw new ValidationError(`${field} exceeds ${maximumBytes} bytes`, { field });
    }
    if (!isJsonValue(value)) {
        throw new ValidationError(`${field} contains an unsupported JSON value`, { field });
    }
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (typeof value !== "object") return false;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        return false;
    return Object.entries(value).every(([key, item]) => key.length > 0 && isJsonValue(item));
}
