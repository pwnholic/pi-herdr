import assert from "node:assert/strict";
import { test } from "node:test";
import { modelToolResult } from "../../src/pi/tool-output.ts";

test("model content includes routing IDs and pagination independently of UI details", () => {
    const data = {
        items: [{ id: "immutable-id", runId: "run", alias: "durable_store", status: "running" }],
        nextCursor: "page-two",
    };
    const output = modelToolResult("agent_directory", data, "1 peer(s)");
    assert.deepEqual(JSON.parse(output.content[0]!.text.split("\n")[1]!), data);
    assert.match(output.content[0]!.text, /durable_store/);
});

test("oversized pages retain every routing ID and cursor within a bounded model output", () => {
    const data = {
        items: Array.from({ length: 100 }, (_, index) => ({
            id: `id-${index}`,
            alias: `worker-${index}`,
            metadata: { secretBody: "x".repeat(4096) },
            content: "界".repeat(20000),
        })),
        nextCursor: "next",
    };
    const output = modelToolResult("agent_mail_list", data, "x".repeat(100000));
    assert.ok(Buffer.byteLength(output.content[0]!.text) < 68000);
    assert.match(output.content[0]!.text, /id-99/);
    assert.match(output.content[0]!.text, /nextCursor/);
    assert.match(output.content[0]!.text, /truncated/);
    assert.equal(output.details.data, data);
});
