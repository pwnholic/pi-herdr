import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveConfig } from "../src/config.ts";

describe("resolveConfig", () => {
    test("uses a durable database below the Pi project session directory", () => {
        const config = resolveConfig({ sessionDir: "/sessions/project", cwd: "/repo", env: {} });
        assert.equal(config.databasePath, "/sessions/project/pi-herdr/control.sqlite");
        assert.equal(config.maxLiveAgents, 8);
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
        assert.throws(
            () =>
                resolveConfig({
                    sessionDir: "/sessions/project",
                    cwd: "/repo",
                    env: { PI_HERDR_MAX_AGENTS: "0" },
                }),
            /PI_HERDR_MAX_AGENTS must be between 1 and 64/,
        );
    });
});
