import type { AgentId } from "./ids.ts";
import type { JsonValue } from "./validation.ts";

export const AGENT_STATUSES = [
    "registered",
    "starting",
    "running",
    "idle",
    "blocked",
    "interrupted",
    "stopping",
    "stopped",
    "completed",
    "failed",
    "orphaned",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface AgentRecord {
    readonly id: AgentId;
    readonly runId: string;
    readonly alias: string;
    readonly displayName: string;
    readonly role: string;
    readonly status: AgentStatus;
    readonly sessionId?: string;
    readonly sessionFile?: string;
    readonly workspaceId?: string;
    readonly tabId?: string;
    readonly paneId?: string;
    readonly parentAgentId?: AgentId;
    readonly rootAgentId: AgentId;
    readonly metadata: JsonValue;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly lastSeenAt: number;
    readonly revision: number;
    readonly leaseOwner?: string;
    readonly leaseExpiresAt?: number;
}

export interface RegisterAgentInput {
    readonly id?: AgentId;
    readonly runId?: string;
    readonly alias: string;
    readonly displayName?: string;
    readonly role: string;
    readonly sessionId?: string;
    readonly sessionFile?: string;
    readonly workspaceId?: string;
    readonly tabId?: string;
    readonly paneId?: string;
    readonly parentAgentId?: AgentId;
    readonly rootAgentId?: AgentId;
    readonly metadata?: JsonValue;
}

export interface AgentPatch {
    readonly sessionId?: string | null;
    readonly sessionFile?: string | null;
    readonly workspaceId?: string | null;
    readonly tabId?: string | null;
    readonly paneId?: string | null;
    readonly metadata?: JsonValue;
}

export interface AgentPage {
    readonly items: readonly AgentRecord[];
    readonly nextCursor?: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<AgentStatus, ReadonlySet<AgentStatus>>> = {
    registered: new Set(["starting", "stopping", "stopped"]),
    starting: new Set(["running", "idle", "blocked", "failed", "stopping", "stopped", "orphaned"]),
    running: new Set([
        "idle",
        "blocked",
        "interrupted",
        "stopping",
        "completed",
        "failed",
        "orphaned",
    ]),
    idle: new Set([
        "running",
        "blocked",
        "interrupted",
        "stopping",
        "completed",
        "failed",
        "orphaned",
    ]),
    blocked: new Set(["running", "idle", "interrupted", "stopping", "failed", "orphaned"]),
    interrupted: new Set(["running", "stopping", "stopped", "failed", "orphaned"]),
    stopping: new Set(["stopped", "failed", "orphaned"]),
    stopped: new Set(["starting"]),
    completed: new Set(["starting"]),
    failed: new Set(["starting", "stopped"]),
    orphaned: new Set(["starting", "running", "idle", "blocked", "stopping", "stopped", "failed"]),
};

export function isAgentStatus(value: unknown): value is AgentStatus {
    return typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value);
}

export function canTransitionAgent(from: AgentStatus, to: AgentStatus): boolean {
    return from !== to && ALLOWED_TRANSITIONS[from].has(to);
}
