import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { agentKnowledge, newId } from '@orgworld/core';
import type { EventStore } from '@orgworld/store';
import { MemoryIndex } from '@orgworld/runtime';
import { ORGWORLD_VERSION, type OrgEvent } from '@orgworld/protocol';

/** Workspace-level audit run that records every MCP tool invocation (build §56 "log tool usage"). */
export const TOOL_LOG_RUN = 'workspace_tool_log';

type Group = 'read' | 'write' | 'exec';
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const err = (m: string) => ({ isError: true, content: [{ type: 'text' as const, text: m }] });

export function buildMcpServer(store: EventStore): McpServer {
  const server = new McpServer({ name: 'orgworld', version: ORGWORLD_VERSION });
  const log = (tool: string, group: Group, input: Record<string, unknown>, ok: boolean, error?: string) =>
    store.append(TOOL_LOG_RUN, { type: 'TOOL_INVOKED', actorId: 'mcp', payload: { tool, group, input, ok, ...(error ? { error } : {}) } });
  const latest = (runId?: string): string | null => runId ?? store.listRuns().find((r) => !r.runId.includes('-val') && r.runId !== TOOL_LOG_RUN)?.runId ?? null;

  function tool<S extends z.ZodRawShape>(name: string, group: Group, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => unknown) {
    (server.registerTool as unknown as (n: string, c: object, cb: (args: unknown) => Promise<object>) => void)(name, { description: `[${group}] ${description}`, inputSchema: shape }, async (args: unknown) => {
      const input = (args ?? {}) as Record<string, unknown>;
      try {
        const r = await fn(input as z.infer<z.ZodObject<S>>);
        log(name, group, input, true);
        return text(r);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        log(name, group, input, false, m);
        return err(m);
      }
    });
  }

  const requireRun = (runId?: string) => latest(runId) ?? (() => { throw new Error('no runs in this workspace'); })();
  /** Write tools never modify a locked experiment; attempts are recorded as contamination (build §37). */
  const writable = (runId: string, action: string) => {
    const s = store.runState(runId);
    if (s.config?.mode === 'experiment') {
      store.append(runId, { type: 'CONTAMINATION_RECORDED', actorId: 'mcp', payload: { source: 'mcp', action, detail: 'write attempted on a locked experiment run — refused' } });
      throw new Error(`run ${runId} is a locked experiment; ${action} is refused (attempt recorded as contamination)`);
    }
    return s;
  };

  tool('orgworld_list_runs', 'read', 'List runs in this workspace.', {}, () => store.listRuns().filter((r) => r.runId !== TOOL_LOG_RUN).slice(0, 50));
  tool('orgworld_get_state', 'read', 'Summary of a run (default latest): status, tasks, agents, costs.', { runId: z.string().optional() }, ({ runId }) => {
    const id = requireRun(runId);
    const s = store.runState(id);
    return {
      runId: id,
      status: s.status,
      condition: s.config?.condition,
      genome: s.genome ? { id: s.genome.id, generation: s.genome.generation, agents: s.genome.agents.length, edges: s.genome.edges.length } : null,
      tasks: s.taskOrder.map((t) => ({ id: t, title: s.tasks[t]!.title, status: s.tasks[t]!.status, score: s.tasks[t]!.score })),
      agents: s.agentOrder.map((a) => ({ id: a, role: s.agents[a]!.roleName, status: s.agents[a]!.status, activity: s.agents[a]!.activity })),
      costs: s.costs.total,
    };
  });
  tool('orgworld_get_agent', 'read', "What one agent knows (its own view only — never hidden global state).", { agentId: z.string().min(1), runId: z.string().optional() }, ({ agentId, runId }) => {
    const k = agentKnowledge(store.runState(requireRun(runId)), agentId);
    if (!k) throw new Error(`unknown agent ${agentId}`);
    return { agent: { id: k.agent.id, role: k.agent.roleName, status: k.agent.status, activity: k.agent.activity, calls: k.agent.calls, tokens: k.agent.tokensConsumed }, messages: k.messages.slice(-10).map((m) => ({ from: m.from, to: m.to, kind: m.kind, content: m.content })), artifacts: k.artifacts.map((a) => ({ id: a.artifactId, kind: a.kind, title: a.title })), unknown: k.unknown };
  });
  tool('orgworld_get_budget', 'read', 'Token / call / $ usage of a run by category.', { runId: z.string().optional() }, ({ runId }) => {
    const s = store.runState(requireRun(runId));
    return { total: s.costs.total, byCategory: s.costs.byCategory, lastTaskBudget: s.budget.task };
  });
  tool('orgworld_why', 'read', 'Latest organizational decision with only its persisted provenance.', { runId: z.string().optional() }, ({ runId }) => {
    const s = store.runState(requireRun(runId));
    const d = [...s.decisionOrder].reverse().map((i) => s.decisions[i]!).find((x) => x.outcome);
    return d ? { decision: d.question, proposer: d.proposerId, evidence: d.evidence, votes: d.votes.map((v) => ({ agent: v.agentId, option: v.option, rationale: v.rationale })), outcome: d.outcome } : 'No decision recorded in this run.';
  });
  tool('orgworld_query_memory', 'read', 'Search organizational memory as a given agent (scope-checked, with provenance).', { query: z.string().min(1).max(300), agentId: z.string().default('director') }, ({ query, agentId }) => {
    const idx = new MemoryIndex();
    let after = 0;
    for (;;) {
      const b = store.tailGlobal(after, 2000);
      if (!b.length) break;
      for (const g of b) {
        after = g.gseq;
        if (g.event.type === 'MEMORY_WRITTEN') idx.add(g.event as OrgEvent<'MEMORY_WRITTEN'>);
      }
    }
    const r = idx.retrieve(query, agentId, null, 'org', 5);
    return { items: r.items.map((m) => ({ id: m.memoryId, scope: m.scope, kind: m.kind, content: m.content, provenance: m.provenance })), deniedCount: r.denied.length };
  });
  tool('orgworld_send_message', 'write', 'Sandbox only: send a user message to an agent; it reads it on its next turn.', { to: z.string().min(1), content: z.string().min(1).max(4000), runId: z.string().optional() }, ({ to, content, runId }) => {
    const id = requireRun(runId);
    const s = writable(id, 'send_message');
    if (!s.agents[to]) throw new Error(`unknown agent ${to}`);
    const e = store.append(id, { type: 'MESSAGE_SENT', actorId: 'user', payload: { messageId: newId('msg'), from: 'user', to: [to], kind: 'DIRECT_MESSAGE', content, taskId: null, artifactIds: [], tokenCost: Math.ceil(content.length / 4) } });
    return { ok: true, eventId: e.eventId, sequence: e.sequence };
  });
  tool('orgworld_write_memory', 'write', 'Sandbox only: add an organizational lesson (provenance = this tool call).', { content: z.string().min(1).max(1500), kind: z.enum(['semantic', 'episodic', 'failure', 'decision']).default('semantic'), runId: z.string().optional() }, ({ content, kind, runId }) => {
    const id = requireRun(runId);
    const s = writable(id, 'write_memory');
    const audit = store.append(TOOL_LOG_RUN, { type: 'TOOL_INVOKED', actorId: 'mcp', payload: { tool: 'orgworld_write_memory#provenance', group: 'write', input: { runId: id }, ok: true } });
    const e = store.append(id, { type: 'MEMORY_WRITTEN', actorId: 'user', payload: { memoryId: newId('mem'), scope: 'org', kind, content, provenance: { runId: id, taskId: null, genomeId: s.genome?.id ?? 'none', sourceEventIds: [audit.eventId], evidenceArtifactIds: [] } } });
    return { ok: true, memoryEventId: e.eventId };
  });
  tool('orgworld_control', 'exec', 'Pause, resume or stop a run (stop on an experiment is recorded as contamination).', { action: z.enum(['pause', 'resume', 'stop']), runId: z.string().optional() }, ({ action, runId }) => {
    const id = requireRun(runId);
    if (store.runState(id).config?.mode === 'experiment' && action === 'stop') store.append(id, { type: 'CONTAMINATION_RECORDED', actorId: 'mcp', payload: { source: 'mcp', action: 'stop', detail: 'stopped during an experiment' } });
    store.setKv(`control:${id}`, { action, at: new Date().toISOString() });
    return { ok: true, runId: id, action };
  });
  return server;
}

export const dbPathFromEnv = () => process.env.ORGWORLD_DB ?? join(process.env.ORGWORLD_HOME ?? join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), '.orgworld'), 'orgworld.db');
