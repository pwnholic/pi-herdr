import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

const execute = promisify(execFile);
const client = fileURLToPath(new URL("../fixtures/completion-crash-client.ts", import.meta.url));

for (const point of [
    "completion.publish.after_enqueue",
    "completion.publish.before_commit",
    "after_commit",
]) {
    test(`real process SIGKILL at ${point} preserves atomic completion and retry identity`, async () => {
        const directory = mkdtempSync(join(tmpdir(), "pi-herdr-completion-crash-"));
        let store: SqliteControlPlaneStore | undefined;
        try {
            const filename = join(directory, "control.sqlite");
            store = SqliteControlPlaneStore.open({ filename });
            const parent = store.registerAgent({ alias: "parent", role: "coordinator" });
            let child = store.registerAgent({
                alias: "child",
                role: "worker",
                parentAgentId: parent.id,
            });
            for (const status of ["starting", "running"] as const) {
                child = store.transitionAgent({
                    agentId: child.id,
                    status,
                    patch: {},
                    expectedRevision: child.revision,
                });
            }
            const payload = { status: "succeeded", summary: "exact payload after crash" };
            store.declareCompletion({ agentId: child.id, invocationToken: "crash-test", payload });
            store.close();
            await assert.rejects(
                execute(
                    process.execPath,
                    ["--experimental-strip-types", client, filename, child.id, child.runId, point],
                    { timeout: 10000 },
                ),
                (error: unknown) => (error as { signal?: string }).signal === "SIGKILL",
            );
            store = SqliteControlPlaneStore.open({ filename });
            assert.equal(
                store.getCompletion(child.id)?.state,
                point === "after_commit" ? "emitted" : "declared",
            );
            const result = store.publishCompletion(child.id, child.runId, "crash-test");
            assert.deepEqual(JSON.parse(result.content), payload);
            assert.equal(
                store.publishCompletion(child.id, child.runId, "crash-test").id,
                result.id,
            );
            assert.equal(store.listMessages({ recipientAgentId: parent.id }).items.length, 1);
            assert.equal(store.databaseHealth().quickCheck, "ok");
        } finally {
            store?.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
