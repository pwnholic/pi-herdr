import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    type CommandExecution,
    type CommandInvocation,
    type CommandRunner,
    HerdrAdapter,
    HerdrCommandError,
    HerdrValidationError,
    type PersistedHerdrSurface,
} from "../../src/herdr/index.ts";

const RECORD: PersistedHerdrSurface = {
    ownershipId: "c91cbff8-f220-4018-8191-67a6c360d311",
    workspaceId: "w4",
    tabId: "w4:t8",
    paneId: "w4:p12",
    cwd: "/repo",
    alias: "reviewer",
    paneLabel: "Reviewer",
    tabLabel: "Reviewer",
    agentStarted: true,
    closed: false,
};

function success(result: unknown): CommandExecution {
    return {
        exitCode: 0,
        stdout: `${JSON.stringify({ result })}\n`,
        stderr: "",
        termination: "exited",
    };
}

class QueueRunner {
    readonly calls: CommandInvocation[] = [];
    readonly #responses: CommandExecution[];

    constructor(...responses: CommandExecution[]) {
        this.#responses = responses;
    }

    readonly run: CommandRunner = async (invocation) => {
        this.calls.push(invocation);
        const response = this.#responses.shift();
        if (!response) throw new Error(`Unexpected command: ${invocation.args.join(" ")}`);
        return response;
    };

    assertExhausted(): void {
        assert.equal(this.#responses.length, 0);
    }
}

function adapter(runner: QueueRunner): HerdrAdapter {
    return new HerdrAdapter({
        runner: runner.run,
        environment: { HERDR_ENV: "1" },
        defaultTimeoutMs: 10_000,
    });
}

function liveAgent(overrides: Record<string, unknown> = {}): CommandExecution {
    return success({
        agent: {
            name: RECORD.alias,
            pane_id: RECORD.paneId,
            status: "working",
            ...overrides,
        },
    });
}

function livePane(overrides: Record<string, unknown> = {}): CommandExecution {
    return success({
        pane: {
            pane_id: RECORD.paneId,
            tab_id: RECORD.tabId,
            workspace_id: RECORD.workspaceId,
            agent_name: RECORD.alias,
            // A lifecycle transition between get calls is valid and must not
            // invalidate an otherwise stable identity/topology proof.
            agent_status: "idle",
            ...overrides,
        },
    });
}

describe("Herdr surface recovery", () => {
    test("re-adopts only after exact native identity and topology verification", async () => {
        const runner = new QueueRunner(liveAgent(), livePane(), success({ type: "tab_closed" }));
        const instance = adapter(runner);

        const recovered = await instance.recoverSurface(RECORD, { timeoutMs: 5_000 });
        assert.deepEqual(
            runner.calls.slice(0, 2).map(({ args }) => args),
            [
                ["agent", "get", "reviewer"],
                ["pane", "get", "w4:p12"],
            ],
        );
        assert.equal(runner.calls[0]?.timeoutMs, 5_000);
        assert.notEqual(recovered, RECORD);
        assert.deepEqual(instance.snapshotSurface(recovered), RECORD);

        const forged = { ...recovered };
        await assert.rejects(instance.close(forged), /not explicitly owned/);
        await instance.close(recovered);
        assert.deepEqual(runner.calls[2]?.args, ["tab", "close", "w4:t8"]);
        runner.assertExhausted();
    });

    for (const [name, response, message] of [
        ["alias", liveAgent({ name: "someone_else" }), /alias/],
        ["pane", liveAgent({ pane_id: "w4:p99" }), /live pane/],
        ["status", liveAgent({ status: "paused" }), /status/],
    ] as const) {
        test(`rejects live ${name} mismatch without adopting`, async () => {
            const runner = new QueueRunner(response);
            const instance = adapter(runner);
            await assert.rejects(instance.recoverSurface(RECORD), message);
            await assert.rejects(instance.close(RECORD), /not explicitly owned/);
            assert.equal(runner.calls.length, 1);
            runner.assertExhausted();
        });
    }

    for (const [field, override] of [
        ["pane", { pane_id: "w4:p99" }],
        ["tab", { tab_id: "w4:t99" }],
        ["workspace", { workspace_id: "w99" }],
        ["agent", { agent_name: "someone_else" }],
        ["status", { agent_status: "paused" }],
    ] as const) {
        test(`rejects pane ${field} mismatch without adopting`, async () => {
            const runner = new QueueRunner(liveAgent(), livePane(override));
            const instance = adapter(runner);
            await assert.rejects(instance.recoverSurface(RECORD), HerdrCommandError);
            await assert.rejects(instance.close(RECORD), /not explicitly owned/);
            assert.equal(runner.calls.length, 2);
            runner.assertExhausted();
        });
    }

    test("rejects closed records before contacting Herdr", async () => {
        const runner = new QueueRunner();
        await assert.rejects(
            adapter(runner).recoverSurface({ ...RECORD, closed: true }),
            /closed surface/,
        );
        assert.equal(runner.calls.length, 0);
    });

    test("rejects duplicate ownership and duplicate location before new commands", async () => {
        const runner = new QueueRunner(liveAgent(), livePane());
        const instance = adapter(runner);
        await instance.recoverSurface(RECORD);

        await assert.rejects(instance.recoverSurface(RECORD), /ownershipId is already adopted/);
        await assert.rejects(
            instance.recoverSurface({
                ...RECORD,
                ownershipId: "5db416d2-031e-4ec4-ad71-486bc47b4153",
            }),
            /tab\/pane is already adopted/,
        );
        assert.equal(runner.calls.length, 2);
        runner.assertExhausted();
    });

    test("a persisted snapshot is detached and cannot impersonate the live capability", async () => {
        const runner = new QueueRunner(liveAgent(), livePane());
        const instance = adapter(runner);
        const recovered = await instance.recoverSurface(RECORD);
        const snapshot = instance.snapshotSurface(recovered);

        assert.notEqual(snapshot, recovered);
        await assert.rejects(instance.close(snapshot), HerdrValidationError);
        runner.assertExhausted();
    });
});
