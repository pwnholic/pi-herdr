/** Model-visible output is a separate contract from Pi's UI-only details. */
const MAX_OUTPUT_BYTES = 64 * 1024;

function identity(value: unknown): unknown {
    if (value === null || typeof value !== "object") return preview(value, 64);
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) =>
                [
                    "id",
                    "runId",
                    "alias",
                    "role",
                    "status",
                    "state",
                    "nodeId",
                    "sequence",
                    "senderAgentId",
                    "recipientAgentId",
                    "threadId",
                    "nextCursor",
                    "nextAfter",
                ].includes(key),
            )
            .map(([key, item]) => [key, preview(item, 128)]),
    );
}

function preview(value: unknown, stringLimit: number, depth = 0): unknown {
    if (typeof value === "string") {
        return value.length <= stringLimit ? value : `${value.slice(0, stringLimit)}… [truncated]`;
    }
    if (value === null || typeof value !== "object") return value;
    if (depth > 8) return "[nested data omitted]";
    if (Array.isArray(value)) return value.map((item) => preview(item, stringLimit, depth + 1));
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            key,
            key === "metadata" || key === "output" || key === "input"
                ? "[inspect the individual record for details]"
                : preview(item, stringLimit, depth + 1),
        ]),
    );
}

export function modelToolResult<T>(tool: string, data: T, message: string) {
    let visible = JSON.stringify(data);
    let truncated = false;
    if (Buffer.byteLength(visible ?? "null", "utf8") > MAX_OUTPUT_BYTES) {
        visible = JSON.stringify(preview(data, 256));
        truncated = true;
    }
    if (Buffer.byteLength(visible ?? "null", "utf8") > MAX_OUTPUT_BYTES) {
        // Keep JSON valid and explicitly report the bound instead of corrupting a payload.
        visible = JSON.stringify({
            truncated: true,
            message: "Result exceeds the output budget. Query a smaller page or individual record.",
            ...(typeof data === "object" && data !== null
                ? {
                      ...(identity(data) as object),
                      ...("items" in data && Array.isArray(data.items)
                          ? { items: data.items.map(identity) }
                          : {}),
                  }
                : {}),
        });
    }
    return {
        content: [
            {
                type: "text" as const,
                text: `${message.slice(0, 1024)}\n${visible ?? "null"}${truncated ? "\nSome fields were truncated; narrow the query for full detail." : ""}`,
            },
        ],
        details: { tool, data },
    };
}
