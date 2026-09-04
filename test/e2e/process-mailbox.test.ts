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
const client = fileURLToPath(new URL("../fixtures/enqueue-client.ts", import.meta.url));

test("concurrent processes converge on one idempotent mailbox row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-herdr-process-e2e-"));
    try {
        const filename = join(directory, "control.sqlite");
        const setup = SqliteControlPlaneStore.open({ filename });
        const parent = setup.registerAgent({ alias: "process-parent", role: "coordinator" });
        const child = setup.registerAgent({
            alias: "process-child",
            role: "worker",
            parentAgentId: parent.id,
        });
        setup.close();

        const executions = await Promise.all(
            Array.from({ length: 8 }, () =>
                execute(
                    process.execPath,
                    [
                        "--experimental-strip-types",
                        client,
                        filename,
                        parent.id,
                        child.id,
                        "concurrent-key",
                    ],
                    { timeout: 15_000 },
                ),
            ),
        );
        const results = executions.map(({ stdout }) => JSON.parse(stdout.trim()) as { id: string });
        assert.equal(new Set(results.map((result) => result.id)).size, 1);

        const verification = SqliteControlPlaneStore.open({ filename });
        assert.equal(verification.listMessages({ recipientAgentId: child.id }).items.length, 1);
        verification.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
