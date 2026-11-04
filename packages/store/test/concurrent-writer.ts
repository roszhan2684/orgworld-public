// Child process for the multi-writer test: appends N status events to a run.
import { EventStore } from '../src/index.ts';
const [dbPath, runId, who, n] = process.argv.slice(2) as [string, string, string, string];
const store = EventStore.open(dbPath);
for (let i = 0; i < Number(n); i++) {
  store.append(runId, { type: 'ANOMALY_DETECTED', actorId: who, payload: { kind: 'test', detail: `${who}-${i}` } });
}
store.close();
