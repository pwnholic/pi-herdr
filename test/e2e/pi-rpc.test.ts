import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

const PI = process.env.PI_BIN ?? "/home/pwnholic/.local/bin/pi";

test("real Pi RPC loads the isolated extension and persists its coordinator", async (context) => {
    if (!existsSync(PI)) {
        context.skip(`Pi binary is unavailable at ${PI}`);
        return;
    }
    const directory = mkdtempSync(join(tmpdir(), "pi-herdr-rpc-e2e-"));
    const database = join(directory, "control.sqlite");
    const child = spawn(
        PI,
        [
            "--mode",
            "rpc",
            "--no-extensions",
            "--extension",
            resolve("src/extension.ts"),
            "--session-dir",
            join(directory, "sessions"),
            "--name",
            "Pi Herdr RPC Test",
        ],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PI_HERDR_DB: database,
                PI_HERDR_COMPLETION_POLL_MS: "60000",
            },
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    try {
        const response = new Promise<Record<string, unknown>>((resolveResponse, reject) => {
            let buffer = "";
            let stderr = "";
            const timeout = setTimeout(
                () => reject(new Error(`Pi RPC timed out: ${stderr}`)),
                10_000,
            );
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => {
                stderr += chunk;
            });
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                buffer += chunk;
                while (buffer.includes("\n")) {
                    const newline = buffer.indexOf("\n");
                    const line = buffer.slice(0, newline).replace(/\r$/u, "");
                    buffer = buffer.slice(newline + 1);
                    if (line.length === 0) continue;
                    const record = JSON.parse(line) as Record<string, unknown>;
                    if (record.type === "extension_error") {
                        clearTimeout(timeout);
                        reject(new Error(`Pi extension error: ${line}`));
                        return;
                    }
                    if (record.type === "response" && record.id === "state") {
                        clearTimeout(timeout);
                        resolveResponse(record);
                        return;
                    }
                }
            });
            child.once("error", reject);
            child.once("exit", (code) => {
                if (code !== null && code !== 0) reject(new Error(`Pi exited ${code}: ${stderr}`));
            });
        });
        child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
        const state = await response;
        assert.equal(state.success, true);
        assert.equal((state.data as { sessionName?: string }).sessionName, "Pi Herdr RPC Test");

        const store = SqliteControlPlaneStore.open({ filename: database });
        const coordinators = store.listAgents().items;
        assert.equal(coordinators.length, 1);
        assert.equal(coordinators[0]?.role, "coordinator");
        store.close();
    } finally {
        child.kill("SIGTERM");
        await new Promise<void>((resolveExit) => {
            if (child.exitCode !== null || child.signalCode !== null) resolveExit();
            else child.once("exit", () => resolveExit());
        });
        rmSync(directory, { recursive: true, force: true });
    }
});
