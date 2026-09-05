import type { AgentRecord } from "../domain/agent.ts";
import { ValidationError } from "../domain/errors.ts";
import { assertJsonValue, type JsonValue } from "../domain/validation.ts";
import type { SqliteControlPlaneStore } from "../storage/index.ts";

export interface CompletionArtifact {
    readonly path: string;
    readonly description?: string;
}

export interface CompletionPayload {
    readonly status: "succeeded" | "failed";
    readonly summary: string;
    readonly details?: JsonValue;
    readonly artifacts?: readonly CompletionArtifact[];
}

/** Durable declarations are the sole source of truth, including after restart. */
export class CompletionCoordinator {
    readonly store: SqliteControlPlaneStore;
    readonly identity: AgentRecord;
    readonly maximumBytes: number;
    constructor(store: SqliteControlPlaneStore, identity: AgentRecord, maximumBytes: number) {
        this.store = store;
        this.identity = identity;
        this.maximumBytes = maximumBytes;
    }

    declare(input: CompletionPayload, token: string): CompletionPayload {
        const payload = validateCompletion(input, this.maximumBytes);
        const unresolved = this.store.unresolvedRequiredMessages(this.identity.id);
        if (payload.status === "succeeded" && unresolved.length > 0) {
            throw new ValidationError(
                `Cannot complete with unresolved required mail: ${unresolved.map((message) => message.id).join(", ")}`,
                { messageIds: unresolved.map((message) => message.id) },
            );
        }
        this.store.declareCompletion({
            agentId: this.identity.id,
            runId: this.identity.runId,
            invocationToken: token,
            payload: payload as unknown as JsonValue,
        });
        return payload;
    }

    abort(): void {
        const declaration = this.store.getCompletion(this.identity.id);
        if (declaration?.runId === this.identity.runId && declaration.state === "declared") {
            this.store.invalidateCompletion(this.identity.id, declaration.invocationToken);
        }
    }

    settle(): boolean {
        const declaration = this.store.getCompletion(this.identity.id);
        if (declaration?.runId !== this.identity.runId || declaration.state === "invalidated") {
            return false;
        }
        if (declaration.state === "declared") {
            this.store.publishCompletion(
                this.identity.id,
                this.identity.runId,
                declaration.invocationToken,
            );
        }
        return true;
    }
}

function validateCompletion(input: CompletionPayload, maximumBytes: number): CompletionPayload {
    if (input.status !== "succeeded" && input.status !== "failed") {
        throw new ValidationError("completion status must be succeeded or failed");
    }
    if (
        typeof input.summary !== "string" ||
        input.summary.trim() !== input.summary ||
        input.summary.length === 0
    ) {
        throw new ValidationError("completion summary must be a non-empty, unpadded string");
    }
    if (input.details !== undefined) assertJsonValue(input.details, "details", maximumBytes);
    if (input.artifacts !== undefined && !Array.isArray(input.artifacts)) {
        throw new ValidationError("artifacts must be an array");
    }
    const artifacts = input.artifacts?.map((artifact) => {
        if (
            artifact === null ||
            typeof artifact !== "object" ||
            typeof artifact.path !== "string" ||
            artifact.path.length === 0
        ) {
            throw new ValidationError("artifact path must be a non-empty string");
        }
        if (
            artifact.description !== undefined &&
            (typeof artifact.description !== "string" || artifact.description.length === 0)
        ) {
            throw new ValidationError("artifact description must be a non-empty string");
        }
        return {
            path: artifact.path,
            ...(artifact.description === undefined ? {} : { description: artifact.description }),
        };
    });
    const normalized: CompletionPayload = {
        status: input.status,
        summary: input.summary,
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(artifacts === undefined ? {} : { artifacts }),
    };
    assertJsonValue(normalized as unknown as JsonValue, "completion", maximumBytes);
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > maximumBytes) {
        throw new ValidationError(`completion exceeds ${maximumBytes} UTF-8 bytes`);
    }
    return normalized;
}
