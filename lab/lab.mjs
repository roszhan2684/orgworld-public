#!/usr/bin/env node
// Helpers for lab/daily.sh: time window, Ollama checks, environment lock, notebook pages. No dependencies.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
const readJson = (p, d = null) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const minutes = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm ?? '');
  if (!m) throw new Error(`expected HH:MM, got "${hm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
};
const nextAt = (hm, from) => {
  const d = new Date(from);
  d.setHours(Math.floor(minutes(hm) / 60), minutes(hm) % 60, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 1);
  return d;
};
const hhmm = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '—');
const dur = (sec) => (sec == null ? '—' : sec < 60 ? `${Math.round(sec)} s` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`);
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const int = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-US'));
const table = (head, rows) => [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');

async function ollamaInfo(model, out) {
  const host = process.env.OLLAMA_HOST?.startsWith('http') ? process.env.OLLAMA_HOST : 'http://127.0.0.1:11434';
  const call = async (path, body) => {
    const r = await fetch(host + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(900_000) } : { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  };
  const info = { host, model };
  try {
    info.version = (await call('/api/version')).version;
    const m = ((await call('/api/tags')).models ?? []).find((t) => t.name === model || t.model === model);
    if (!m) info.error = `model ${model} is not downloaded (run: ollama pull ${model})`;
    else {
      Object.assign(info, { digest: m.digest, sizeBytes: m.size, quantization: m.details?.quantization_level ?? null, parameters: m.details?.parameter_size ?? null });
      const g = await call('/api/generate', { model, prompt: 'Reply with the single word: ok', stream: false, options: { num_predict: 32, seed: 7, temperature: 0 } });
      info.warmup = {
        loadSeconds: (g.load_duration ?? 0) / 1e9,
        promptTokensPerSec: g.prompt_eval_count && g.prompt_eval_duration ? g.prompt_eval_count / (g.prompt_eval_duration / 1e9) : null,
        genTokensPerSec: g.eval_count && g.eval_duration ? g.eval_count / (g.eval_duration / 1e9) : null,
      };
      const loaded = ((await call('/api/ps')).models ?? []).find((p) => p.name === model || p.model === model);
      info.gpuFraction = loaded?.size ? (loaded.size_vram ?? 0) / loaded.size : 0;
      info.contextLength = loaded?.context_length ?? null; // tokens; longer prompts are truncated by Ollama
    }
  } catch (e) {
    info.error = `Ollama is not reachable at ${host}: ${e.message}`;
  }
  writeJson(out, info);
}

/** Fields that define the experiment's environment. A blocking change stops the experiment; others are deviations. */
const BLOCKING = ['bundleSha256', 'model', 'modelDigest'];
const RECORDED = ['ollamaVersion', 'contextLength', 'nodeVersion', 'macos', 'machine'];

function provenance(statePath, curPath, date, accept) {
  const cur = readJson(curPath);
  const st = readJson(statePath);
  if (!st) {
    writeJson(statePath, { ...cur, firstSession: date, history: [] });
    return { status: 'new', changes: [] };
  }
  const changes = [...BLOCKING, ...RECORDED].filter((k) => st[k] !== cur[k]).map((k) => ({ field: k, from: st[k] ?? null, to: cur[k] ?? null, blocking: BLOCKING.includes(k) }));
  if (!changes.length) return { status: 'same', changes };
  if (changes.some((c) => c.blocking) && !accept) return { status: 'blocked', changes };
  for (const c of changes) st[c.field] = c.to;
  st.history.push(...changes.map((c) => ({ date, ...c, ...(c.blocking ? { acceptedByResearcher: true } : {}) })));
  writeJson(statePath, st);
  return { status: 'deviation', changes };
}

const OUTCOME = {
  ran: 'ran',
  skipped: 'skipped',
  blocked: 'blocked',
  'queue-finished': 'queue finished',
};

function render(dir, nb) {
  const s = readJson(join(dir, 'session.json'), {});
  const before = readJson(join(dir, 'before.json'));
  const after = readJson(join(dir, 'after.json')) ?? before;
  const ol = readJson(join(dir, 'ollama.json'));
  const env = readJson(join(dir, 'env.json'));
  const prov = readJson(join(dir, 'prov.json'));
  const frozen = readJson(join(dir, 'frozen.json'), {});
  const repo = s.repoUrl ?? '';
  mkdirSync(join(nb, 'sessions'), { recursive: true });
  let file = `sessions/${s.date}.md`;
  for (let i = 2; existsSync(join(nb, file)); i++) file = `sessions/${s.date}-${i}.md`;

  const prevDone = new Set((before?.slots ?? []).filter((x) => !x.pending).map((x) => x.runId));
  const newRuns = (after?.slots ?? []).filter((x) => !x.pending && !prevDone.has(x.runId));
  const prevExcl = new Set((before?.slots ?? []).flatMap((x) => x.excluded.map((e) => e.runId)));
  const newExcluded = (after?.slots ?? []).flatMap((x) => x.excluded.filter((e) => !prevExcl.has(e.runId)).map((e) => ({ ...e, slot: x.slot })));
  const elapsed = s.startedAt && s.endedAt ? (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000 : null;
  const L = [];
  L.push(`# Lab session ${s.date}${file.endsWith(`${s.date}.md`) ? '' : ` (${/-(\d+)\.md$/.exec(file)?.[1]})`}`, '');
  const headline =
    s.outcome === 'ran'
      ? `**Outcome: ran.** ${after.name}: ${newRuns.length} new run${newRuns.length === 1 ? '' : 's'} counted, ${after.completed}/${after.planned} complete.`
      : `**Outcome: ${OUTCOME[s.outcome] ?? s.outcome}.** ${s.reason ?? ''}`;
  L.push(headline, '');
  if (s.outcome === 'ran') L.push(`Stopped because: ${s.stopReason ?? '—'}. Cost: $${num(s.usd ?? 0, 4)} (free local model; paid providers are refused).`, '');
  const rows = [
    ['Session', `${hhmm(s.startedAt)} → ${hhmm(s.endedAt)} (${dur(elapsed)}); window ${s.window ?? '—'}`],
    ['Code', frozen.commit ? `OrgWorld [\`${frozen.commit.slice(0, 7)}\`](${repo}/tree/${frozen.commit}) · bundle sha256 \`${(frozen.bundleSha256 ?? '').slice(0, 16)}…\`` : '—'],
  ];
  if (after) rows.push(['Experiment', `${after.name} · \`${after.experimentId}\` · config hash \`${after.configHash.slice(0, 16)}…\` · [config](${repo}/blob/${frozen.commit ?? 'main'}/${s.config}) · locked ${after.lockedAt ?? 'not yet'}`]);
  if (ol && !ol.error) rows.push(['Model', `${ol.model} · digest \`${(ol.digest ?? '').slice(0, 16)}…\` · ${ol.parameters ?? ''} ${ol.quantization ?? ''} · Ollama ${ol.version} · context ${ol.contextLength ?? '?'} tokens · GPU offload ${Math.round((ol.gpuFraction ?? 0) * 100)}% · warm-up ${num(ol.warmup?.genTokensPerSec, 1)} tok/s generation, ${num(ol.warmup?.promptTokensPerSec, 1)} tok/s prompt`]);
  else if (ol?.error) rows.push(['Model', ol.error]);
  if (env) rows.push(['Machine', `${env.machine} · macOS ${env.macos} · Node ${env.nodeVersion} · ${s.power ?? ''}${s.freeDiskGB != null ? ` · ${s.freeDiskGB} GB free disk` : ''}`]);
  if (s.outcome === 'ran') rows.push(['Model-service retries', String(s.retries ?? 0)], ['Prompts truncated by Ollama', String(s.truncatedPrompts ?? '—')]);
  L.push(table(['', ''], rows), '');

  if (after && s.outcome !== 'skipped') {
    L.push('## Runs', '');
    L.push(
      table(
        ['Slot', 'Condition', 'Rep', 'Status', 'Tasks', 'Success', 'Cum. reward', 'Tokens', 'Calls', 'Failed calls', 'Agent failures', 'Mutations (acc/rej)', 'Wall', 'Per task', 'New'],
        after.slots.map((x) => [
          `\`${x.runId.replace(after.experimentId + '-', '')}\``,
          x.conditionId,
          x.repetition,
          x.pending ? 'pending' : x.status,
          x.tasks ?? '—',
          num(x.successRate),
          num(x.cumulativeReward),
          int(x.tokens),
          int(x.modelCalls),
          x.modelCallFailures ?? '—',
          x.agentFailures ?? '—',
          x.pending ? '—' : `${x.mutationsAccepted}/${x.mutationsRejected}`,
          dur(x.wallSeconds),
          x.tasks ? dur(x.wallSeconds / x.tasks) : '—',
          newRuns.some((n) => n.runId === x.runId) ? '✓' : '',
        ]),
      ),
      '',
    );
    const excl = after.slots.flatMap((x) => x.excluded.map((e) => ({ ...e, slot: x.slot })));
    if (excl.length) {
      L.push('**Excluded attempts** (kept in the store, not counted, slot re-run from the start; C-19):', '');
      for (const e of excl) L.push(`- \`${e.runId}\`: ${e.reason}; ${e.tasks} task(s), ${dur(e.wallSeconds)}${newExcluded.some((n) => n.runId === e.runId) ? ' **(this session)**' : ''}`);
      L.push('');
    }
    L.push(`Validation shadow runs so far: ${after.shadowRuns}.`, '');
    const counted = after.conditions.filter((c) => c.runs.length);
    if (counted.length) {
      L.push('## Interim aggregates (not results)', '');
      L.push(`Over the ${after.completed} of ${after.planned} planned runs completed so far. The pre-registered analysis is run once, on all of them.${after.scripted ? ' **SCRIPTED provider: pipeline test only.**' : ''}`, '');
      const ci = (c) => `${num(c.mean)} [${num(c.lo)}, ${num(c.hi)}]`;
      L.push(table(['Condition', 'Runs', 'Cum. reward (95% CI)', 'Success rate (95% CI)', 'Lifetime tokens (mean)'], counted.map((c) => [c.conditionId, c.runs.length, ci(c.cumulativeReward), ci(c.successRate), int(c.lifetimeTokens.mean)])), '');
      if (after.comparisons.length) L.push(table(['Comparison', 'Metric', 'n', 'Mean diff', '95% CI'], after.comparisons.map((c) => [`${c.a} − ${c.b}`, c.metric, c.n, num(c.meanDiff), `[${num(c.lo)}, ${num(c.hi)}]`])), '');
    }
  }

  const notes = [...(s.notes ?? [])];
  const devs = [];
  if (prov?.status === 'deviation') for (const c of prov.changes) devs.push(`${c.field} changed: \`${c.from}\` → \`${c.to}\`${c.blocking ? ' (accepted by the researcher)' : ''}`);
  if (prov?.status === 'blocked') for (const c of prov.changes) devs.push(`${c.blocking ? '**Blocking**' : 'Recorded'}: ${c.field} changed \`${c.from}\` → \`${c.to}\``);
  if (s.truncatedPrompts > 0) devs.push(`Ollama truncated ${s.truncatedPrompts} prompt(s) to its ${ol?.contextLength ?? '?'}-token context: those agents did not see their whole prompt.`);
  if (s.hardStopped) devs.push('The hard stop ended the session mid-run; that run is kept, excluded and re-run from the start next session.');
  for (const u of s.unpublished ?? []) devs.push(`Run export \`${u.file}\` not published: ${u.reason}. It stays on the lab machine.`);
  if (notes.length) L.push('## Notes from the runner', '', ...notes.map((n) => `- ${n}`), '');
  if (devs.length) L.push('## Deviations and anomalies', '', ...devs.map((d) => `- ${d}`), '');
  if (after && s.outcome !== 'skipped') {
    const d = `../data/${after.name}`;
    L.push('## Data', '', `[readings.json](${d}/readings.json) · [results.csv](${d}/results.csv) · [provenance.json](${d}/provenance.json) · [run exports](${d}/runs/)${(s.exported ?? []).length ? ` (${s.exported.length} new this session)` : ''}`, '');
  }
  writeFileSync(join(nb, file), L.join('\n'));

  if (after && s.outcome !== 'skipped') {
    const d = join(nb, 'data', after.name);
    mkdirSync(d, { recursive: true });
    writeJson(join(d, 'readings.json'), after);
    if (s.provenanceFile && existsSync(s.provenanceFile)) copyFileSync(s.provenanceFile, join(d, 'provenance.json'));
  }
  appendFileSync(
    join(nb, 'sessions.jsonl'),
    JSON.stringify({ date: s.date, file, startedAt: s.startedAt, endedAt: s.endedAt, outcome: s.outcome, reason: s.reason ?? null, stopReason: s.stopReason ?? null, experiment: after?.name ?? null, experimentId: after?.experimentId ?? null, newRuns: newRuns.length, completed: after?.completed ?? null, planned: after?.planned ?? null, retries: s.retries ?? null, hardStopped: !!s.hardStopped }) + '\n',
  );
  index(nb, repo, frozen);
  console.log(file);
}

function index(nb, repo, frozen) {
  const log = join(nb, 'sessions.jsonl');
  const sessions = (existsSync(log) ? readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse();
  const exps = existsSync(join(nb, 'data')) ? readdirSync(join(nb, 'data')).map((n) => readJson(join(nb, 'data', n, 'readings.json'))).filter(Boolean) : [];
  const L = [
    '# OrgWorld lab notebook',
    '',
    `Automated nightly research sessions for [OrgWorld](${repo}), written by [\`lab/daily.sh\`](${repo}/blob/main/lab/README.md) on the researcher's machine with a free local model (no paid model calls). Every session is recorded, including skipped, blocked and cut-short ones. Runs that were cut short or hit model-service failures stay in the data but are excluded from aggregates (C-19).`,
    '',
    '## Experiments',
    '',
    exps.length ? table(['Experiment', 'ID', 'Progress', 'Locked'], exps.map((e) => [e.name, `\`${e.experimentId}\``, `${e.completed}/${e.planned} runs${e.done ? ' ✓ complete' : ''}`, e.lockedAt ?? 'not yet'])) : '_No experiment has started yet._',
    '',
    '## Sessions',
    '',
    sessions.length ? table(['Date', 'Outcome', 'Experiment', 'New runs', 'Progress', 'Why it stopped'], sessions.map((x) => [`[${x.date}](${x.file})`, OUTCOME[x.outcome] ?? x.outcome, x.experiment ?? '—', x.outcome === 'ran' ? x.newRuns : '—', x.planned ? `${x.completed}/${x.planned}` : '—', x.stopReason ?? x.reason ?? '—'])) : '_No session yet._',
    '',
    '## Reading the data',
    '',
    '- `data/<experiment>/readings.json`: every condition × repetition slot, with its counted run, excluded attempts and metrics. Interim aggregates are not results.',
    '- `data/<experiment>/results.csv`: one row per counted run (same columns as `orgworld experiment`).',
    '- `data/<experiment>/runs/*.orgworld-run.zip`: the full event log of every run, including excluded ones and validation shadows. Replay one with `orgworld replay`, or read `events.jsonl`.',
    '- `data/<experiment>/provenance.json`: the code bundle, model weights digest and runtime that the experiment is locked to, with every recorded change.',
    '- `sessions.jsonl`: one line per session.',
    '',
    frozen.commit ? `Code for current sessions: [\`${frozen.commit.slice(0, 7)}\`](${repo}/tree/${frozen.commit}).` : '',
    '',
  ];
  writeFileSync(join(nb, 'README.md'), L.join('\n'));
}

switch (cmd) {
  case 'window': {
    // window START STOP HARD → shell assignments for daily.sh
    const [start, stop, hard] = args;
    const now = new Date();
    const n = now.getHours() * 60 + now.getMinutes();
    const s = minutes(start);
    const e = minutes(stop);
    const inWindow = s <= e ? n >= s && n < e : n >= s || n < e;
    console.log(`IN_WINDOW=${inWindow ? 1 : 0}`);
    console.log(`SECS_TO_HARD=${Math.max(0, Math.round((nextAt(hard, now) - now) / 1000))}`);
    break;
  }
  case 'ollama':
    await ollamaInfo(args[0], args[1]);
    break;
  case 'get': {
    // get FILE key[.key…] → value (empty if missing)
    let v = readJson(args[0], {});
    for (const k of args[1].split('.')) v = v?.[k];
    console.log(v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    break;
  }
  case 'set': {
    // set FILE key value [json]
    const o = readJson(args[0], {});
    o[args[1]] = args[3] === 'json' ? JSON.parse(args[2]) : args[2];
    writeJson(args[0], o);
    break;
  }
  case 'push': {
    // push FILE key value → append to an array field
    const o = readJson(args[0], {});
    (o[args[1]] ??= []).push(args[3] === 'json' ? JSON.parse(args[2]) : args[2]);
    writeJson(args[0], o);
    break;
  }
  case 'provenance':
    console.log(JSON.stringify(provenance(args[0], args[1], args[2], process.env.ACCEPT_ENV_CHANGE === '1')));
    break;
  case 'render':
    render(args[0], args[1]);
    break;
  case 'index':
    index(args[0], args[1] ?? '', {});
    break;
  default:
    console.error('usage: lab.mjs window|ollama|get|set|push|provenance|render|index …');
    process.exit(2);
}
