import type { OrganizationGenome, RunConfig } from '@orgworld/protocol';
import { agentKnowledge, canSubmit, capabilitiesOf, roleOf, truncate, type WorldState } from '@orgworld/core';
import type { ActionType } from './actions.ts';
import type { TaskSpec } from './tasks.ts';
import type { MemoryItem } from './memory.ts';

export function allowedActions(g: OrganizationGenome, cfg: RunConfig, agentId: string, repoRead: boolean, kind: TaskSpec['kind']): ActionType[] {
  const caps = capabilitiesOf(g, agentId);
  const a: ActionType[] = ['send_message', 'record_belief', 'remember', 'recall', 'wait'];
  if (caps.includes('write_code')) a.push('write_code');
  if (caps.includes('write_tests')) a.push('write_tests');
  if (caps.includes('run_checks') && kind === 'bench') a.push('run_checks');
  if (caps.includes('review')) a.push('review');
  if (canSubmit(g, agentId)) a.push('submit');
  const coord = caps.includes('decide') || caps.includes('plan') || caps.includes('mediate');
  if (coord && cfg.features.decisions) a.push('propose_decision');
  if (coord && cfg.features.meetings) a.push('call_meeting');
  if (repoRead && kind === 'objective' && caps.includes('research')) a.push('read_file', 'list_files');
  return a;
}

const ACTION_HELP: Record<ActionType, string> = {
  send_message: '{"type":"send_message","to":["<agentId>"],"kind":"DELEGATION|QUESTION|ANSWER|PROPOSAL|CHALLENGE|EVIDENCE|REVIEW_REQUEST|REVIEW_RESPONSE|STATUS_UPDATE|DIRECT_MESSAGE","content":"...","attach":["<artifactId>"]} — recipients only learn what you send; attach artifacts you want them to see.',
  write_code: '{"type":"write_code","title":"...","code":"<complete solution.js contents (CommonJS)>"} — creates a code artifact (only you see it until you attach it to a message).',
  write_tests: '{"type":"write_tests","title":"...","code":"<complete node:test file that require(\'./solution.js\')>"}',
  run_checks: '{"type":"run_checks","artifactId":"<artifact you know>"} — runs the PUBLIC checks; you see results next turn.',
  review: '{"type":"review","artifactId":"<code artifact>","verdict":"approve|request_changes","comments":"..."} — your review is sent to the author if you can message them.',
  submit: '{"type":"submit","artifactId":"<artifact>"} — submits the final deliverable; hidden tests decide the outcome. Ends the task.',
  record_belief: '{"type":"record_belief","claim":"...","confidence":0.0-1.0} — private.',
  remember: '{"type":"remember","content":"lesson with context","scope":"private|team|org","kind":"semantic|episodic|failure|decision"} — persists organizational memory.',
  recall: '{"type":"recall","query":"..."} — search memory you are allowed to read; results next turn.',
  propose_decision: '{"type":"propose_decision","question":"...","options":["A","B"],"recommendation":"A"} — your contacts vote now; outcome is recorded.',
  call_meeting: '{"type":"call_meeting","participants":["<agentId>",...],"agenda":"..."} — each participant contributes once; costs budget.',
  read_file: '{"type":"read_file","path":"relative/path"} — read a repository file (read-only).',
  list_files: '{"type":"list_files","path":"relative/dir"}',
  wait: '{"type":"wait"} — do nothing this turn.',
};

export function systemPrompt(state: WorldState, cfg: RunConfig, agentId: string, actions: ActionType[]): string {
  const g = state.genome!;
  const role = roleOf(g, agentId)!;
  const me = g.agents.find((a) => a.id === agentId)!;
  const contacts = g.edges
    .filter((e) => e.from === agentId)
    .map((e) => {
      const r = roleOf(g, e.to);
      return `${e.to} (${r?.name ?? '?'}; ${e.kind})`;
    });
  const submitters = g.agents.filter((a) => canSubmit(g, a.id)).map((a) => a.id);
  return [
    `You are ${me.name} (agent id "${agentId}"), one member of an AI organization working on software tasks.`,
    `Role: ${role.name} — ${role.objective}`,
    `You can message ONLY: ${contacts.length ? contacts.join(', ') : 'nobody'}.`,
    canSubmit(g, agentId)
      ? 'You are allowed to submit the final deliverable.'
      : `You cannot submit. Final deliverables are submitted by: ${submitters.join(', ')}.`,
    '',
    'How this organization works:',
    `- Each turn reply with JSON {"reasoning": "...", "actions": [...]} containing 1-${g.policies.maxActionsPerTurn} actions. Unknown or invalid actions are rejected and you will be told why.`,
    '- Other agents only know what reaches them through messages, meetings and attached artifacts. They cannot see your private work.',
    '- Code is a single CommonJS module file (solution.js). Always write COMPLETE file contents.',
    '- Hidden tests you cannot see decide success. Public checks are a small subset.',
    '- Every turn spends shared budget. Prefer concrete work; avoid chatter.',
    '',
    'Actions you may use:',
    ...actions.map((a) => `- ${ACTION_HELP[a]}`),
  ].join('\n');
}

export interface TurnFeedback {
  lines: string[];
}

export function taskBrief(spec: TaskSpec): string {
  if (spec.kind === 'objective') return `OBJECTIVE: ${spec.title}\n${spec.objective}\n(Deliverables are artifacts; there is no hidden test suite for this objective.)`;
  const t = spec.task;
  const deliverable =
    t.deliverable === 'tests'
      ? 'Deliverable: a node:test test file (write_tests) that require("./solution.js"); it must pass on a correct implementation and fail on buggy ones.'
      : 'Deliverable: the complete solution.js module (write_code).';
  return [`TASK ${t.id} — ${t.title} [category: ${t.category}]`, deliverable, '', t.statement, '', 'Starter code:', '```js', t.starterCode.trimEnd(), '```'].join('\n');
}

export function turnPrompt(args: {
  state: WorldState;
  agentId: string;
  taskId: string;
  spec: TaskSpec;
  turn: number;
  maxTurns: number;
  budget: { tokens: number | null; calls: number | null };
  newMessageIds: string[];
  feedback: string[];
  previousReasoning: string[];
  memories: MemoryItem[];
  nudge: string | null;
}): string {
  const { state, agentId } = args;
  const k = agentKnowledge(state, agentId)!;
  const out: string[] = [taskBrief(args.spec), ''];
  out.push(`YOUR STATUS: turn ${args.turn}/${args.maxTurns} of this task. Task budget left: ${args.budget.tokens ?? '∞'} tokens, ${args.budget.calls ?? '∞'} model calls.`);
  if (args.previousReasoning.length) out.push('Your previous turns on this task:', ...args.previousReasoning.map((r) => `- ${r}`));
  out.push('', 'NEW SINCE YOUR LAST TURN:');
  const newMsgs = args.newMessageIds.map((id) => state.messages[id]!).filter(Boolean);
  if (!newMsgs.length && !args.feedback.length && !args.nudge) out.push('- (nothing new)');
  for (const m of newMsgs) {
    const from = state.agents[m.from];
    out.push(`- [${m.messageId}] from ${m.from}${from ? ` (${from.roleName})` : ''} ${m.kind}: ${truncate(m.content, 1500)}${m.artifactIds.length ? ` [attached: ${m.artifactIds.join(', ')}]` : ''}`);
  }
  for (const f of args.feedback) out.push(`- ${f}`);
  if (args.nudge) out.push(`- ${args.nudge}`);
  if (args.memories.length) {
    out.push('', 'RELEVANT ORGANIZATIONAL MEMORY (with provenance):');
    for (const m of args.memories) out.push(`- [${m.memoryId}] (${m.scope}/${m.kind}, from run ${m.runId}, task ${m.provenance.taskId ?? '-'}) ${truncate(m.content, 400)}`);
  }
  const taskArtifacts = k.artifacts.filter((a) => a.taskId === args.taskId);
  out.push('', 'ARTIFACTS YOU KNOW FOR THIS TASK (oldest → newest):');
  if (!taskArtifacts.length) out.push('- (none)');
  for (const a of taskArtifacts.slice(-12)) out.push(`- ${a.artifactId} ${a.kind} "${a.title}" by ${a.authorId}`);
  // Show full content of the newest code/tests artifact you know, and anything newly attached.
  const show = new Set<string>();
  const newestCode = [...taskArtifacts].reverse().find((a) => a.kind === 'code' || a.kind === 'tests');
  if (newestCode) show.add(newestCode.artifactId);
  for (const m of newMsgs) for (const id of m.artifactIds) show.add(id);
  for (const id of show) {
    const a = state.artifacts[id];
    if (!a || !k.artifacts.some((x) => x.artifactId === id)) continue;
    out.push('', `CONTENT OF ${a.artifactId} (${a.kind} "${a.title}" by ${a.authorId}):`, '```', truncate(a.content, 9000), '```');
  }
  const openDecisions = k.decisions.filter((d) => d.taskId === args.taskId && d.outcome);
  for (const d of openDecisions.slice(-3)) out.push(`Decision ${d.decisionId}: "${d.question}" → ${d.outcome!.chosen} (${d.outcome!.policy}, confidence ${d.outcome!.confidence.toFixed(2)})`);
  out.push('', 'Reply with the JSON object now.');
  return out.join('\n');
}
