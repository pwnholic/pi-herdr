import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { PiHerdrRuntime } from "../../src/pi/runtime.ts";
import { registerPiHerdrTools } from "../../src/pi/tools.ts";

type Schema = {
    description?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
    additionalProperties?: boolean;
};
interface Contract {
    name: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Schema;
}

function contracts(child: boolean) {
    const definitions: Contract[] = [];
    registerPiHerdrTools(
        {
            registerTool: (definition: Contract) => definitions.push(definition),
        } as unknown as ExtensionAPI,
        {} as PiHerdrRuntime,
        child,
    );
    return definitions;
}

function verifyParameters(schema: Schema, path: string) {
    if (schema.properties) {
        assert.equal(schema.additionalProperties, false, `${path}: reject unknown keys`);
        for (const [name, property] of Object.entries(schema.properties)) {
            assert.ok(
                property.description && property.description.length >= 20,
                `${path}.${name}: meaningful parameter description`,
            );
            verifyParameters(property, `${path}.${name}`);
        }
    }
    if (schema.items) verifyParameters(schema.items, `${path}[]`);
}

test("every parent and worker tool documents purpose, named prompt guidance, and all nested parameters", () => {
    const all = [...contracts(false), ...contracts(true)];
    assert.equal(new Set(all.map((definition) => definition.name)).size, 23);
    for (const tool of all) {
        assert.ok(tool.description.length >= 80, `${tool.name}: purpose and outcome`);
        assert.ok(
            tool.promptSnippet && tool.promptSnippet.length >= 15,
            `${tool.name}: prompt snippet`,
        );
        assert.ok(tool.promptGuidelines?.length, `${tool.name}: prompt guidelines`);
        for (const guideline of tool.promptGuidelines!) {
            assert.ok(
                guideline.includes(tool.name),
                `${tool.name}: Pi flattens guidelines, so each must name its tool`,
            );
        }
        verifyParameters(tool.parameters, tool.name);
    }
});

test("launch schema exposes actual alias, thinking, tool-name, and unknown-key constraints", () => {
    const schema = contracts(false).find((tool) => tool.name === "agent_spawn")!.parameters;
    const valid = {
        alias: "durable_store",
        role: "storage",
        prompt: "Audit transactions",
        cwd: "/tmp",
        thinking: "high",
        tools: ["read", "bash"],
    };
    assert.equal(Value.Check(schema, valid), true);
    for (const patch of [
        { alias: "Wrong Name" },
        { alias: "1worker" },
        { thinking: "ultra" },
        { tools: ["read", "read"] },
        { tools: ["shell command"] },
        { inventedRunId: "x" },
    ]) {
        assert.equal(Value.Check(schema, { ...valid, ...patch }), false);
    }
});

test("inbox filters reject empty states and describe ID provenance instead of invented identifiers", () => {
    const tools = contracts(true);
    const list = tools.find((tool) => tool.name === "agent_mail_list")!;
    assert.equal(Value.Check(list.parameters, {}), true);
    assert.equal(Value.Check(list.parameters, { states: [] }), false);
    assert.equal(Value.Check(list.parameters, { limit: 101 }), false);
    const send = tools.find((tool) => tool.name === "agent_mail_send")!;
    assert.match(
        send.parameters.properties!.recipient!.description!,
        /agent_directory.*sessionId.*runId/,
    );
    assert.match(
        send.parameters.properties!.replyToMessageId!.description!,
        /incoming.*Required.*response/,
    );
    assert.ok(!tools.some((tool) => tool.name === "agent_stop"));
});
