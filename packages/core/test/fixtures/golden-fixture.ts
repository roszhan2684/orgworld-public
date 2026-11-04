import type { EventDraft } from '@orgworld/protocol';
import { generalists } from '../../src/presets.ts';
import { RunConfig } from '@orgworld/protocol';

/**
 * GOLDEN FIXTURE — synthetic, deterministic, hand-written event log (NOT model output).
 * Changing this file or the reducer in a way that alters the reduced state requires a deliberate
 * migration: regenerate golden-run.state.json with UPDATE_GOLDEN=1 and explain why in the commit.
 */
export const GOLDEN_RUN_ID = 'run_golden';

export function goldenDrafts(): EventDraft[] {
  const genome = generalists(2);
  const config = RunConfig.parse({
    runId: GOLDEN_RUN_ID,
    mode: 'experiment',
    kind: 'stream',
    condition: 'fixed-generalist',
    genome,
    model: { provider: 'scripted', model: 'fixture' },
    budget: {},
    reward: {},
    seeds: {},
    features: {},
    evolution: {},
    policy: {},
    versions: { orgworld: '0.1.0' },
    environment: { fixture: 'true' },
  });
  const agent = (id: string): EventDraft => ({
    type: 'AGENT_CREATED',
    actorId: 'runtime',
    payload: { agentId: id, name: id.toUpperCase(), roleId: 'generalist', roleName: 'Generalist', roleObjective: 'x', capabilities: ['write_code', 'review', 'submit'], modelProvider: 'scripted', modelName: 'fixture', generation: 0 },
  });
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 };
  return [
    { type: 'RUN_CREATED', actorId: 'runtime', payload: { config } },
    { type: 'ORGANIZATION_INSTANTIATED', actorId: 'runtime', payload: { genome, reason: 'preset' } },
    agent('a1'),
    agent('a2'),
    { type: 'RUN_STARTED', actorId: 'runtime', payload: {} },
    { type: 'PHASE_CHANGED', actorId: 'runtime', payload: { phaseIndex: 0, phaseId: 'A', mix: { implementation: 1 } } },
    { type: 'TASK_CREATED', actorId: 'runtime', payload: { taskId: 't1', parentId: null, title: 'sum', objective: 'implement sum', source: 'bench', category: 'implementation', family: 'impl-sum', taskIndex: 0, phaseId: 'A' } },
    { type: 'TASK_ASSIGNED', actorId: 'runtime', payload: { taskId: 't1', agentId: 'a1', byAgentId: null } },
    { type: 'TASK_STARTED', actorId: 'runtime', payload: { taskId: 't1' } },
    { type: 'MODEL_CALL_STARTED', actorId: 'a1', payload: { callId: 'c1', agentId: 'a1', taskId: 't1', category: 'task', purpose: 'plan', provider: 'scripted', model: 'fixture' } },
    { type: 'MODEL_CALL_COMPLETED', actorId: 'a1', payload: { callId: 'c1', agentId: 'a1', taskId: 't1', category: 'task', provider: 'scripted', model: 'fixture', usage, costUsd: 0.001, latencyMs: 5, samplingControlled: true } },
    { type: 'ARTIFACT_CREATED', actorId: 'a1', payload: { artifactId: 'art1', kind: 'code', title: 'sum v1', taskId: 't1', authorId: 'a1', content: 'module.exports=(a,b)=>a+b', contentHash: 'h1', parents: [], visibleTo: ['a1'] } },
    { type: 'MESSAGE_SENT', actorId: 'a1', payload: { messageId: 'm1', from: 'a1', to: ['a2'], kind: 'REVIEW_REQUEST', content: 'please review', taskId: 't1', artifactIds: ['art1'], tokenCost: 40 } },
    { type: 'MESSAGE_RECEIVED', actorId: 'a2', payload: { messageId: 'm1', agentId: 'a2' } },
    { type: 'MODEL_CALL_STARTED', actorId: 'a2', payload: { callId: 'c2', agentId: 'a2', taskId: 't1', category: 'task', purpose: 'review', provider: 'scripted', model: 'fixture' } },
    { type: 'MODEL_CALL_COMPLETED', actorId: 'a2', payload: { callId: 'c2', agentId: 'a2', taskId: 't1', category: 'task', provider: 'scripted', model: 'fixture', usage, costUsd: 0.001, latencyMs: 5, samplingControlled: true } },
    { type: 'ARTIFACT_CREATED', actorId: 'a2', payload: { artifactId: 'art2', kind: 'review', title: 'LGTM', taskId: 't1', authorId: 'a2', content: 'approve', contentHash: 'h2', parents: ['art1'], visibleTo: ['a2'] } },
    { type: 'MESSAGE_SENT', actorId: 'a2', payload: { messageId: 'm2', from: 'a2', to: ['a1'], kind: 'REVIEW_RESPONSE', content: 'approved', taskId: 't1', artifactIds: ['art2'], tokenCost: 20 } },
    { type: 'MESSAGE_RECEIVED', actorId: 'a1', payload: { messageId: 'm2', agentId: 'a1' } },
    { type: 'DECISION_CREATED', actorId: 'a1', payload: { decisionId: 'd1', question: 'ship v1?', options: ['ship', 'revise'], proposerId: 'a1', recommendation: 'ship', evidence: ['art2'], policy: 'MAJORITY', participants: ['a1', 'a2'], taskId: 't1' } },
    { type: 'VOTE_CAST', actorId: 'a1', payload: { decisionId: 'd1', agentId: 'a1', option: 'ship', rationale: 'tests pass', weight: 1 } },
    { type: 'VOTE_CAST', actorId: 'a2', payload: { decisionId: 'd1', agentId: 'a2', option: 'ship', rationale: 'reviewed', weight: 1 } },
    { type: 'DECISION_COMPLETED', actorId: 'runtime', payload: { decisionId: 'd1', chosen: 'ship', confidence: 1, policy: 'MAJORITY', tally: { ship: 2 }, rationale: 'unanimous', opposition: [] } },
    { type: 'EVALUATION_COMPLETED', actorId: 'evaluator', payload: { taskId: 't1', evaluator: 'hidden-tests', score: 1, passed: 4, total: 4, details: 'ok', artifactId: 'art1' } },
    { type: 'REWARD_RECORDED', actorId: 'evaluator', payload: { taskId: 't1', total: 1, success: true, terms: { quality: 1 }, rewardConfigHash: 'r' } },
    { type: 'TASK_COMPLETED', actorId: 'runtime', payload: { taskId: 't1', success: true, score: 1, submittedArtifactId: 'art1', submittedBy: 'a1', forced: false } },
    { type: 'MEMORY_WRITTEN', actorId: 'a1', payload: { memoryId: 'mem1', scope: 'private', kind: 'episodic', ownerAgentId: 'a1', content: 'a2 reviews fast', provenance: { runId: GOLDEN_RUN_ID, taskId: 't1', genomeId: genome.id, sourceEventIds: ['run_golden-e18'] } } },
    { type: 'RUN_COMPLETED', actorId: 'runtime', payload: { summary: { tasks: 1, success: 1 } } },
  ];
}
