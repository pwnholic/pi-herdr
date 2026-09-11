import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

const client = fileURLToPath(new URL("../fixtures/execution-client.ts", import.meta.url));
type Reply = { type: string; epoch?: number; errors?: string[]; released?: boolean };

function reply(child: ChildProcess): Promise<Reply> {
    return once(child, "message", { signal: AbortSignal.timeout(10_000) }).then(
        ([message]) => message as Reply,
    );
}

async function request(child: ChildProcess, message: object): Promise<Reply> {
    const pending = reply(child);
    child.send(message);
    return pending;
}

async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "pi-herdr-execution-process-"));
    const filename = join(directory, "control.sqlite");
    const store = SqliteControlPlaneStore.open({ filename });
    const parent = store.registerAgent({ alias: "parent", role: "coordinator" });
    let agent = store.registerAgent({
        alias: "worker",
        role: "worker",
        parentAgentId: parent.id,
        sessionId: "session",
    });
    for (const status of ["starting", "running"] as const) {
        agent = store.transitionAgent({
            agentId: agent.id,
            status,
            expectedRevision: agent.revision,
            patch: {},
        });
    }
    const children: ChildProcess[] = [];
    const spawn = (owner: string, now: number) => {
        const child = fork(
            client,
            [filename, agent.id, agent.runId, "session", owner, String(now)],
            {
                execArgv: ["--experimental-strip-types"],
                stdio: ["ignore", "ignore", "inherit", "ipc"],
            },
        );
        children.push(child);
        return { child, ready: reply(child) };
    };
    return {
        store,
        parent,
        agent,
        spawn,
        close: async () => {
            await Promise.all(
                children.map(async (child) => {
                    if (child.exitCode === null && child.signalCode === null) {
                        const exited = once(child, "exit");
                        child.kill("SIGKILL");
                        await exited;
                    }
                }),
            );
            store.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

test("two real processes competing for the same execution acquire exactly one lease", async () => {
    const f = await fixture();
    try {
        const a = f.spawn("a", 1000),
            b = f.spawn("b", 1000);
        const results = await Promise.all([a.ready, b.ready]);
        assert.equal(results.filter((r) => r.type === "acquired").length, 1);
        assert.equal(results.filter((r) => r.type === "conflict").length, 1);
        assert.equal(results.find((r) => r.type === "acquired")?.epoch, 1);
    } finally {
        await f.close();
    }
});

test("real stale process cannot send, publish, renew, or release after another process takes over", async () => {
    const f = await fixture();
    try {
        const a = f.spawn("a", 1000);
        assert.equal((await a.ready).epoch, 1);
        assert.equal((await request(a.child, { type: "declare" })).type, "declared");
        const b = f.spawn("b", 1100);
        assert.equal((await b.ready).epoch, 2);
        const result = await request(a.child, { type: "probe", recipient: f.parent.id });
        assert.equal(result.errors?.length, 3);
        for (const error of result.errors ?? []) assert.match(error, /execution/);
        assert.equal(result.released, false);
        assert.equal(f.store.listMessages({ recipientAgentId: f.parent.id }).items.length, 0);
        assert.equal(f.store.getCompletion(f.agent.id)?.state, "invalidated");
    } finally {
        await f.close();
    }
});

test("SIGKILL leaves an exclusive lease until expiry; recovery advances the durable epoch", async () => {
    const f = await fixture();
    try {
        const a = f.spawn("a", 1000);
        assert.equal((await a.ready).epoch, 1);
        await request(a.child, { type: "declare" });
        const exited = once(a.child, "exit");
        a.child.kill("SIGKILL");
        const [, signal] = await exited;
        assert.equal(signal, "SIGKILL");
        const early = f.spawn("early", 1099);
        assert.equal((await early.ready).type, "conflict");
        const recovered = f.spawn("recovered", 1100);
        assert.equal((await recovered.ready).epoch, 2);
        assert.equal(f.store.getCompletion(f.agent.id)?.state, "invalidated");
        assert.equal((await request(recovered.child, { type: "release" })).type, "released");
        const restarted = f.spawn("restarted", 1100);
        assert.equal((await restarted.ready).epoch, 3);
    } finally {
        await f.close();
    }
});
