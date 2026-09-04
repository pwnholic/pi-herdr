import { createHash } from "node:crypto";
import type { JsonValue } from "../domain/validation.ts";

export function canonicalJson(value: JsonValue): string {
    return JSON.stringify(canonicalize(value));
}

export function parseStoredJson(value: string): JsonValue {
    return JSON.parse(value) as JsonValue;
}

export function intentHash(value: JsonValue): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalize(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, item]) => [key, canonicalize(item)]),
        );
    }
    return value;
}
