#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { ModelConfig, ORGWORLD_VERSION, OrganizationGenome, type ExperimentConfigInput, type RunConfigInput } from '@orgworld/protocol';
import { agentKnowledge, newId, presetGenome, PRESETS, reduceEvents } from '@orgworld/core';
import { EventStore, exportRun } from '@orgworld/store';
import { createProvider, isPaidProvider, paidAllowed, resolveClaudeBin } from '@orgworld/cognition';
import { FAMILIES, taskById } from '@orgworld/bench';
import { buildRunConfig, createRun, OrgRunner } from '@orgworld/runtime';
import { runMetrics } from '@orgworld/metrics';
import { experimentIdOf, experimentReadings, readingsCsv, resultsCsv, runExperiment } from '@orgworld/experiment';
import { startServer } from '@orgworld/server';

interface WorkspaceConfig {
  model: { provider: string; model: string; seed?: number };
  preset: string;
  mode: 'sandbox' | 'experiment';
  features: { crossTaskMemory: boolean; relationships: boolean };
  evolution: { enabled: boolean };
  server: { port: number };
}
const DEFAULT_CONFIG: WorkspaceConfig = {
  // Free, local cognition by default — no money involved. Paid providers require --allow-paid.
  model: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
  preset: 'software-org-12',
  mode: 'sandbox',
  features: { crossTaskMemory: true, relationships: false },
  evolution: { enabled: false },
  server: { port: 4317 },
};

const out = (s = '') => process.stdout.write(s + '\n');
const fail = (s: string): never => {
  process.stderr.write(`orgworld: ${s}\n`);
  process.exit(1);
};

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--') && ['task', 'preset', 'model', 'provider', 'port', 'out', 'run', 'as', 'stop-at', 'csv'].includes(k)) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function readExperimentConfig(file: string): ExperimentConfigInput {
  const raw = readFileSync(file, 'utf8');
  return (file.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)) as ExperimentConfigInput;
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
/** "HH:MM" = the next time the local clock shows it; anything else must be a parseable date-time. */
function parseStopAt(v: string): number {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : fail(`--stop-at: expected HH:MM or an ISO date-time, got "${v}"`);
}

const wsDir = () => resolve(process.env.ORGWORLD_HOME ?? join(process.cwd(), '.orgworld'));
const cfgPath = () => join(wsDir(), 'config', 'orgworld.json');
function loadConfig(): WorkspaceConfig {
  return existsSync(cfgPath()) ? { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(cfgPath(), 'utf8')) as Partial<WorkspaceConfig>) } : DEFAULT_CONFIG;
}
function openStore(): EventStore {
  if (!existsSync(wsDir())) fail(`no .orgworld/ here (${process.cwd()}). Run \`orgworld init\` first.`);
  return EventStore.open(join(wsDir(), 'orgworld.db'));
}
function webRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'web'), join(here, '../../dist/web'), join(here, '../dist/web')]) if (existsSync(join(c, 'index.html'))) return c;
  return null;
}
function latestRun(store: EventStore, explicit?: string | boolean): string {
  if (typeof explicit === 'string') return explicit;
  const r = store.listRuns().find((x) => !x.runId.includes('-val'));
  return r?.runId ?? fail('no runs yet');
}
function currentGenome(store: EventStore, cfg: WorkspaceConfig): OrganizationGenome {
  const id = store.getKv<string>('current_genome');
  const g = id ? store.getGenome(id) : null;
  return g ?? presetGenome(cfg.preset);
}
function providerFor(model: ModelConfig, flags: Record<string, string | boolean>) {
  if (isPaidProvider(model.provider) && !paidAllowed(flags['allow-paid'] === true))
    fail(`"${model.provider}" costs money. OrgWorld defaults to free local cognition (ollama). Pass --allow-paid to opt in explicitly.`);
  return createProvider(model, { allowPaid: flags['allow-paid'] === true });
}

async function ensureServer(store: EventStore, cfg: WorkspaceConfig): Promise<{ url: string; close?: () => Promise<void> }> {
  const rt = join(wsDir(), 'runtime.json');
  if (existsSync(rt)) {
    const { url } = JSON.parse(readFileSync(rt, 'utf8')) as { url: string };
    try {
      const r = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return { url };
    } catch {
      /* stale */
    }
  }
  const srv = await startServer({ store, port: cfg.server.port, webRoot: webRoot() });
  writeFileSync(rt, JSON.stringify({ url: srv.url, port: srv.port, pid: process.pid }));
  return { url: srv.url, close: srv.close };
}

const HELP = `orgworld ${ORGWORLD_VERSION} — persistent self-evolving multi-agent organizations

  init [--preset <name>]           create .orgworld/ (default: 12-agent org, sandbox, free ollama cognition)
  run "<objective>"                run the organization on an objective (product mode, no hidden evaluator)
  run --task <family#variant>      run one EvoOrgBench task (hidden-test evaluation)
      [--allow-repo-read] [--allow-paid] [--no-serve]
  status | runs | agents | inspect <agent> [--as]   inspect the latest run (or --run <id>)
  why [--run <id>]                 latest decision with its persisted provenance
  replay [--run <id>]              print the recorded timeline (no model calls)
  export [--run <id>] [--out f]    write a .orgworld-run.zip (secrets scrubbed)
  experiment <config.yaml>         run a locked experiment; writes results CSV
      [--stop-at HH:MM|ISO]        start no run that would not finish by then; re-run to resume
  readings <config.yaml> [--out f.json] [--csv f.csv]
                                   progress, per-run metrics, interim aggregates (read-only)
  serve                            start the local API + web world
  pause | resume | stop [--run <id>]
  doctor                           check runtime, database, providers, ports, web, plugin
  tasks                            list benchmark task families`;

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift() ?? 'help';
  switch (cmd) {
    case 'help':
    case '--help':
      return out(HELP);
    case 'init': {
      const dir = wsDir();
      const created = !existsSync(dir);
      for (const d of ['config', 'organization', 'exports', 'experiments']) mkdirSync(join(dir, d), { recursive: true });
      const cfg = { ...DEFAULT_CONFIG, ...(typeof flags.preset === 'string' ? { preset: flags.preset } : {}) };
      if (!PRESETS[cfg.preset]) fail(`unknown preset ${cfg.preset}`);
      if (!existsSync(cfgPath())) writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2) + '\n');
      writeFileSync(join(dir, '.gitignore'), '*\n');
      const store = EventStore.open(join(dir, 'orgworld.db'));
      const g = currentGenome(store, cfg);
      store.archiveGenome(g);
      store.setKv('current_genome', g.id);
      writeFileSync(join(dir, 'organization', 'current.json'), JSON.stringify(g, null, 2) + '\n');
      store.close();
      out(`${created ? 'Initialised' : 'Already initialised'} ${dir}`);
      out(`organization  ${g.name} (${g.agents.length} agents, gen ${g.generation})`);
      out(`mode          ${cfg.mode} · cross-run memory ${cfg.features.crossTaskMemory ? 'on' : 'off'} · evolution ${cfg.evolution.enabled ? 'on' : 'off'}`);
      out(`cognition     ${cfg.model.provider}/${cfg.model.model}${isPaidProvider(cfg.model.provider) ? ' (PAID — needs --allow-paid)' : ' (free, local)'}`);
      return;
    }
    case 'tasks':
      for (const f of FAMILIES) out(`${f.id.padEnd(24)} ${f.category.padEnd(15)} difficulty ${f.difficulty} · ${f.variants} variants`);
      return;
    case 'run': {
      const cfg = loadConfig();
      const store = openStore();
      const model = ModelConfig.parse({ ...cfg.model, ...(typeof flags.provider === 'string' ? { provider: flags.provider } : {}), ...(typeof flags.model === 'string' ? { model: flags.model } : {}) });
      const provider = providerFor(model, flags);
      const genome = typeof flags.preset === 'string' ? presetGenome(flags.preset) : currentGenome(store, cfg);
      const objective = pos.join(' ').trim();
      const benchId = typeof flags.task === 'string' ? flags.task : null;
      if (!objective && !benchId) fail('give an objective or --task <family#variant>');
      const runId = newId('run');
      const runCfg = buildRunConfig({
        runId,
        mode: cfg.mode,
        kind: benchId ? 'stream' : 'objective',
        condition: benchId ? 'fixed-generalist' : 'objective',
        ...(objective ? { objective } : {}),
        label: objective || benchId!,
        genome,
        model,
        budget: {},
        reward: {},
        seeds: {},
        features: { ...cfg.features },
        evolution: {},
        policy: {},
      } as RunConfigInput);
      createRun(store, runCfg);
      const srv = flags['no-serve'] ? null : await ensureServer(store, cfg);
      out(`Run        ${runId}`);
      out(`Org        ${genome.name} · gen ${genome.generation} · ${genome.agents.length} agents`);
      out(`Cognition  ${model.provider}/${model.model}${isPaidProvider(model.provider) ? ' · PAID (explicitly allowed)' : ' · local · $0.00'}`);
      out(`Budget     ${runCfg.budget.perTask.maxTokens.toLocaleString()} tokens · ${runCfg.budget.perTask.maxCalls} model calls per task`);
      if (srv) out(`World      ${srv.url}/#${runId}`);
      const runner = new OrgRunner({ store, provider, runId, repoRoot: flags['allow-repo-read'] ? process.cwd() : null, log: (m) => out(`· ${m}`) });
      runner.instantiate(genome, 'workspace organization');
      runner.start();
      let last = runner.state.lastSequence;
      const unsub = store.subscribe((e) => {
        if (e.runId !== runId || e.sequence <= last) return;
        last = e.sequence;
        if (['MESSAGE_SENT', 'ARTIFACT_CREATED', 'EXPERIMENT_COMPLETED', 'DECISION_COMPLETED', 'AGENT_FAILED', 'BUDGET_EXHAUSTED', 'ACTION_REJECTED'].includes(e.type)) {
          // The store notifies before the runner reduces the event; read the label once it has.
          queueMicrotask(() => {
            const t = runner.state.timeline.find((x) => x.seq === e.sequence);
            const r = runner.state.rejectedActions.find((x) => x.seq === e.sequence);
            out(`  #${e.sequence} ${t ? t.label.slice(0, 140) : r ? `${r.agentId} ${r.action} rejected: ${r.reason.slice(0, 120)}` : e.type}`);
          });
        }
      });
      try {
        const res = await runner.runTask(benchId ? { kind: 'bench', task: taskById(benchId) } : { kind: 'objective', title: objective.slice(0, 120), objective });
        runner.complete({ tasks: 1, success: res.success ? 1 : 0, score: res.score });
        out(`Status     ${res.success ? 'SUCCESS' : 'FAILED'}${res.evaluated ? ` · hidden tests score ${res.score.toFixed(2)}` : ' · not evaluated (objective mode)'} · ${res.calls} calls · ${res.tokens.toLocaleString()} tokens · $${res.usd.toFixed(4)}`);
      } catch (err) {
        runner.fail(err instanceof Error ? err.message : String(err));
        out(`Status     RUN FAILED: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      } finally {
        unsub();
      }
      if (srv?.close && !flags['exit']) out(`World stays live at ${srv.url} — Ctrl+C to stop.`);
      else store.close();
      return;
    }
    case 'status':
    case 'runs':
    case 'agents':
    case 'inspect': {
      const store = openStore();
      if (cmd === 'runs') {
        for (const r of store.listRuns().slice(0, 30)) out(`${r.runId}  ${r.status.padEnd(9)} ${r.condition.padEnd(18)} ${r.provider}/${r.model}  ${r.label ?? ''}`);
        return store.close();
      }
      const runId = latestRun(store, flags.run);
      const s = store.runState(runId);
      if (cmd === 'status') {
        const active = s.activeTaskId ? s.tasks[s.activeTaskId] : s.tasks[s.taskOrder[s.taskOrder.length - 1] ?? ''];
        out(`run ${runId} · ${s.status} · ${s.eventCount} events · ${s.costs.total.tokens.toLocaleString()} tokens · ${s.costs.total.calls} calls · $${s.costs.total.usd.toFixed(4)}`);
        if (active) out(`task ${active.title} · ${active.status}${active.score !== null ? ` · score ${active.score.toFixed(2)}` : ''}`);
        for (const id of s.agentOrder) {
          const a = s.agents[id]!;
          if (a.status !== 'idle') out(`  ${a.name}: ${a.activity}`);
        }
      } else if (cmd === 'agents') {
        for (const id of s.agentOrder) {
          const a = s.agents[id]!;
          out(`${a.id.padEnd(14)} ${a.roleName.padEnd(20)} ${a.status.padEnd(13)} calls ${String(a.calls).padStart(3)} · msgs ${a.stats.messagesSent} · artifacts ${a.stats.artifactsCreated}`);
        }
      } else {
        const agentId = pos[0] ?? fail('inspect <agent>');
        const k = agentKnowledge(s, agentId) ?? fail(`unknown agent ${agentId}`);
        out(`${k.agent.name} — ${k.agent.roleName}: ${k.agent.roleObjective}`);
        out(`status ${k.agent.status} · ${k.agent.activity}`);
        out(`knows ${k.messages.length} messages, ${k.artifacts.length} artifacts, ${k.decisions.length} decisions, ${k.memory.length} memories; unknown to it: ${k.unknown.messages} messages, ${k.unknown.artifacts} artifacts`);
        for (const m of k.messages.slice(-5)) out(`  ${m.from} → ${m.to.join(',')} [${m.kind}] ${m.content.slice(0, 120)}`);
      }
      return store.close();
    }
    case 'why': {
      const store = openStore();
      const runId = latestRun(store, flags.run);
      const s = store.runState(runId);
      const d = [...s.decisionOrder].reverse().map((id) => s.decisions[id]!).find((x) => x.outcome);
      const mut = [...s.evolution.entries].reverse().find((e) => e.kind === 'mutated' || e.kind === 'rejected' || e.kind === 'rolled_back');
      if (!d && !mut) {
        out(`No organizational decision has been recorded in run ${runId}. Nothing to explain (OrgWorld never infers reasoning that was not persisted).`);
        return store.close();
      }
      if (d && (!mut || d.seq > mut.seq)) {
        out(`Decision   ${d.decisionId} · "${d.question}"`);
        out(`Proposer   ${d.proposerId} · policy ${d.outcome!.policy} · confidence ${d.outcome!.confidence.toFixed(2)}`);
        out(`Evidence   ${d.evidence.length ? d.evidence.map((id) => `${id} (${s.artifacts[id]?.kind ?? '?'} by ${s.artifacts[id]?.authorId ?? '?'})`).join(', ') : 'none recorded'}`);
        out(`Participants ${d.participants.join(', ')}`);
        for (const v of d.votes) out(`  ${v.agentId}: ${v.option} — "${v.rationale}"`);
        out(`Opposed    ${d.outcome!.opposition.join(', ') || 'nobody'}`);
        out(`Result     ${d.outcome!.chosen} · ${d.outcome!.rationale}`);
        const t = d.taskId ? s.tasks[d.taskId] : null;
        if (t?.evaluation) out(`Task       ${t.title}: ${t.evaluation.evaluator} ${t.evaluation.passed}/${t.evaluation.total} · reward ${t.reward?.total.toFixed(2) ?? 'n/a'}`);
      } else {
        const p = mut!.proposalId ? s.evolution.proposals[mut!.proposalId] : null;
        out(`Organization change (${mut!.kind}) at generation ${mut!.generation}: ${mut!.detail}`);
        if (p) {
          out(`Proposer   ${p.proposal.proposer} · hypothesis: ${p.proposal.hypothesis}`);
          out(`Evidence   ${JSON.stringify(p.proposal.evidence)}`);
          if (p.validation) out(`Validation ${p.validation.method}: current ${p.validation.incumbentScore?.toFixed(3) ?? 'n/a'} vs candidate ${p.validation.candidateScore?.toFixed(3) ?? 'n/a'} (δ ${p.validation.margin}) on ${p.validation.bufferTaskIds.length} tasks`);
          if (p.rejectionReason) out(`Rejected   ${p.rejectionReason}`);
        }
      }
      return store.close();
    }
    case 'replay': {
      const store = openStore();
      const runId = latestRun(store, flags.run);
      const s = reduceEvents(store.events(runId));
      for (const t of s.timeline) out(`#${String(t.seq).padStart(4)} ${t.timestamp.slice(11, 19)} ${t.label}`);
      return store.close();
    }
    case 'export': {
      const store = openStore();
      const runId = latestRun(store, flags.run);
      const path = typeof flags.out === 'string' ? flags.out : join(wsDir(), 'exports', `${runId}.orgworld-run.zip`);
      const r = exportRun(store, runId, path, { 'metrics.json': runMetrics(store.events(runId)) });
      out(`exported ${r.eventCount} events → ${r.path}`);
      return store.close();
    }
    case 'experiment': {
      const config = readExperimentConfig(pos[0] ?? fail('experiment <config.yaml|json> [--stop-at HH:MM|ISO]'));
      const stopAt = typeof flags['stop-at'] === 'string' ? parseStopAt(flags['stop-at']) : undefined;
      const store = openStore();
      const model = ModelConfig.parse(config?.controls?.model ?? {});
      providerFor(model, flags); // spend guard before anything runs
      // One process per experiment: two would interleave runs in the same slots.
      const lockKey = `experiment-lock:${experimentIdOf(config)}`;
      const held = store.getKv<{ pid: number; at: string } | null>(lockKey);
      if (held && held.pid !== process.pid && pidAlive(held.pid)) fail(`this experiment is already running (pid ${held.pid}, since ${held.at})`);
      store.setKv(lockKey, { pid: process.pid, at: new Date().toISOString() });
      if (stopAt !== undefined) out(`time window closes ${new Date(stopAt).toString()}`);
      const res = await runExperiment({ store, config, provider: () => createProvider(model, { allowPaid: flags['allow-paid'] === true }), log: out, ...(stopAt !== undefined ? { stopAt } : {}) }).finally(() => store.setKv(lockKey, null));
      const csv = join(wsDir(), 'experiments', `${res.experimentId}.csv`);
      writeFileSync(csv, resultsCsv(res));
      for (const c of res.conditions) out(`${c.conditionId.padEnd(14)} CR ${c.cumulativeReward.mean.toFixed(2)} ± ${(c.cumulativeReward.hi - c.cumulativeReward.mean || 0).toFixed(2)} · SR ${c.successRate.mean.toFixed(2)} · tokens ${Math.round(c.lifetimeTokens.mean).toLocaleString()}`);
      for (const n of res.notes) out(`note: ${n}`);
      out(`status: ${res.status}`);
      out(`results → ${csv}`);
      return store.close();
    }
    case 'readings': {
      const config = readExperimentConfig(pos[0] ?? fail('readings <config.yaml|json> [--out file.json] [--csv file.csv]'));
      const store = openStore();
      const r = experimentReadings(store, config);
      if (typeof flags.csv === 'string') writeFileSync(flags.csv, readingsCsv(store, config));
      const json = JSON.stringify(r, null, 2) + '\n';
      if (typeof flags.out === 'string') {
        writeFileSync(flags.out, json);
        out(`${r.name}: ${r.completed}/${r.planned} runs complete → ${flags.out}`);
      } else process.stdout.write(json);
      return store.close();
    }
    case 'serve':
    case 'watch': {
      const store = openStore();
      const srv = await ensureServer(store, loadConfig());
      out(`OrgWorld web world: ${srv.url}`);
      if (!srv.close) return store.close();
      return; // keep process alive
    }
    case 'pause':
    case 'resume':
    case 'stop': {
      const store = openStore();
      const runId = latestRun(store, flags.run);
      const s = store.runState(runId);
      if (s.config?.mode === 'experiment' && cmd === 'stop') store.append(runId, { type: 'CONTAMINATION_RECORDED', actorId: 'user', payload: { source: 'cli', action: 'stop', detail: 'stopped by user during an experiment' } });
      store.setKv(`control:${runId}`, { action: cmd, at: new Date().toISOString() });
      out(`${cmd} requested for ${runId}`);
      return store.close();
    }
    case 'doctor': {
      const ok = (b: boolean, m: string) => out(`${b ? '✓' : '✗'} ${m}`);
      const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
      ok(maj > 22 || (maj === 22 && min >= 13), `node ${process.versions.node} (need ≥ 22.13 for node:sqlite)`);
      ok(existsSync(wsDir()), `workspace ${wsDir()}`);
      if (existsSync(wsDir())) {
        try {
          const st = EventStore.open(join(wsDir(), 'orgworld.db'));
          ok(true, `database schema v${st.schemaVersion()} · ${st.countEvents()} events · ${st.listRuns().length} runs`);
          st.close();
        } catch (e) {
          ok(false, `database: ${String(e)}`);
        }
      }
      ok(!!webRoot(), `web bundle ${webRoot() ?? 'missing (run pnpm build)'}`);
      const cfg = loadConfig();
      try {
        const r = await fetch(`${process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'}/api/tags`, { signal: AbortSignal.timeout(1500) });
        const tags = ((await r.json()) as { models?: Array<{ name: string }> }).models?.map((m) => m.name) ?? [];
        ok(tags.length > 0, `ollama reachable · models: ${tags.join(', ') || 'none — run \`ollama pull ${cfg.model.model}\`'}`);
      } catch {
        ok(false, 'ollama not reachable (free local cognition) — start it with `ollama serve`');
      }
      const bin = resolveClaudeBin();
      out(`· claude CLI ${bin === 'claude' ? 'not located' : 'found'} — paid, disabled unless --allow-paid`);
      out(`· configured cognition ${cfg.model.provider}/${cfg.model.model}${isPaidProvider(cfg.model.provider) ? ' (PAID)' : ' (free)'}`);
      return;
    }
    default:
      fail(`unknown command "${cmd}"\n${HELP}`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
