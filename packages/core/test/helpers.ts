import { EVENT_SCHEMA_VERSION, parseEvent, type EventDraft, type OrgEvent } from '@orgworld/protocol';

/** Builds a validated event sequence with deterministic ids/timestamps (for fixtures/tests only). */
export function buildEvents(runId: string, drafts: EventDraft[], startMs = Date.UTC(2026, 9, 28, 12, 0, 0)): OrgEvent[] {
  return drafts.map((d, i) =>
    parseEvent({
      eventId: `${runId}-e${i + 1}`,
      runId,
      sequence: i + 1,
      timestamp: new Date(startMs + i * 1000).toISOString(),
      type: d.type,
      actorId: d.actorId,
      payload: d.payload,
      causedBy: d.causedBy ?? null,
      correlationId: d.correlationId ?? null,
      schemaVersion: EVENT_SCHEMA_VERSION,
    }),
  );
}
