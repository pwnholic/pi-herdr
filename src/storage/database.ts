import Database from "better-sqlite3";
import { StorageClosedError, ValidationError } from "../domain/errors.ts";
import { validateNonNegativeInteger, validatePositiveInteger } from "../domain/validation.ts";
import type { Failpoint } from "../faults.ts";
import { migrate } from "./migrations.ts";

export interface Clock {
    now(): number;
}

export interface OpenStoreOptions {
    readonly filename: string;
    readonly busyTimeoutMs?: number;
    readonly clock?: Clock;
    readonly failpoint?: Failpoint;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class StorageDatabase {
    readonly #connection: Database.Database;
    readonly #clock: Clock;
    readonly #failpoint: Failpoint | undefined;
    #closed = false;

    constructor(options: OpenStoreOptions) {
        if (typeof options.filename !== "string" || options.filename.length === 0) {
            throw new ValidationError("filename must be a non-empty string", { field: "filename" });
        }
        const busyTimeoutMs = validatePositiveInteger(
            options.busyTimeoutMs ?? 5_000,
            "busyTimeoutMs",
            60_000,
        );
        this.#clock = options.clock ?? SYSTEM_CLOCK;
        this.#failpoint = options.failpoint;
        this.#connection = new Database(options.filename);

        try {
            this.#connection.pragma(`busy_timeout = ${busyTimeoutMs}`);
            this.#connection.pragma("foreign_keys = ON");
            this.#connection.pragma("synchronous = NORMAL");
            this.#connection.pragma("trusted_schema = OFF");
            const journalMode = this.#connection.pragma("journal_mode = WAL", { simple: true });
            if (journalMode !== "wal" && journalMode !== "memory") {
                throw new Error(`SQLite rejected WAL journal mode: ${String(journalMode)}`);
            }
            if (this.#connection.pragma("foreign_keys", { simple: true }) !== 1) {
                throw new Error("SQLite foreign key enforcement could not be enabled");
            }
            migrate(this.#connection, this.now());
        } catch (cause) {
            this.#connection.close();
            throw cause;
        }
    }

    get connection(): Database.Database {
        if (this.#closed) throw new StorageClosedError();
        return this.#connection;
    }

    now(): number {
        return validateNonNegativeInteger(this.#clock.now(), "clock.now()");
    }

    hit(point: string, context?: Readonly<Record<string, unknown>>): void {
        this.#failpoint?.(point, context);
    }

    close(): void {
        if (this.#closed) return;
        this.#connection.close();
        this.#closed = true;
    }
}

export function isSqliteConstraintError(cause: unknown): boolean {
    if (!(cause instanceof Error)) return false;
    const code = (cause as Error & { code?: unknown }).code;
    return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}
