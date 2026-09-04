import { ValidationError } from "../domain/errors.ts";
import { validateNonNegativeInteger } from "../domain/validation.ts";

type CursorKind = "agents" | "messages" | "workflows";

interface CursorPayload {
    readonly v: 1;
    readonly kind: CursorKind;
    readonly createdAt: number;
    readonly id: string;
}

export function encodeCursor(kind: CursorKind, createdAt: number, id: string): string {
    const payload: CursorPayload = { v: 1, kind, createdAt, id };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(
    value: unknown,
    kind: CursorKind,
): { readonly createdAt: number; readonly id: string } | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
        throw new ValidationError("cursor is invalid", { field: "cursor" });
    }

    try {
        const payload = JSON.parse(
            Buffer.from(value, "base64url").toString("utf8"),
        ) as Partial<CursorPayload>;
        if (
            payload.v !== 1 ||
            payload.kind !== kind ||
            typeof payload.id !== "string" ||
            payload.id.length === 0
        ) {
            throw new Error("cursor shape mismatch");
        }
        return {
            createdAt: validateNonNegativeInteger(payload.createdAt, "cursor.createdAt"),
            id: payload.id,
        };
    } catch (cause) {
        if (cause instanceof ValidationError) throw cause;
        throw new ValidationError("cursor is invalid", { field: "cursor" });
    }
}
