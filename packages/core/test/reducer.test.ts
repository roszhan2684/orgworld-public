import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentKnowledge, applyEvent, initialWorldState, reduceEvents, ReducerError } from '../src/index.ts';
import { buildEvents } from './helpers.ts';
import { GOLDEN_RUN_ID, goldenDrafts } from './fixtures/golden-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, 'fixtures', 'golden-run.state.json');
const events = buildEvents(GOLDEN_RUN_ID, goldenDrafts());

describe('golden replay (build §79)', () => {
  it('reduces the fixture to the pinned state', () => {
    const state = JSON.parse(JSON.stringify(reduceEvents(events)));
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(goldenPath)) {
      if (process.env.CI) throw new Error('golden file missing in CI');
      writeFileSync(goldenPath, JSON.stringify(state, null, 2) + '\n');
    }
    expect(state).toEqual(JSON.parse(readFileSync(goldenPath, 'utf8')));
  });

  it('hand-checked values (independent of the pinned file)', () => {
    const s = reduceEvents(events);
    expect(s.status).toBe('completed');
    expect(s.lastSequence).toBe(events.length);
    expect(s.tasks.t1!.status).toBe('COMPLETED');
    expect(s.tasks.t1!.tokens).toBe(2400); // 2 calls × (1000 in + 200 out)
    expect(s.tasks.t1!.calls).toBe(2);
    expect(s.tasks.t1!.messages).toBe(2);
    expect(s.costs.total.usd).toBeCloseTo(0.002);
    expect(s.costs.byCategory.task.calls).toBe(2);
    expect(s.agents.a1!.stats.workByCategory).toEqual({ implementation: 2 }); // code artifact + message
    expect(s.agents.a2!.stats.reviews).toBe(1);
    expect(s.decisions.d1!.outcome!.chosen).toBe('ship');
    expect(s.decisions.d1!.votes).toHaveLength(2);
    const atCompletion = reduceEvents(events, events.findIndex((e) => e.type === 'TASK_COMPLETED') + 1);
    expect(atCompletion.agents.a1!.status).toBe('idle'); // task completion returns agents to idle
    expect(s.agents.a1!.room).toBe('library'); // then a1 writes memory in the library (real later event)
  });

  it('replay of any prefix equals incremental application (prefix consistency)', () => {
    const inc = initialWorldState();
    events.forEach((e, i) => {
      applyEvent(inc, e);
      expect(JSON.parse(JSON.stringify(inc))).toEqual(JSON.parse(JSON.stringify(reduceEvents(events, i + 1))));
    });
  });

  it('rejects out-of-order and cross-run events', () => {
    const s = reduceEvents(events.slice(0, 3));
    expect(() => applyEvent(s, events[1]!)).toThrow(ReducerError);
    expect(() => applyEvent(reduceEvents(events.slice(0, 1)), { ...events[1]!, runId: 'other' })).toThrow(/belongs to run/);
  });
});

describe('information asymmetry (build §9, §26)', () => {
  it('agents only know what reached them through allowed channels', () => {
    const before = reduceEvents(events, 13); // after m1 sent, before it is received
    expect(agentKnowledge(before, 'a2')!.artifacts.map((a) => a.artifactId)).toEqual([]);
    const after = reduceEvents(events, 14);
    expect(agentKnowledge(after, 'a2')!.artifacts.map((a) => a.artifactId)).toEqual(['art1']);
    const end = reduceEvents(events);
    const k2 = agentKnowledge(end, 'a2')!;
    expect(k2.memory).toEqual([]); // a1's private memory is not visible to a2
    expect(k2.unknown.memory).toBe(1);
    expect(agentKnowledge(end, 'a1')!.memory.map((m) => m.memoryId)).toEqual(['mem1']);
  });
});
