import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveConfig } from "../src/config.ts";

describe("resolveConfig", () => {
    test("uses a durable database below the Pi project session directory", () => {
        const config = resolveConfig({ sessionDir: "/sessions/project", cwd: "/repo", env: {} });
        assert.equal(config.databasePath, "/sessions/project/pi-herdr/control.sqlite");
        assert.equal(config.maxLiveAgents, 8);
        assert.equal(config.maxDeliveryBytes, 512 * 1024);
        assert.equal(config.mailboxRetentionMs, 30 * 24 * 60 * 60 * 1000);
    });

    test("resolves a relative explicit database path against the child cwd", () => {
        const config = resolveConfig({
            sessionDir: "/sessions/project",
            cwd: "/repo",
            env: { PI_HERDR_DB: ".runtime/control.sqlite" },
        });
        assert.equal(config.databasePath, "/repo/.runtime/control.sqlite");
    });

    test("rejects unsafe resource limits", () => {
        for (const env of [
            { PI_HERDR_MAX_PAGE_SIZE: "101" },
            { PI_HERDR_MAX_RESULT_BYTES: "1048577" },
        ]) {
            assert.throws(
                () => resolveConfig({ sessionDir: "/sessions/project", cwd: "/repo", env }),
                /must be between/,
            );
        }
        assert.throws(
            () =>
                resolveConfig({
                    sessionDir: "/sessions/project",
                    cwd: "/repo",
                    env: { PI_HERDR_MAX_AGENTS: "0" },
                }),
            /PI_HERDR_MAX_AGENTS must be between 1 and 64/,
        );
        assert.throws(
            () =>
                resolveConfig({
                    sessionDir: "/sessions/project",
                    cwd: "/repo",
                    env: { PI_HERDR_MAILBOX_RETENTION_MS: "100" },
                }),
            /PI_HERDR_MAILBOX_RETENTION_MS must be between/,
        );
    });
});
