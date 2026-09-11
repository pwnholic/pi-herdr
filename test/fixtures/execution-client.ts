import { parseAgentId } from "../../src/domain/ids.ts";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

const [filename, agent, runId, sessionId, owner, clock] = process.argv.slice(2);
if (!filename || !agent || !runId || !sessionId || !owner || !clock)
    throw new Error("Missing execution client arguments");
const agentId = parseAgentId(agent);
const store = SqliteControlPlaneStore.open({ filename, clock: { now: () => Number(clock) } });
try {
    const lease = store.acquireExecution({ agentId, runId, sessionId, owner, leaseMs: 100 });
    process.send?.({ type: "acquired", epoch: lease.epoch });
} catch (error) {
    process.send?.({ type: "conflict", error: String(error) });
    store.close();
    process.disconnect?.();
}

if (store.execution !== undefined) {
    process.on("message", (command: { type: string; recipient?: string }) => {
        if (command.type === "declare") {
            store.declareCompletion({
                agentId,
                runId,
                invocationToken: "process-draft",
                payload: { status: "succeeded", summary: "process draft" },
            });
            process.send?.({ type: "declared" });
        } else if (command.type === "probe") {
            const errors: string[] = [];
            for (const operation of [
                () =>
                    store.enqueueMessage({
                        senderAgentId: agentId,
                        senderRunId: runId,
                        recipientAgentId: parseAgentId(command.recipient!),
                        kind: "message",
                        content: "stale",
                    }),
                () => store.publishCompletion(agentId, runId, "process-draft"),
                () => store.renewExecution(100),
            ]) {
                try {
                    operation();
                } catch (error) {
                    errors.push(String(error));
                }
            }
            process.send?.({ type: "probed", errors, released: store.releaseExecution() });
        } else if (command.type === "release") {
            store.releaseExecution();
            store.close();
            process.send?.({ type: "released" });
            process.disconnect?.();
        }
    });
}
