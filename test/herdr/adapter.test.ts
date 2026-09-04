import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    type CommandExecution,
    type CommandInvocation,
    type CommandRunner,
    HerdrAdapter,
    HerdrCommandError,
    type HerdrOwnedSurface,
    HerdrRenameError,
    HerdrValidationError,
} from "../../src/herdr/index.ts";

const ENV = { HERDR_ENV: "1" } as const;

function execution(result: unknown, overrides: Partial<CommandExecution> = {}): CommandExecution {
    return {
        exitCode: 0,
        stdout: `${JSON.stringify({ result })}\n`,
        stderr: "",
        termination: "exited",
        ...overrides,
    };
}

function failure(code: string, message: string): CommandExecution {
    return {
        exitCode: 1,
        stdout: "",
        stderr: `${JSON.stringify({ error: { code, message, details: { retryable: false } } })}\n`,
        termination: "exited",
    };
}

class FakeRunner {
    readonly calls: CommandInvocation[] = [];
    readonly #responses: Array<CommandExecution | Error>;

    constructor(...responses: Array<CommandExecution | Error>) {
        this.#responses = responses;
    }

    readonly run: CommandRunner = async (invocation) => {
        this.calls.push(invocation);
        const response = this.#responses.shift();
        if (!response) throw new Error(`Unexpected command: ${invocation.args.join(" ")}`);
        if (response instanceof Error) throw response;
        return response;
    };

    expectExhausted(): void {
        assert.equal(this.#responses.length, 0);
    }
}

function adapter(
    fake: FakeRunner,
    environment: Readonly<Record<string, string | undefined>> = ENV,
): HerdrAdapter {
    return new HerdrAdapter({
        runner: fake.run,
        environment,
        defaultTimeoutMs: 10_000,
        startupTimeoutMs: 30_000,
    });
}

async function createSurface(
    fake: FakeRunner,
    instance = adapter(fake),
): Promise<{ adapter: HerdrAdapter; surface: HerdrOwnedSurface }> {
    const surface = await instance.createSurface({
        alias: "reviewer",
        cwd: "/repo",
        workspaceId: "w1",
    });
    return { adapter: instance, surface };
}

async function createStartedSurface(
    fake: FakeRunner,
): Promise<{ adapter: HerdrAdapter; surface: HerdrOwnedSurface }> {
    const created = await createSurface(fake);
    await created.adapter.startPi(created.surface);
    return created;
}

describe("HerdrAdapter context and validation", () => {
    test("discovers complete current context from injected Herdr environment", async () => {
        const fake = new FakeRunner();
        const instance = adapter(fake, {
            HERDR_ENV: "1",
            HERDR_WORKSPACE_ID: "w7",
            HERDR_TAB_ID: "w7:t3",
            HERDR_PANE_ID: "w7:p9",
        });

        assert.deepEqual(await instance.discoverCurrentContext(), {
            workspaceId: "w7",
            tabId: "w7:t3",
            paneId: "w7:p9",
            source: "environment",
        });
        assert.equal(fake.calls.length, 0);
    });

    test("falls back to pane current with exact safe argv", async () => {
        const fake = new FakeRunner(
            execution({
                pane: { workspace_id: "w2", tab_id: "w2:t4", pane_id: "w2:p8" },
            }),
        );
        const instance = adapter(fake);

        assert.deepEqual(await instance.discoverCurrentContext({ timeoutMs: 777 }), {
            workspaceId: "w2",
            tabId: "w2:t4",
            paneId: "w2:p8",
            source: "cli",
        });
        assert.partialDeepStrictEqual(fake.calls[0], {
            executable: "herdr",
            args: ["pane", "current", "--current"],
            timeoutMs: 777,
        });
        fake.expectExhausted();
    });

    test("refuses control outside the calling Herdr environment", async () => {
        const fake = new FakeRunner();
        const instance = adapter(fake, {});
        await assert.rejects(instance.discoverCurrentContext(), HerdrValidationError);
        assert.equal(fake.calls.length, 0);
    });

    for (const alias of ["Reviewer", "1reviewer", "review.er", `a${"2".repeat(32)}`]) {
        test(`rejects invalid alias ${alias} before execution`, async () => {
            const fake = new FakeRunner();
            await assert.rejects(
                adapter(fake).createSurface({
                    alias,
                    cwd: "/repo",
                    workspaceId: "w1",
                }),
                HerdrValidationError,
            );
            assert.equal(fake.calls.length, 0);
        });
    }
});

describe("surface lifecycle", () => {
    test("creates a no-focus tab with explicit cwd, sorted env, and parsed IDs", async () => {
        const fake = new FakeRunner(
            execution({
                tab: { tab_id: "w1:t9", workspace_id: "w1" },
                root_pane: { pane_id: "w1:p12" },
            }),
        );
        const instance = adapter(fake);
        const surface = await instance.createSurface({
            alias: "builder",
            cwd: "/repo with spaces",
            workspaceId: "w1",
            label: "Builder: API",
            env: { ZETA: "last", API_TOKEN_FILE: "/tmp/a b" },
        });

        assert.deepEqual(fake.calls[0]?.args, [
            "tab",
            "create",
            "--workspace",
            "w1",
            "--cwd",
            "/repo with spaces",
            "--label",
            "Builder: API",
            "--env",
            "API_TOKEN_FILE=/tmp/a b",
            "--env",
            "ZETA=last",
            "--no-focus",
        ]);
        assert.partialDeepStrictEqual(surface, {
            workspaceId: "w1",
            tabId: "w1:t9",
            paneId: "w1:p12",
            cwd: "/repo with spaces",
            alias: "builder",
            tabLabel: "Builder: API",
            paneLabel: "Builder: API",
            agentStarted: false,
            closed: false,
        });
        fake.expectExhausted();
    });

    test("starts Pi with readiness and process deadlines plus native args after --", async () => {
        const fake = new FakeRunner(
            execution({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }),
            execution({ agent: { status: "idle" } }),
        );
        const { adapter: instance, surface } = await createSurface(fake);
        const result = await instance.startPi(surface, {
            readinessTimeoutMs: 45_000,
            args: ["--model", "openai/gpt-5", "--session", "/tmp/s p.jsonl"],
        });

        assert.partialDeepStrictEqual(fake.calls[1], {
            args: [
                "agent",
                "start",
                "reviewer",
                "--kind",
                "pi",
                "--pane",
                "w1:p1",
                "--timeout",
                "45000",
                "--",
                "--model",
                "openai/gpt-5",
                "--session",
                "/tmp/s p.jsonl",
            ],
            timeoutMs: 50_000,
        });
        assert.equal(result.status, "idle");
        assert.equal(surface.agentStarted, true);
        fake.expectExhausted();
    });

    test("rejects malformed success and preserves structured CLI errors", async () => {
        const malformed = new FakeRunner({
            exitCode: 0,
            stdout: "not json\n",
            stderr: "",
            termination: "exited",
        });
        await assert.rejects(
            adapter(malformed).createSurface({
                alias: "builder",
                cwd: "/repo",
                workspaceId: "w1",
            }),
            { name: "HerdrCommandError" },
        );

        const rejected = new FakeRunner(failure("duplicate_agent_name", "name is live"));
        try {
            await adapter(rejected).createSurface({
                alias: "builder",
                cwd: "/repo",
                workspaceId: "w1",
            });
            assert.fail("expected createSurface to reject");
        } catch (error) {
            assert.ok(error instanceof HerdrCommandError);
            assert.deepEqual(error.cliError, {
                code: "duplicate_agent_name",
                message: "name is live",
                details: { retryable: false },
            });
        }
    });

    test("closes only an exact surface owned by the same adapter", async () => {
        const fake = new FakeRunner(
            execution({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }),
            execution({ type: "tab_closed" }),
        );
        const { adapter: instance, surface } = await createSurface(fake);
        const forged = { ...surface };

        await assert.rejects(instance.close(forged), /not explicitly owned/);
        await instance.close(surface);
        assert.deepEqual(fake.calls[1]?.args, ["tab", "close", "w1:t1"]);
        assert.equal(surface.closed, true);
        await assert.rejects(instance.close(surface), /not explicitly owned/);
        fake.expectExhausted();
    });
});

describe("live agent control", () => {
    test("uses agent-native prompt, steer, interrupt, wait, inspect, and read argv", async () => {
        const fake = new FakeRunner(
            execution({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }),
            execution({ status: "idle" }),
            execution({ status: "done" }),
            execution({ status: "working" }),
            execution({ status: "idle" }),
            execution({ status: "blocked" }),
            execution({ agent: { name: "reviewer", pane_id: "w1:p1", status: "working" } }),
            execution({ text: "full transcript", source: "recent-unwrapped" }),
        );
        const { adapter: instance, surface } = await createStartedSurface(fake);
        await instance.prompt(surface, "review this", {
            wait: true,
            until: ["done", "blocked"],
            timeoutMs: 90_000,
        });
        await instance.steer(surface, "focus on auth", { timeoutMs: 4_000 });
        await instance.interrupt(surface);
        await instance.wait(surface, { until: ["idle", "blocked"], timeoutMs: 80_000 });
        assert.partialDeepStrictEqual(await instance.inspect(surface), {
            alias: "reviewer",
            paneId: "w1:p1",
            status: "working",
        });
        assert.partialDeepStrictEqual(await instance.read(surface, { lines: 42 }), {
            text: "full transcript",
            source: "recent-unwrapped",
        });

        assert.deepEqual(
            fake.calls.slice(2).map((call) => call.args),
            [
                [
                    "agent",
                    "prompt",
                    "reviewer",
                    "review this",
                    "--wait",
                    "--until",
                    "done",
                    "--until",
                    "blocked",
                    "--timeout",
                    "90000",
                ],
                ["agent", "prompt", "reviewer", "focus on auth", "--timeout", "4000"],
                ["agent", "send-keys", "reviewer", "esc"],
                [
                    "agent",
                    "wait",
                    "reviewer",
                    "--until",
                    "idle",
                    "--until",
                    "blocked",
                    "--timeout",
                    "80000",
                ],
                ["agent", "get", "reviewer"],
                [
                    "agent",
                    "read",
                    "reviewer",
                    "--source",
                    "recent-unwrapped",
                    "--lines",
                    "42",
                    "--format",
                    "text",
                ],
            ],
        );
        fake.expectExhausted();
    });

    test("passes AbortSignal through and classifies aborted execution", async () => {
        const controller = new AbortController();
        const fake = new FakeRunner(
            execution({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }),
            execution({ status: "idle" }),
            {
                exitCode: null,
                stdout: "",
                stderr: "",
                termination: "aborted",
            },
        );
        const { adapter: instance, surface } = await createStartedSurface(fake);

        await assert.rejects(instance.wait(surface, { signal: controller.signal }), /aborted/);
        assert.equal(fake.calls[2]?.signal, controller.signal);
    });
});

describe("transactional rename", () => {
    test("renames live alias, pane, and exact target tab in order", async () => {
        const fake = new FakeRunner(
            execution({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }),
            execution({ status: "idle" }),
            execution({ type: "agent_renamed" }),
            execution({ type: "pane_renamed" }),
            execution({ type: "tab_renamed" }),
        );
        const { adapter: instance, surface } = await createStartedSurface(fake);
        await instance.rename(surface, "api_reviewer", "API Reviewer");

        assert.deepEqual(
            fake.calls.slice(2).map((call) => call.args),
            [
                ["agent", "rename", "reviewer", "api_reviewer"],
                ["pane", "rename", "w1:p1", "API Reviewer"],
                ["tab", "rename", "w1:t1", "API Reviewer"],
            ],
        );
        assert.partialDeepStrictEqual(surface, {
            alias: "api_reviewer",
            paneLabel: "API Reviewer",
            tabLabel: "API Reviewer",
        });
        fake.expectExhausted();
    });

    test("reports tab failure and rolls pane and alias back in reverse order", async () => {
        const fake = new FakeRunner(
            execution({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }),
            execution({ status: "idle" }),
            execution({}),
            execution({}),
            failure("tab_not_found", "tab disappeared"),
            execution({}),
            execution({}),
        );
        const { adapter: instance, surface } = await createStartedSurface(fake);

        try {
            await instance.rename(surface, "api_reviewer", "API Reviewer");
            assert.fail("expected rename to reject");
        } catch (error) {
            assert.ok(error instanceof HerdrRenameError);
            assert.partialDeepStrictEqual(error.report, {
                failedStep: "tab",
                appliedSteps: ["agent", "pane"],
                rollback: [
                    { step: "pane", status: "succeeded" },
                    { step: "agent", status: "succeeded" },
                ],
            });
        }
        assert.deepEqual(
            fake.calls.slice(2).map((call) => call.args),
            [
                ["agent", "rename", "reviewer", "api_reviewer"],
                ["pane", "rename", "w1:p1", "API Reviewer"],
                ["tab", "rename", "w1:t1", "API Reviewer"],
                ["pane", "rename", "w1:p1", "reviewer"],
                ["agent", "rename", "api_reviewer", "reviewer"],
            ],
        );
        assert.partialDeepStrictEqual(surface, {
            alias: "reviewer",
            paneLabel: "reviewer",
            tabLabel: "reviewer",
        });
        fake.expectExhausted();
    });

    test("exposes rollback failure and retains the known partial live state", async () => {
        const fake = new FakeRunner(
            execution({ tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } }),
            execution({ status: "idle" }),
            execution({}),
            execution({}),
            failure("tab_not_found", "tab disappeared"),
            execution({}),
            failure("duplicate_agent_name", "old name was claimed"),
        );
        const { adapter: instance, surface } = await createStartedSurface(fake);

        try {
            await instance.rename(surface, "api_reviewer", "API Reviewer");
            assert.fail("expected rename to reject");
        } catch (error) {
            const report = (error as HerdrRenameError).report;
            assert.partialDeepStrictEqual(report.rollback[1], {
                step: "agent",
                status: "failed",
            });
            assert.equal(report.rollback[1]?.error?.cliError?.code, "duplicate_agent_name");
        }
        assert.partialDeepStrictEqual(surface, {
            alias: "api_reviewer",
            paneLabel: "reviewer",
            tabLabel: "reviewer",
        });
        fake.expectExhausted();
    });
});
