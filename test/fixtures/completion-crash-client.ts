import { parseAgentId } from "../../src/domain/ids.ts";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

const [filename, id, runId, point] = process.argv.slice(2);
if (!filename || !id || !runId || !point)
    throw new Error("filename, agentId, runId, point are required");
const kill = () => process.kill(process.pid, "SIGKILL");
const store = SqliteControlPlaneStore.open({
    filename,
    failpoint: (name) => {
        if (name === point) kill();
    },
});
store.publishCompletion(parseAgentId(id), runId, "crash-test");
if (point === "after_commit") kill();
store.close();
