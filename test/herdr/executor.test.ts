import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeCommandRunner } from "../../src/herdr/index.ts";

test("node runner preserves literal argv without a shell", async () => {
    const runner = createNodeCommandRunner();
    const literal = "$(printf injected); spaces ' quotes";
    const result = await runner({
        executable: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", literal],
        timeoutMs: 5_000,
    });

    assert.equal(result.termination, "exited");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, literal);
});

test("node runner enforces timeout and terminates the child", async () => {
    const runner = createNodeCommandRunner({ forceKillAfterMs: 10 });
    const result = await runner({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 25,
    });

    assert.equal(result.termination, "timed_out");
    assert.notEqual(result.exitCode, 0);
});

test("node runner does not spawn a command when already aborted", async () => {
    const runner = createNodeCommandRunner();
    const controller = new AbortController();
    controller.abort();
    const result = await runner({
        executable: "/definitely/not/an/executable",
        args: [],
        timeoutMs: 5_000,
        signal: controller.signal,
    });

    assert.equal(result.termination, "aborted");
    assert.equal(result.exitCode, null);
});
