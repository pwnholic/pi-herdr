import { parseAgentId } from "../../src/domain/ids.ts";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

const [filename, senderValue, recipientValue, idempotencyKey] = process.argv.slice(2);
if (!filename || !senderValue || !recipientValue || !idempotencyKey) {
    throw new Error("usage: enqueue-client <db> <sender> <recipient> <key>");
}

const store = SqliteControlPlaneStore.open({ filename, busyTimeoutMs: 10_000 });
try {
    const result = store.enqueueMessage({
        senderAgentId: parseAgentId(senderValue),
        recipientAgentId: parseAgentId(recipientValue),
        kind: "message",
        content: "concurrent logical send",
        idempotencyKey,
        ttlMs: 60_000,
    });
    process.stdout.write(
        `${JSON.stringify({ id: result.message.id, deduplicated: result.deduplicated })}\n`,
    );
} finally {
    store.close();
}
