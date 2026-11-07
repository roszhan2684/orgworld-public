import type {
  AgentStatus,
  ArtifactKind,
  Capability,
  CallCategory,
  MessageKind,
  Mutation,
  MutationProposal,
  OrgEvent,
  OrganizationGenome,
  PayloadOf,
  RunConfig,
} from '@orgworld/protocol';
import { totalTokens } from './budget.ts';
import { truncate } from './util.ts';

export const ROOMS = [
  'command',
  'research',
  'strategy',
  'engineering',
  'experiment',
  'critique',
  'decision',
  'library',
  'analysis',
  'meeting',
] as const;
export type RoomId = (typeof ROOMS)[number];

export const ROOM_LABELS: Record<RoomId, string> = {
  command: 'Command Center',
  research: 'Research Lab',
  strategy: 'Strategy Room',
  engineering: 'Engineering Area',
  experiment: 'Experiment Lab',
  critique: 'Critique Room',
  decision: 'Decision Chamber',
  library: 'Memory Library',
  analysis: 'Analysis Station',
  meeting: 'Meeting Room',
};

const ROLE_HOME: Record<string, RoomId> = {
  director: 'command',
  scout: 'research',
  researcher: 'research',
  strategist: 'strategy',
  architect: 'engineering',
  builder: 'engineering',
  experimenter: 'experiment',
  critic: 'critique',
  risk: 'critique',
  analyst: 'analysis',
  librarian: 'library',
  mediator: 'decision',
};

export function homeRoom(roleId: string, caps: readonly Capability[], isEntry: boolean): RoomId {
  if (ROLE_HOME[roleId]) return ROLE_HOME[roleId]!;
  if (isEntry) return 'command';
  if (caps.includes('write_code')) return 'engineering';
  if (caps.includes('write_tests') || caps.includes('run_checks')) return 'experiment';
  if (caps.includes('review')) return 'critique';
  if (caps.includes('research')) return 'research';
  if (caps.includes('plan')) return 'strategy';
  if (caps.includes('memory')) return 'library';
  return 'command';
}

const ARTIFACT_ROOM: Partial<Record<ArtifactKind, RoomId>> = {
  code: 'engineering',
  tests: 'experiment',
  test_report: 'experiment',
  review: 'critique',
  risk_report: 'critique',
  research_note: 'research',
  plan: 'strategy',
  proposal: 'strategy',
  hypothesis: 'research',
  decision_record: 'decision',
  evaluation: 'analysis',
};

export interface Belief {
  beliefId: string;
  claim: string;
  confidence: number;
  evidence: string[];
  seq: number;
}

export interface AgentView {
  id: string;
  name: string;
  roleId: string;
  roleName: string;
  roleObjective: string;
  capabilities: Capability[];
  modelProvider: string;
  modelName: string;
  generationCreated: number;
  teamId: string | null;
  status: AgentStatus;
  activity: string;
  room: RoomId;
  homeRoom: RoomId;
  targetAgentId: string | null;
  /** Sequence number of the event that produced the current activity — every visual state is traceable. */
  activitySeq: number;
  currentTaskId: string | null;
  removed: boolean;
  createdAt: string;
  updatedAt: string;
  tokensConsumed: number;
  calls: number;
  usd: number;
  knownMessageIds: string[];
  knownArtifactIds: string[];
  knownDecisionIds: string[];
  beliefs: Record<string, Belief>;
  stats: {
    messagesSent: number;
    messagesReceived: number;
    artifactsCreated: number;
    checksRun: number;
    reviews: number;
    votes: number;
    submissions: number;
    successfulSubmissions: number;
    failures: number;
    actionsRejected: number;
    /** Work events per task family/category — basis for the Specialization Index (II-§31). */
    workByCategory: Record<string, number>;
  };
}

export type TaskStatus = 'QUEUED' | 'ASSIGNED' | 'ACTIVE' | 'BLOCKED' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface TaskView {
  id: string;
  parentId: string | null;
  title: string;
  objective: string;
  source: string;
  category: string | null;
  family: string | null;
  taskIndex: number | null;
  phaseId: string | null;
  split: string | null;
  status: TaskStatus;
  assignedAgents: string[];
  createdSeq: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  score: number | null;
  success: boolean | null;
  submittedArtifactId: string | null;
  submittedBy: string | null;
  forced: boolean;
  genomeId: string | null;
  tokens: number;
  calls: number;
  usd: number;
  messages: number;
  evaluation: PayloadOf<'EVALUATION_COMPLETED'> | null;
  reward: PayloadOf<'REWARD_RECORDED'> | null;
  outputArtifactIds: string[];
}

export type MessageView = PayloadOf<'MESSAGE_SENT'> & { seq: number; timestamp: string; receivedBy: string[] };
export type ArtifactView = PayloadOf<'ARTIFACT_CREATED'> & { seq: number; timestamp: string };
export type DecisionView = PayloadOf<'DECISION_CREATED'> & {
  seq: number;
  timestamp: string;
  votes: Array<PayloadOf<'VOTE_CAST'> & { seq: number }>;
  outcome: (PayloadOf<'DECISION_COMPLETED'> & { seq: number }) | null;
};
export type MeetingView = PayloadOf<'MEETING_CREATED'> & {
  seq: number;
  status: 'created' | 'active' | 'ended';
  outcome: string | null;
  decisionIds: string[];
  tokenCost: number;
  messageIds: string[];
};
export type MemoryView = PayloadOf<'MEMORY_WRITTEN'> & { seq: number; timestamp: string; retrievals: number };
export type CheckRunView = PayloadOf<'EXPERIMENT_STARTED'> & { seq: number; result: PayloadOf<'EXPERIMENT_COMPLETED'> | null };

export interface EvolutionEntry {
  seq: number;
  kind: 'instantiated' | 'triggered' | 'proposed' | 'validated' | 'rejected' | 'mutated' | 'rolled_back';
  generation: number;
  genomeId: string;
  detail: string;
  proposalId?: string;
  mutation?: Mutation;
}

export interface ProposalView {
  proposal: MutationProposal;
  seq: number;
  validation: PayloadOf<'MUTATION_VALIDATED'> | null;
  status: 'proposed' | 'accepted' | 'rejected';
  rejectionReason: string | null;
}

export interface TimelineEntry {
  seq: number;
  timestamp: string;
  type: OrgEvent['type'];
  label: string;
  actorId: string | null;
  refId: string | null;
}

export interface CostBucket {
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Learning, deliberation and organization-check records (conflict C-21). Created on the first such event, so runs
 *  without those features reduce to exactly the state they always did. */
export interface LearningState {
  reflections: Array<PayloadOf<'REFLECTION_RECORDED'> & { seq: number }>;
  /** Latest evaluation per lesson memory id. */
  lessons: Record<string, PayloadOf<'LESSON_EVALUATED'> & { seq: number }>;
  decisionReviews: Array<PayloadOf<'DECISION_REVIEWED'> & { seq: number }>;
  arguments: Array<PayloadOf<'ARGUMENT_MADE'> & { seq: number }>;
  plans: Array<PayloadOf<'PLANS_PROPOSED'> & { seq: number }>;
  predictions: Array<PayloadOf<'PREDICTION_SCORED'> & { seq: number }>;
  counterfactuals: Array<PayloadOf<'COUNTERFACTUAL_EVALUATED'> & { seq: number }>;
  contributions: Array<PayloadOf<'CONTRIBUTION_MEASURED'> & { seq: number }>;
}

export function emptyLearning(): LearningState {
  return { reflections: [], lessons: {}, decisionReviews: [], arguments: [], plans: [], predictions: [], counterfactuals: [], contributions: [] };
}

export interface WorldState {
  runId: string | null;
  config: RunConfig | null;
  status: 'empty' | 'created' | 'running' | 'paused' | 'completed' | 'failed';
  createdAt: string | null;
  endedAt: string | null;
  summary: Record<string, unknown> | null;
  error: string | null;
  lastSequence: number;
  eventCount: number;
  genome: OrganizationGenome | null;
  genomes: Record<string, OrganizationGenome>;
  agents: Record<string, AgentView>;
  agentOrder: string[];
  tasks: Record<string, TaskView>;
  taskOrder: string[];
  activeTaskId: string | null;
  messages: Record<string, MessageView>;
  messageOrder: string[];
  artifacts: Record<string, ArtifactView>;
  artifactOrder: string[];
  decisions: Record<string, DecisionView>;
  decisionOrder: string[];
  meetings: Record<string, MeetingView>;
  memory: Record<string, MemoryView>;
  checkRuns: Record<string, CheckRunView>;
  relationships: Record<string, Record<string, number>>;
  costs: { total: CostBucket; byCategory: Record<CallCategory, CostBucket> };
  modelCallsInFlight: Record<string, { agentId: string | null; purpose: string; seq: number }>;
  budget: { task: PayloadOf<'BUDGET_UPDATED'> | null; run: PayloadOf<'BUDGET_UPDATED'> | null };
  phase: { index: number; id: string; mix: Record<string, number> } | null;
  evolution: { generation: number; entries: EvolutionEntry[]; proposals: Record<string, ProposalView> };
  policySelections: Array<PayloadOf<'RL_ACTION_SELECTED'> & { seq: number }>;
  rejectedActions: Array<PayloadOf<'ACTION_REJECTED'> & { seq: number }>;
  anomalies: Array<PayloadOf<'ANOMALY_DETECTED'> & { seq: number }>;
  contaminated: boolean;
  toolInvocations: number;
  timeline: TimelineEntry[];
  learning?: LearningState;
}

const emptyBucket = (): CostBucket => ({ calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, usd: 0 });

export function initialWorldState(): WorldState {
  return {
    runId: null,
    config: null,
    status: 'empty',
    createdAt: null,
    endedAt: null,
    summary: null,
    error: null,
    lastSequence: 0,
    eventCount: 0,
    genome: null,
    genomes: {},
    agents: {},
    agentOrder: [],
    tasks: {},
    taskOrder: [],
    activeTaskId: null,
    messages: {},
    messageOrder: [],
    artifacts: {},
    artifactOrder: [],
    decisions: {},
    decisionOrder: [],
    meetings: {},
    memory: {},
    checkRuns: {},
    relationships: {},
    costs: { total: emptyBucket(), byCategory: { task: emptyBucket(), controller: emptyBucket(), validation: emptyBucket(), probe: emptyBucket() } },
    modelCallsInFlight: {},
    budget: { task: null, run: null },
    phase: null,
    evolution: { generation: 0, entries: [], proposals: {} },
    policySelections: [],
    rejectedActions: [],
    anomalies: [],
    contaminated: false,
    toolInvocations: 0,
    timeline: [],
  };
}

export class ReducerError extends Error {}

function pushUnique(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v);
}

/**
 * Applies one event to the state IN PLACE and returns it. Deterministic: same events → same state.
 * Callers that need immutability snapshot with structuredClone. Sequence must strictly increase.
 */
export function applyEvent(s: WorldState, e: OrgEvent): WorldState {
  if (s.runId !== null && e.runId !== s.runId) throw new ReducerError(`event ${e.eventId} belongs to run ${e.runId}, state is ${s.runId}`);
  if (e.sequence <= s.lastSequence) throw new ReducerError(`out-of-order event: seq ${e.sequence} after ${s.lastSequence}`);
  s.runId = e.runId;
  s.lastSequence = e.sequence;
  s.eventCount += 1;
  const seq = e.sequence;
  const ts = e.timestamp;

  const agent = (id: string | null | undefined): AgentView | undefined => (id ? s.agents[id] : undefined);
  const setActivity = (id: string | null | undefined, status: AgentStatus, activity: string, room?: RoomId, target: string | null = null) => {
    const a = agent(id);
    if (!a || a.removed) return;
    a.status = status;
    a.activity = truncate(activity, 160);
    a.room = room ?? a.homeRoom;
    a.targetAgentId = target;
    a.activitySeq = seq;
    a.updatedAt = ts;
  };
  const taskCat = (taskId: string | null | undefined): string | null => {
    const t = taskId ? s.tasks[taskId] : undefined;
    return t ? (t.category ?? t.family ?? 'objective') : null;
  };
  const work = (agentId: string | null | undefined, taskId: string | null | undefined) => {
    const a = agent(agentId);
    const c = taskCat(taskId);
    if (a && c) a.stats.workByCategory[c] = (a.stats.workByCategory[c] ?? 0) + 1;
  };
  const tl = (label: string, refId: string | null = null) =>
    s.timeline.push({ seq, timestamp: ts, type: e.type, label: truncate(label, 200), actorId: e.actorId, refId });

  switch (e.type) {
    case 'RUN_CREATED':
      s.config = e.payload.config;
      s.status = 'created';
      s.createdAt = ts;
      tl(`Run created (${e.payload.config.condition}, ${e.payload.config.model.provider}/${e.payload.config.model.model})`);
      break;
    case 'RUN_STARTED':
    case 'RUN_RESUMED':
      s.status = 'running';
      tl(e.type === 'RUN_STARTED' ? 'Run started' : 'Run resumed');
      break;
    case 'RUN_PAUSED':
      s.status = 'paused';
      tl(`Run paused${e.payload.reason ? `: ${e.payload.reason}` : ''}`);
      break;
    case 'RUN_COMPLETED':
      s.status = 'completed';
      s.endedAt = ts;
      s.summary = e.payload.summary;
      tl('Run completed');
      break;
    case 'RUN_FAILED':
      s.status = 'failed';
      s.endedAt = ts;
      s.error = e.payload.error;
      tl(`Run failed: ${e.payload.error}`);
      break;

    case 'ORGANIZATION_INSTANTIATED': {
      const g = e.payload.genome;
      s.genome = g;
      s.genomes[g.id] = g;
      s.evolution.generation = g.generation;
      s.evolution.entries.push({ seq, kind: 'instantiated', generation: g.generation, genomeId: g.id, detail: `${g.name} (${e.payload.reason})` });
      tl(`Organization instantiated: ${g.name} gen ${g.generation}`, g.id);
      break;
    }
    case 'PHASE_CHANGED':
      s.phase = { index: e.payload.phaseIndex, id: e.payload.phaseId, mix: e.payload.mix };
      tl(`Phase → ${e.payload.phaseId}`);
      break;

    case 'AGENT_CREATED': {
      const p = e.payload;
      const isEntry = s.genome?.entryAgentId === p.agentId;
      const home = homeRoom(p.roleId, p.capabilities, isEntry);
      const prev = s.agents[p.agentId];
      s.agents[p.agentId] = {
        id: p.agentId,
        name: p.name,
        roleId: p.roleId,
        roleName: p.roleName,
        roleObjective: p.roleObjective,
        capabilities: p.capabilities,
        modelProvider: p.modelProvider,
        modelName: p.modelName,
        generationCreated: p.generation,
        teamId: p.teamId ?? null,
        status: 'idle',
        activity: 'idle',
        room: home,
        homeRoom: home,
        targetAgentId: null,
        activitySeq: seq,
        currentTaskId: null,
        removed: false,
        createdAt: prev?.createdAt ?? ts,
        updatedAt: ts,
        tokensConsumed: prev?.tokensConsumed ?? 0,
        calls: prev?.calls ?? 0,
        usd: prev?.usd ?? 0,
        knownMessageIds: prev?.knownMessageIds ?? [],
        knownArtifactIds: prev?.knownArtifactIds ?? [],
        knownDecisionIds: prev?.knownDecisionIds ?? [],
        beliefs: prev?.beliefs ?? {},
        stats: prev?.stats ?? {
          messagesSent: 0,
          messagesReceived: 0,
          artifactsCreated: 0,
          checksRun: 0,
          reviews: 0,
          votes: 0,
          submissions: 0,
          successfulSubmissions: 0,
          failures: 0,
          actionsRejected: 0,
          workByCategory: {},
        },
      };
      pushUnique(s.agentOrder, p.agentId);
      if (prev && prev.roleId !== p.roleId) tl(`${p.name} role → ${p.roleName}`, p.agentId);
      else if (!prev) tl(`Agent ${p.name} (${p.roleName}) joined`, p.agentId);
      break;
    }
    case 'AGENT_REMOVED': {
      const a = agent(e.payload.agentId);
      if (a) {
        a.removed = true;
        a.status = 'removed';
        a.activity = `removed: ${e.payload.reason}`;
        a.activitySeq = seq;
        a.updatedAt = ts;
      }
      tl(`Agent ${e.payload.agentId} removed`, e.payload.agentId);
      break;
    }
    case 'AGENT_STATUS_CHANGED': {
      const a = agent(e.payload.agentId);
      if (a && e.payload.taskId !== undefined) a.currentTaskId = e.payload.taskId;
      setActivity(e.payload.agentId, e.payload.status, e.payload.activity, e.payload.status === 'idle' ? undefined : a?.room);
      break;
    }
    case 'AGENT_FAILED': {
      const a = agent(e.payload.agentId);
      if (a) a.stats.failures += 1;
      setActivity(e.payload.agentId, 'failed', `failed: ${e.payload.error}`);
      tl(`Agent ${e.payload.agentId} failed (${e.payload.recovery})`, e.payload.agentId);
      break;
    }

    case 'TASK_CREATED': {
      const p = e.payload;
      s.tasks[p.taskId] = {
        id: p.taskId,
        parentId: p.parentId,
        title: p.title,
        objective: p.objective,
        source: p.source,
        category: p.category ?? null,
        family: p.family ?? null,
        taskIndex: p.taskIndex ?? null,
        phaseId: p.phaseId ?? null,
        split: p.split ?? null,
        status: 'QUEUED',
        assignedAgents: [],
        createdSeq: seq,
        createdAt: ts,
        startedAt: null,
        completedAt: null,
        score: null,
        success: null,
        submittedArtifactId: null,
        submittedBy: null,
        forced: false,
        genomeId: s.genome?.id ?? null,
        tokens: 0,
        calls: 0,
        usd: 0,
        messages: 0,
        evaluation: null,
        reward: null,
        outputArtifactIds: [],
      };
      s.taskOrder.push(p.taskId);
      tl(`Task created: ${p.title}`, p.taskId);
      break;
    }
    case 'TASK_ASSIGNED': {
      const t = s.tasks[e.payload.taskId];
      if (!t) throw new ReducerError(`TASK_ASSIGNED for unknown task ${e.payload.taskId}`);
      pushUnique(t.assignedAgents, e.payload.agentId);
      if (t.status === 'QUEUED') t.status = 'ASSIGNED';
      const a = agent(e.payload.agentId);
      if (a) a.currentTaskId = t.id;
      break;
    }
    case 'TASK_STARTED': {
      const t = s.tasks[e.payload.taskId];
      if (!t) throw new ReducerError(`TASK_STARTED for unknown task ${e.payload.taskId}`);
      t.status = 'ACTIVE';
      t.startedAt = ts;
      t.genomeId = s.genome?.id ?? t.genomeId;
      s.activeTaskId = t.id;
      break;
    }
    case 'TASK_COMPLETED':
    case 'TASK_FAILED': {
      const t = s.tasks[e.payload.taskId];
      if (!t) throw new ReducerError(`${e.type} for unknown task ${e.payload.taskId}`);
      t.completedAt = ts;
      t.score = e.payload.score;
      if (e.type === 'TASK_COMPLETED') {
        t.success = e.payload.success;
        t.status = e.payload.success ? 'COMPLETED' : 'FAILED';
        t.submittedArtifactId = e.payload.submittedArtifactId;
        t.submittedBy = e.payload.submittedBy;
        t.forced = e.payload.forced;
        const sub = agent(e.payload.submittedBy);
        if (sub) {
          sub.stats.submissions += 1;
          if (e.payload.success) sub.stats.successfulSubmissions += 1;
        }
        tl(`Task ${e.payload.success ? 'succeeded' : 'failed evaluation'}: ${t.title} (score ${e.payload.score.toFixed(2)})`, t.id);
      } else {
        t.success = false;
        t.status = 'FAILED';
        tl(`Task failed: ${t.title} — ${e.payload.reason}`, t.id);
      }
      if (s.activeTaskId === t.id) s.activeTaskId = null;
      for (const a of Object.values(s.agents)) {
        if (a.currentTaskId === t.id && !a.removed) {
          a.currentTaskId = null;
          if (a.status !== 'failed') {
            a.status = 'idle';
            a.activity = 'idle';
            a.room = a.homeRoom;
            a.targetAgentId = null;
            a.activitySeq = seq;
          }
        }
      }
      break;
    }

    case 'MESSAGE_SENT': {
      const p = e.payload;
      s.messages[p.messageId] = { ...p, seq, timestamp: ts, receivedBy: [] };
      s.messageOrder.push(p.messageId);
      const from = agent(p.from);
      if (from) {
        from.stats.messagesSent += 1;
        pushUnique(from.knownMessageIds, p.messageId);
      }
      if (p.taskId && s.tasks[p.taskId]) s.tasks[p.taskId]!.messages += 1;
      work(p.from, p.taskId);
      const target = p.to.length === 1 ? p.to[0]! : null;
      const targetRoom = target ? agent(target)?.room : undefined;
      setActivity(p.from, 'communicating', `${kindVerb(p.kind)} ${p.to.join(', ')}: ${p.content}`, targetRoom ?? from?.room, target);
      tl(`${p.from} → ${p.to.join(', ')} [${p.kind}] ${p.content}`, p.messageId);
      break;
    }
    case 'MESSAGE_RECEIVED': {
      const m = s.messages[e.payload.messageId];
      const a = agent(e.payload.agentId);
      if (!m) throw new ReducerError(`MESSAGE_RECEIVED for unknown message ${e.payload.messageId}`);
      pushUnique(m.receivedBy, e.payload.agentId);
      if (a) {
        a.stats.messagesReceived += 1;
        pushUnique(a.knownMessageIds, m.messageId);
        for (const art of m.artifactIds) pushUnique(a.knownArtifactIds, art);
        if (m.decisionId) pushUnique(a.knownDecisionIds, m.decisionId);
      }
      break;
    }

    case 'MEETING_CREATED':
      s.meetings[e.payload.meetingId] = { ...e.payload, seq, status: 'created', outcome: null, decisionIds: [], tokenCost: 0, messageIds: [] };
      tl(`Meeting called by ${e.payload.convenerId}: ${e.payload.reason}`, e.payload.meetingId);
      break;
    case 'MEETING_STARTED': {
      const m = s.meetings[e.payload.meetingId];
      if (!m) throw new ReducerError(`unknown meeting ${e.payload.meetingId}`);
      m.status = 'active';
      for (const pid of m.participants) setActivity(pid, 'meeting', `meeting: ${m.agenda}`, 'meeting');
      tl(`Meeting started (${m.participants.length} participants)`, m.meetingId);
      break;
    }
    case 'MEETING_ENDED': {
      const m = s.meetings[e.payload.meetingId];
      if (!m) throw new ReducerError(`unknown meeting ${e.payload.meetingId}`);
      m.status = 'ended';
      m.outcome = e.payload.outcome;
      m.decisionIds = e.payload.decisionIds;
      m.tokenCost = e.payload.tokenCost;
      m.messageIds = s.messageOrder.filter((id) => s.messages[id]?.meetingId === m.meetingId);
      for (const pid of m.participants) {
        const a = agent(pid);
        if (a) for (const mid of m.messageIds) pushUnique(a.knownMessageIds, mid);
        setActivity(pid, 'working', 'back from meeting');
      }
      tl(`Meeting ended: ${e.payload.outcome}`, m.meetingId);
      break;
    }

    case 'ARTIFACT_CREATED': {
      const p = e.payload;
      s.artifacts[p.artifactId] = { ...p, seq, timestamp: ts };
      s.artifactOrder.push(p.artifactId);
      for (const v of p.visibleTo) {
        const a = agent(v);
        if (a) pushUnique(a.knownArtifactIds, p.artifactId);
      }
      const au = agent(p.authorId);
      if (au) {
        au.stats.artifactsCreated += 1;
        if (p.kind === 'review' || p.kind === 'risk_report') au.stats.reviews += 1;
      }
      if (p.taskId && s.tasks[p.taskId]) s.tasks[p.taskId]!.outputArtifactIds.push(p.artifactId);
      work(p.authorId, p.taskId);
      const verb = p.kind === 'code' ? 'writing code' : p.kind === 'tests' ? 'writing tests' : p.kind === 'review' ? 'reviewing' : `writing ${p.kind}`;
      setActivity(p.authorId, p.kind === 'review' || p.kind === 'risk_report' ? 'reviewing' : 'working', `${verb}: ${p.title}`, ARTIFACT_ROOM[p.kind]);
      tl(`${p.authorId} created ${p.kind}: ${p.title}`, p.artifactId);
      break;
    }

    case 'EXPERIMENT_STARTED': {
      s.checkRuns[e.payload.experimentRunId] = { ...e.payload, seq, result: null };
      const a = agent(e.payload.agentId);
      if (a) a.stats.checksRun += 1;
      work(e.payload.agentId, e.payload.taskId);
      setActivity(e.payload.agentId, 'working', 'running public checks', 'experiment');
      break;
    }
    case 'EXPERIMENT_COMPLETED': {
      const r = s.checkRuns[e.payload.experimentRunId];
      if (!r) throw new ReducerError(`unknown check run ${e.payload.experimentRunId}`);
      r.result = e.payload;
      setActivity(e.payload.agentId, 'working', `checks: ${e.payload.passed}/${e.payload.total} passed${e.payload.timedOut ? ' (timeout)' : ''}`, 'experiment');
      tl(`${e.payload.agentId} ran checks: ${e.payload.passed}/${e.payload.total} passed`, e.payload.experimentRunId);
      break;
    }

    case 'DECISION_CREATED': {
      const p = e.payload;
      s.decisions[p.decisionId] = { ...p, seq, timestamp: ts, votes: [], outcome: null };
      s.decisionOrder.push(p.decisionId);
      for (const pid of [p.proposerId, ...p.participants]) {
        const a = agent(pid);
        if (a) pushUnique(a.knownDecisionIds, p.decisionId);
      }
      setActivity(p.proposerId, 'working', `proposed decision: ${p.question}`, 'decision');
      tl(`Decision proposed by ${p.proposerId}: ${p.question}`, p.decisionId);
      break;
    }
    case 'VOTE_CAST': {
      const d = s.decisions[e.payload.decisionId];
      if (!d) throw new ReducerError(`unknown decision ${e.payload.decisionId}`);
      d.votes.push({ ...e.payload, seq });
      const a = agent(e.payload.agentId);
      if (a) a.stats.votes += 1;
      setActivity(e.payload.agentId, 'working', `voted ${e.payload.option}`, 'decision');
      break;
    }
    case 'DECISION_COMPLETED': {
      const d = s.decisions[e.payload.decisionId];
      if (!d) throw new ReducerError(`unknown decision ${e.payload.decisionId}`);
      d.outcome = { ...e.payload, seq };
      tl(`Decision: ${d.question} → ${e.payload.chosen} (${e.payload.policy}, conf ${e.payload.confidence.toFixed(2)})`, d.decisionId);
      break;
    }

    case 'MEMORY_WRITTEN':
      s.memory[e.payload.memoryId] = { ...e.payload, seq, timestamp: ts, retrievals: 0 };
      if (e.actorId && s.agents[e.actorId]) setActivity(e.actorId, 'working', `recording ${e.payload.kind} memory`, 'library');
      tl(`Memory written (${e.payload.scope}/${e.payload.kind})`, e.payload.memoryId);
      break;
    case 'MEMORY_RETRIEVED':
      for (const id of e.payload.itemIds) if (s.memory[id]) s.memory[id]!.retrievals += 1;
      setActivity(e.payload.agentId, 'working', `consulting memory: ${e.payload.query}`, 'library');
      break;
    case 'BELIEF_UPDATED': {
      const a = agent(e.payload.agentId);
      if (a) a.beliefs[e.payload.beliefId] = { beliefId: e.payload.beliefId, claim: e.payload.claim, confidence: e.payload.confidence, evidence: e.payload.evidence, seq };
      break;
    }
    case 'RELATIONSHIP_UPDATED': {
      const k = `${e.payload.from}->${e.payload.to}`;
      s.relationships[k] = { ...(s.relationships[k] ?? {}), [e.payload.field]: e.payload.value };
      break;
    }

    case 'MODEL_CALL_STARTED':
      s.modelCallsInFlight[e.payload.callId] = { agentId: e.payload.agentId, purpose: e.payload.purpose, seq };
      if (e.payload.agentId) setActivity(e.payload.agentId, 'thinking', e.payload.purpose, agent(e.payload.agentId)?.homeRoom);
      break;
    case 'MODEL_CALL_COMPLETED': {
      const p = e.payload;
      delete s.modelCallsInFlight[p.callId];
      const tok = totalTokens(p.usage);
      const add = (b: CostBucket) => {
        b.calls += 1;
        b.tokens += tok;
        b.inputTokens += tok - p.usage.outputTokens;
        b.outputTokens += p.usage.outputTokens;
        b.usd += p.costUsd;
      };
      add(s.costs.total);
      add(s.costs.byCategory[p.category]);
      const a = agent(p.agentId);
      if (a) {
        a.tokensConsumed += tok;
        a.calls += 1;
        a.usd += p.costUsd;
      }
      if (p.taskId && s.tasks[p.taskId]) {
        const t = s.tasks[p.taskId]!;
        t.tokens += tok;
        t.calls += 1;
        t.usd += p.costUsd;
      }
      break;
    }
    case 'MODEL_CALL_FAILED':
      delete s.modelCallsInFlight[e.payload.callId];
      tl(`Model call failed${e.payload.agentId ? ` (${e.payload.agentId})` : ''}: ${e.payload.error}`);
      break;

    case 'BUDGET_UPDATED':
      s.budget[e.payload.scope] = e.payload;
      break;
    case 'BUDGET_EXHAUSTED':
      tl(`Budget exhausted (${e.payload.scope}/${e.payload.resource}): ${e.payload.detail}`, e.payload.taskId);
      break;
    case 'ACTION_REJECTED': {
      s.rejectedActions.push({ ...e.payload, seq });
      const a = agent(e.payload.agentId);
      if (a) a.stats.actionsRejected += 1;
      break;
    }
    case 'TOOL_INVOKED':
      s.toolInvocations += 1;
      break;

    case 'EVALUATION_COMPLETED': {
      const t = s.tasks[e.payload.taskId];
      if (!t) throw new ReducerError(`evaluation for unknown task ${e.payload.taskId}`);
      t.evaluation = e.payload;
      t.status = 'VERIFYING';
      tl(`Evaluated ${t.title}: ${e.payload.passed}/${e.payload.total} hidden tests (${e.payload.evaluator})`, t.id);
      break;
    }
    case 'REWARD_RECORDED': {
      const t = s.tasks[e.payload.taskId];
      if (!t) throw new ReducerError(`reward for unknown task ${e.payload.taskId}`);
      t.reward = e.payload;
      break;
    }

    case 'RL_STATE_OBSERVED':
      break;
    case 'RL_ACTION_SELECTED':
      s.policySelections.push({ ...e.payload, seq });
      tl(`${e.payload.label} selected ${e.payload.chosen}`);
      break;

    case 'EVOLUTION_TRIGGERED':
      s.evolution.entries.push({ seq, kind: 'triggered', generation: e.payload.generation, genomeId: s.genome?.id ?? '', detail: `${e.payload.trigger} at task ${e.payload.taskIndex}` });
      tl(`Evolution triggered (${e.payload.trigger})`);
      break;
    case 'DIAGNOSIS_RECORDED':
      break;
    case 'MUTATION_PROPOSED': {
      const p = e.payload.proposal;
      s.evolution.proposals[p.id] = { proposal: p, seq, validation: null, status: 'proposed', rejectionReason: null };
      s.evolution.entries.push({ seq, kind: 'proposed', generation: s.evolution.generation, genomeId: s.genome?.id ?? '', detail: `${p.mutation.type}: ${p.hypothesis}`, proposalId: p.id, mutation: p.mutation });
      tl(`Mutation proposed (${p.proposer}): ${p.mutation.type}`, p.id);
      break;
    }
    case 'MUTATION_VALIDATED': {
      const pv = s.evolution.proposals[e.payload.proposalId];
      if (pv) pv.validation = e.payload;
      // Shadow-run validation cost is attributed to this (parent) run's lifetime cost (III Control 4).
      for (const b of [s.costs.total, s.costs.byCategory.validation]) {
        b.calls += e.payload.cost.calls;
        b.tokens += e.payload.cost.tokens;
        b.usd += e.payload.cost.usd;
      }
      s.evolution.entries.push({
        seq,
        kind: 'validated',
        generation: s.evolution.generation,
        genomeId: s.genome?.id ?? '',
        detail: `incumbent ${fmt(e.payload.incumbentScore)} vs candidate ${fmt(e.payload.candidateScore)} → ${e.payload.accepted ? 'accept' : 'reject'}`,
        proposalId: e.payload.proposalId,
      });
      break;
    }
    case 'MUTATION_REJECTED': {
      const pv = s.evolution.proposals[e.payload.proposalId];
      if (pv) {
        pv.status = 'rejected';
        pv.rejectionReason = e.payload.reason;
      }
      s.evolution.entries.push({ seq, kind: 'rejected', generation: s.evolution.generation, genomeId: s.genome?.id ?? '', detail: e.payload.reason, proposalId: e.payload.proposalId });
      tl(`Mutation rejected: ${e.payload.reason}`, e.payload.proposalId);
      break;
    }
    case 'ORGANIZATION_MUTATED': {
      const p = e.payload;
      s.genome = p.genome;
      s.genomes[p.genome.id] = p.genome;
      s.evolution.generation = p.generation;
      if (p.proposalId && s.evolution.proposals[p.proposalId]) s.evolution.proposals[p.proposalId]!.status = 'accepted';
      s.evolution.entries.push({ seq, kind: 'mutated', generation: p.generation, genomeId: p.toGenomeId, detail: describeMutation(p.mutation), ...(p.proposalId ? { proposalId: p.proposalId } : {}), mutation: p.mutation });
      tl(`Organization mutated → gen ${p.generation}: ${describeMutation(p.mutation)}`, p.toGenomeId);
      break;
    }
    case 'ORGANIZATION_ROLLED_BACK':
      s.genome = e.payload.genome;
      s.genomes[e.payload.genome.id] = e.payload.genome;
      s.evolution.generation = e.payload.genome.generation;
      s.evolution.entries.push({ seq, kind: 'rolled_back', generation: e.payload.genome.generation, genomeId: e.payload.toGenomeId, detail: e.payload.reason });
      tl(`Organization rolled back: ${e.payload.reason}`, e.payload.toGenomeId);
      break;
    case 'ROLE_CHANGED':
    case 'TEAM_CREATED':
    case 'TEAM_DISSOLVED':
    case 'PROBE_EVALUATED':
      break;
    case 'ANOMALY_DETECTED':
      s.anomalies.push({ ...e.payload, seq });
      tl(`Anomaly: ${e.payload.kind} — ${e.payload.detail}`);
      break;
    case 'CONTAMINATION_RECORDED':
      s.contaminated = true;
      tl(`Contamination: ${e.payload.action} (${e.payload.source})`);
      break;
    case 'REFLECTION_RECORDED': {
      const p = e.payload;
      (s.learning ??= emptyLearning()).reflections.push({ ...p, seq });
      setActivity(p.agentId, 'working', `reviewing why the task ${p.success ? 'passed' : 'failed'}`, 'library');
      tl(`${p.agentId} reviewed the task (${p.success ? 'passed' : 'failed'}): ${p.lesson}`, p.memoryId);
      break;
    }
    case 'LESSON_EVALUATED': {
      const p = e.payload;
      (s.learning ??= emptyLearning()).lessons[p.memoryId] = { ...p, seq };
      if (p.retired) tl(`Lesson ${p.memoryId} retired: helped ${p.wins}/${p.uses} tasks (baseline ${(p.baseline * 100).toFixed(0)}%)`, p.memoryId);
      break;
    }
    case 'DECISION_REVIEWED': {
      const p = e.payload;
      (s.learning ??= emptyLearning()).decisionReviews.push({ ...p, seq });
      tl(`Decision ${p.decisionId} reviewed: chose ${p.chosen}, task ${p.taskSuccess ? 'passed' : 'failed'}${p.predictedSuccess === null ? '' : ` (predicted ${(p.predictedSuccess * 100).toFixed(0)}%)`}`, p.decisionId);
      break;
    }
    case 'ARGUMENT_MADE': {
      const p = e.payload;
      (s.learning ??= emptyLearning()).arguments.push({ ...p, seq });
      setActivity(p.agentId, 'working', `${p.stance === 'premortem' ? 'pre-mortem on' : p.stance === 'against' ? 'arguing against' : 'defending'} ${p.option}`, 'decision');
      tl(`${p.agentId} ${p.stance === 'premortem' ? 'pre-mortem' : p.stance === 'against' ? 'argues against' : 'rebuts for'} "${p.option}": ${p.content}`, p.decisionId);
      break;
    }
    case 'PLANS_PROPOSED': {
      const p = e.payload;
      (s.learning ??= emptyLearning()).plans.push({ ...p, seq });
      const best = p.plans.find((x) => x.planId === p.chosenPlanId);
      setActivity(p.agentId, 'thinking', `weighing ${p.plans.length} plans`, 'decision');
      tl(`${p.agentId} weighed ${p.plans.length} plans; chose ${p.chosenPlanId}${best ? ` (predicted ${(best.predictedSuccess * 100).toFixed(0)}%)` : ''}`, p.taskId);
      break;
    }
    case 'PREDICTION_SCORED':
      (s.learning ??= emptyLearning()).predictions.push({ ...e.payload, seq });
      break;
    case 'COUNTERFACTUAL_EVALUATED': {
      const p = e.payload;
      (s.learning ??= emptyLearning()).counterfactuals.push({ ...p, seq });
      chargeShadow(s, p.cost);
      tl(`Counterfactual for ${p.proposalId}: ${p.alternativeScore.toFixed(2)} vs current ${p.incumbentScore.toFixed(2)} on ${p.taskIds.length} failed task(s)`, p.proposalId);
      break;
    }
    case 'CONTRIBUTION_MEASURED': {
      const p = e.payload;
      (s.learning ??= emptyLearning()).contributions.push({ ...p, seq });
      chargeShadow(s, p.cost);
      tl(`Contribution of ${p.agentId}: ${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(2)} (with ${p.withScore.toFixed(2)}, without ${p.withoutScore.toFixed(2)})`, p.agentId);
      break;
    }
    default: {
      const never: never = e;
      throw new ReducerError(`unhandled event type ${(never as OrgEvent).type}`);
    }
  }
  return s;
}

/** Shadow re-execution cost counts toward this (parent) run's lifetime cost, as validation (III Control 4). */
function chargeShadow(s: WorldState, cost: { tokens: number; calls: number; usd: number }): void {
  for (const b of [s.costs.total, s.costs.byCategory.validation]) {
    b.calls += cost.calls;
    b.tokens += cost.tokens;
    b.usd += cost.usd;
  }
}

function fmt(n: number | null): string {
  return n === null ? 'n/a' : n.toFixed(3);
}

function kindVerb(k: MessageKind): string {
  switch (k) {
    case 'DELEGATION':
      return 'delegating to';
    case 'REVIEW_REQUEST':
      return 'requesting review from';
    case 'REVIEW_RESPONSE':
      return 'reviewing for';
    case 'CHALLENGE':
      return 'challenging';
    case 'QUESTION':
      return 'asking';
    case 'ANSWER':
      return 'answering';
    default:
      return 'messaging';
  }
}

export function describeMutation(m: Mutation): string {
  switch (m.type) {
    case 'ADD_AGENT':
      return `+ agent ${m.agent.id} (${m.agent.roleId})`;
    case 'REMOVE_AGENT':
      return `− agent ${m.agentId}`;
    case 'CHANGE_ROLE':
      return `${m.agentId} role → ${m.role.id}`;
    case 'ADD_EDGE':
      return `+ edge ${m.edge.from}→${m.edge.to} (${m.edge.kind})`;
    case 'REMOVE_EDGE':
      return `− edge ${m.from}→${m.to}`;
    case 'CREATE_TEAM':
      return `+ team ${m.team.name}`;
    case 'DISSOLVE_TEAM':
      return `− team ${m.teamId}`;
    case 'CHANGE_DECISION_METHOD':
      return `decision policy → ${m.policy}`;
    case 'CHANGE_SUBMIT_POLICY':
      return `submit policy → ${m.submit}`;
    case 'ROLLBACK':
      return `rollback → ${m.toGenomeId}`;
  }
}

/** Full replay: fresh state reduced over all events (build §20). */
export function reduceEvents(events: Iterable<OrgEvent>, upToSequence = Number.POSITIVE_INFINITY): WorldState {
  const s = initialWorldState();
  for (const e of events) {
    if (e.sequence > upToSequence) break;
    applyEvent(s, e);
  }
  return s;
}
