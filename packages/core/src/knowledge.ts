import type { AgentView, ArtifactView, Belief, DecisionView, MemoryView, MessageView, WorldState } from './state.ts';

export interface AgentKnowledge {
  agent: AgentView;
  messages: MessageView[];
  artifacts: ArtifactView[];
  decisions: DecisionView[];
  beliefs: Belief[];
  memory: MemoryView[];
  /** Counts of things that exist but this agent has no access to (shown as "unknown", never revealed). */
  unknown: { messages: number; artifacts: number; decisions: number; memory: number };
}

/**
 * Build §26 "View as this agent": strictly the information the agent acquired through allowed channels
 * (its own actions, received messages/meetings, artifacts made visible to it, decisions it took part in,
 * its own private memory, and shared memory its role may read). Never reveals hidden global state.
 */
export function agentKnowledge(s: WorldState, agentId: string): AgentKnowledge | null {
  const agent = s.agents[agentId];
  if (!agent) return null;
  const km = new Set(agent.knownMessageIds);
  const ka = new Set(agent.knownArtifactIds);
  const kd = new Set(agent.knownDecisionIds);
  const memRead = s.genome?.policies.memoryRead ?? 'org';
  const canReadMemory = (m: MemoryView): boolean => {
    if (m.scope === 'private') return m.ownerAgentId === agentId;
    if (memRead === 'none' || memRead === 'private') return false;
    if (m.scope === 'team') return !!m.teamId && m.teamId === agent.teamId;
    return memRead === 'org';
  };
  const messages = s.messageOrder.map((id) => s.messages[id]!).filter((m) => km.has(m.messageId));
  const artifacts = s.artifactOrder.map((id) => s.artifacts[id]!).filter((a) => ka.has(a.artifactId));
  const decisions = s.decisionOrder.map((id) => s.decisions[id]!).filter((d) => kd.has(d.decisionId));
  const allMem = Object.values(s.memory);
  const memory = allMem.filter(canReadMemory);
  return {
    agent,
    messages,
    artifacts,
    decisions,
    beliefs: Object.values(agent.beliefs),
    memory,
    unknown: {
      messages: s.messageOrder.length - messages.length,
      artifacts: s.artifactOrder.length - artifacts.length,
      decisions: s.decisionOrder.length - decisions.length,
      memory: allMem.length - memory.length,
    },
  };
}
