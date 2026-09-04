import type { CommandExecution, CommandInvocation } from "./executor.ts";

export interface HerdrCliErrorBody {
    readonly code?: string;
    readonly message?: string;
    readonly details?: unknown;
}

export class HerdrValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HerdrValidationError";
    }
}

export class HerdrCommandError extends Error {
    readonly invocation: CommandInvocation;
    readonly execution: CommandExecution | undefined;
    readonly cliError: HerdrCliErrorBody | undefined;

    constructor(
        message: string,
        invocation: CommandInvocation,
        options: {
            readonly execution?: CommandExecution;
            readonly cliError?: HerdrCliErrorBody;
            readonly cause?: unknown;
        } = {},
    ) {
        super(message, { cause: options.cause });
        this.name = "HerdrCommandError";
        this.invocation = invocation;
        this.execution = options.execution;
        this.cliError = options.cliError;
    }
}

export type HerdrRenameStep = "agent" | "pane" | "tab";

export interface HerdrRenameRollback {
    readonly step: HerdrRenameStep;
    readonly status: "succeeded" | "failed";
    readonly error?: HerdrCommandError;
}

export interface HerdrRenameFailure {
    readonly fromAlias: string;
    readonly toAlias: string;
    /** @deprecated Use fromPaneLabel/fromTabLabel for exact recovery state. */
    readonly fromLabel: string;
    readonly fromPaneLabel: string;
    readonly fromTabLabel: string;
    readonly toLabel: string;
    readonly failedStep: HerdrRenameStep;
    readonly appliedSteps: readonly HerdrRenameStep[];
    readonly rollback: readonly HerdrRenameRollback[];
}

export class HerdrRenameError extends Error {
    readonly report: HerdrRenameFailure;
    readonly commandError: HerdrCommandError;

    constructor(report: HerdrRenameFailure, commandError: HerdrCommandError) {
        super(
            `Herdr rename failed at ${report.failedStep}; applied=${report.appliedSteps.join(",") || "none"}; rollback=${report.rollback.map((entry) => `${entry.step}:${entry.status}`).join(",") || "none"}`,
            { cause: commandError },
        );
        this.name = "HerdrRenameError";
        this.report = report;
        this.commandError = commandError;
    }
}
