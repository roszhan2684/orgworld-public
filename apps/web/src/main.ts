import type { OrgEvent } from '@orgworld/protocol';
import { agentKnowledge, applyEvent, hashString, initialWorldState, reduceEvents, ROOM_LABELS, type RoomId, type WorldState } from '@orgworld/core';
import { World3D, type AgentDraw } from './world3d.ts';
import NumberFlowModule from 'number-flow';

// NumberFlow (open source, framework-free web component) for animated live counters.
const NumberFlowEl = ((NumberFlowModule as unknown as { default?: CustomElementConstructor }).default ?? NumberFlowModule) as unknown as CustomElementConstructor;
if (!customElements.get('number-flow')) customElements.define('number-flow', NumberFlowEl);
type NumberFlow = HTMLElement & { update(v: number): void };

/*
 * OrgWorld web world. INVARIANT: everything drawn comes from recorded events reduced by @orgworld/core —
 * the same reducer the runtime and server use. No timers create activity; characters move only when the
 * reduced state changes (each move carries the sequence number of the event that caused it).
 */

const API = new URLSearchParams(location.search).get('api') ?? location.origin;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- layout (logical 960×540) ---------- */
const RW = 176, RH = 205, GAP = 16, X0 = 8, CORR_Y = 270;
type Room = { id: RoomId; x: number; y: number; w: number; h: number; top: boolean };
const ROOMS = {} as Record<RoomId, Room>;
(['command', 'research', 'strategy', 'engineering', 'experiment'] as RoomId[]).forEach((id, i) => (ROOMS[id] = { id, x: X0 + i * (RW + GAP), y: 14, w: RW, h: RH, top: true }));
(['critique', 'decision', 'library', 'analysis', 'meeting'] as RoomId[]).forEach((id, i) => (ROOMS[id] = { id, x: X0 + i * (RW + GAP), y: 321, w: RW, h: RH, top: false }));
const FLOOR: Record<RoomId, string> = { command: '#3a3428', research: '#263a44', strategy: '#2f2b43', engineering: '#3a2d29', experiment: '#24392f', critique: '#3d2a2c', decision: '#33312a', library: '#382f22', analysis: '#2c3524', meeting: '#2a3140' };
const door = (r: Room) => ({ x: r.x + r.w / 2, y: r.top ? r.y + r.h : r.y });
/** Residents stand in the front yard of their cottage (3 per row, 2 rows; overflow stacks behind). */
const slot = (room: RoomId, idx: number) => {
  const r = ROOMS[room];
  const col = (idx % 3) - 1, row = Math.floor(idx / 3) % 2, layer = Math.floor(idx / 6);
  return { x: r.x + r.w / 2 + col * 40 + layer * 12, y: (r.top ? r.y + 112 : r.y + 44) + row * 34 };
};
const colorOf = (roleId: string) => `hsl(${parseInt(hashString(roleId).slice(0, 6), 16) % 360}, 55%, 62%)`;
const codeOf = (name: string) => name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();

/* ---------- data ---------- */
let runId: string | null = null;
let events: OrgEvent[] = [];
let live: WorldState = initialWorldState();
let viewSeq: number | null = null; // null = live
let state: WorldState = live;
let selected: string | null = null;
let viewAs = false;
let inspTab = 'overview';
let playing = false, speed = 1, acc = 0;
let ws: WebSocket | null = null;
type Char = { x: number; y: number; path: Array<{ x: number; y: number }>; key: string; bubble: { text: string; kind: string; startedAt: number; seq: number; until: number } | null; phase: number };
const chars: Record<string, Char> = {};

async function api<T>(p: string): Promise<T> {
  const r = await fetch(`${API}/api/v1${p}`);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return (await r.json()) as T;
}

async function loadRuns() {
  const runs = (await api<Array<{ runId: string; status: string; label: string | null; condition: string }>>('/runs')).filter((r) => !r.runId.includes('-val') && r.runId !== 'workspace_tool_log');
  const sel = $<HTMLSelectElement>('runSelect');
  sel.innerHTML = runs.map((r) => `<option value="${esc(r.runId)}">${esc((r.label ?? r.runId).slice(0, 48))} · ${esc(r.status)}</option>`).join('');
  const want = decodeURIComponent(location.hash.slice(1));
  follow = want === '' || want === 'latest';
  const pick = runs.find((r) => r.runId === want)?.runId ?? runs[0]?.runId ?? null;
  if (!pick) {
    $('view-world').querySelector('.pane')!.insertAdjacentHTML('afterbegin', `<div class="empty">No runs yet. Start one from your repository: <code>orgworld run --task impl-rle#0</code> or in Claude Code <code>/orgworld:run</code>. This page shows only recorded events, so it stays empty until something real happens.</div>`);
    $('liveTxt').textContent = 'waiting for runs';
    return;
  }
  sel.value = pick;
  await openRun(pick);
}

/** Follow mode (#latest): switch to the newest run as it is created (e.g. while an experiment moves between conditions). */
let follow = false;
setInterval(async () => {
  if (!follow) return;
  try {
    const runs = (await api<Array<{ runId: string }>>('/runs')).filter((r) => !r.runId.includes('-val') && r.runId !== 'workspace_tool_log');
    if (runs[0] && runs[0].runId !== runId) {
      await loadRunsInto(runs);
      await openRun(runs[0].runId);
    }
  } catch {
    /* runtime not reachable; keep current view */
  }
}, 4000);
async function loadRunsInto(runs: Array<{ runId: string }>) {
  const sel = $<HTMLSelectElement>('runSelect');
  if (![...sel.options].some((o) => o.value === runs[0]!.runId)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(runs[0]!.runId)}">${esc(runs[0]!.runId)}</option>`);
  sel.value = runs[0]!.runId;
}

async function openRun(id: string) {
  runId = id;
  history.replaceState(null, '', follow ? '#latest' : `#${encodeURIComponent(id)}`);
  ws?.close();
  events = [];
  live = initialWorldState();
  for (const k of Object.keys(chars)) delete chars[k];
  let after = 0;
  for (;;) {
    const batch = await api<OrgEvent[]>(`/runs/${encodeURIComponent(id)}/events?after=${after}&limit=5000`);
    for (const e of batch) (events.push(e), applyEvent(live, e));
    if (batch.length < 5000) break;
    after = batch[batch.length - 1]!.sequence;
  }
  viewSeq = null;
  setState(live, true);
  connect();
}

function connect() {
  if (!runId) return;
  const url = `${API.replace(/^http/, 'ws')}/api/v1/stream?runId=${encodeURIComponent(runId)}&after=${live.lastSequence}`;
  ws = new WebSocket(url);
  ws.onopen = () => ($('liveTxt').textContent = 'live · events stream from the local runtime');
  ws.onclose = () => ($('liveTxt').textContent = 'disconnected — retrying');
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as { type: string; events?: OrgEvent[] };
    if (!msg.events?.length) return;
    for (const e of msg.events) {
      if (e.runId !== runId || e.sequence <= live.lastSequence) continue;
      events.push(e);
      applyEvent(live, e);
      if (viewSeq === null) onNewEvent(e);
    }
    if (viewSeq === null) setState(live, false);
    else renderPanels();
  };
  ws.onerror = () => ws?.close();
  ws.addEventListener('close', () => setTimeout(() => runId && ws?.readyState === WebSocket.CLOSED && connect(), 2000));
}

/** Speech bubbles carry only text from real recorded events. */
function say(agentId: string, kind: string, text: string, seq: number) {
  const c = chars[agentId];
  if (!c || !text) return;
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 220) + (text.length > 220 ? '…' : '');
  const now = performance.now();
  c.bubble = { text: t, kind, startedAt: now, seq, until: now + (3500 + t.length * 45) / speed };
}
function onNewEvent(e: OrgEvent) {
  if (e.type === 'MESSAGE_SENT') say(e.payload.from, e.payload.meetingId ? 'MEETING' : e.payload.kind, e.payload.content, e.sequence);
  else if (e.type === 'VOTE_CAST') say(e.payload.agentId, 'VOTE', `I vote ${e.payload.option}: ${e.payload.rationale}`, e.sequence);
  else if (e.type === 'ARTIFACT_CREATED' && (e.payload.kind === 'review' || e.payload.kind === 'risk_report')) say(e.payload.authorId, 'REVIEW', e.payload.content, e.sequence);
  else if (e.type === 'ARTIFACT_CREATED' && (e.payload.kind === 'code' || e.payload.kind === 'tests')) say(e.payload.authorId, 'WORK', `Wrote ${e.payload.kind}: ${e.payload.title}`, e.sequence);
  else if (e.type === 'EXPERIMENT_COMPLETED') say(e.payload.agentId, 'CHECKS', `Public checks: ${e.payload.passed}/${e.payload.total} passed${e.payload.timedOut ? ' (timed out)' : ''}`, e.sequence);
  else if (e.type === 'DECISION_COMPLETED') {
    const d = state.decisions[e.payload.decisionId] ?? live.decisions[e.payload.decisionId];
    if (d) say(d.proposerId, 'DECISION', `Decided: ${e.payload.chosen} (${e.payload.rationale})`, e.sequence);
  }
}

function setState(s: WorldState, teleport: boolean) {
  state = s;
  syncChars(teleport || reduceMotion || speed >= 10);
  renderPanels();
}

function stateAt(seq: number): WorldState {
  return reduceEvents(events, seq);
}

/* ---------- characters follow reduced state ---------- */
function roomAt(x: number, y: number) {
  return Object.values(ROOMS).find((r) => x >= r.x && x <= r.x + r.w && y >= r.y - 2 && y <= r.y + r.h + 2);
}
function syncChars(teleport: boolean) {
  const present = state.agentOrder.filter((id) => !state.agents[id]!.removed);
  for (const id of Object.keys(chars)) if (!present.includes(id)) delete chars[id];
  const occupancy: Record<string, string[]> = {};
  for (const id of present) {
    const a = state.agents[id]!;
    if (!a.targetAgentId) (occupancy[a.room] ??= []).push(id);
  }
  for (const id of present) {
    const a = state.agents[id]!;
    const key = `${a.room}|${a.targetAgentId ?? ''}|${a.activitySeq}`;
    let c = chars[id];
    const home = slot(a.room, Math.max(0, (occupancy[a.room] ?? []).indexOf(id)));
    if (!c) c = chars[id] = { x: home.x, y: home.y, path: [], key: '', bubble: null, phase: Math.random() * 6 };
    if (c.key === key && !teleport) continue;
    c.key = key;
    let dest = home;
    if (a.targetAgentId && state.agents[a.targetAgentId]) {
      const t = state.agents[a.targetAgentId]!;
      const ts = slot(t.room, Math.max(0, (occupancy[t.room] ?? []).indexOf(t.id)));
      dest = { x: ts.x + 22, y: ts.y + 4 };
    }
    if (teleport) {
      c.x = dest.x;
      c.y = dest.y;
      c.path = [];
      continue;
    }
    const from = roomAt(c.x, c.y), to = roomAt(dest.x, dest.y);
    c.path = !from || !to || from.id === to.id ? [dest] : [door(from), { x: door(from).x, y: CORR_Y }, { x: door(to).x, y: CORR_Y }, door(to), dest];
  }
}

/* ---------- 3D village (scenery is ambient; agents follow reduced state only) ---------- */
// Surface any failure on screen instead of leaving "connecting…" (build §59: do not hide failures).
window.addEventListener('error', (e) => ($('liveTxt').textContent = `error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => ($('liveTxt').textContent = `error: ${String((e as PromiseRejectionEvent).reason)}`));

/** Same interface as World3D, drawn in 2D — used when the browser cannot create a WebGL2 context. */
class Flat2D {
  private ctx: CanvasRenderingContext2D;
  constructor(private cv: HTMLCanvasElement) {
    cv.width = 960;
    cv.height = 540;
    this.ctx = cv.getContext('2d')!;
  }
  render(_t: number, agents: AgentDraw[], link: { from: string; to: string[] } | null) {
    const c = this.ctx;
    c.fillStyle = '#7bb04f';
    c.fillRect(0, 0, 960, 540);
    c.fillStyle = '#d9c08a';
    c.fillRect(0, 258, 960, 24);
    for (const r of Object.values(ROOMS)) {
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.fillRect(r.x, r.y, r.w, r.h);
      c.fillStyle = '#2a2f1e';
      c.font = '600 13px system-ui, sans-serif';
      c.fillText(ROOM_LABELS[r.id], r.x + 8, r.y + 18);
    }
    const at = new Map(agents.map((a) => [a.id, a]));
    if (link) for (const to of link.to) { const a = at.get(link.from), b = at.get(to); if (a && b) (c.strokeStyle = '#e3a63d', c.setLineDash([4, 4]), c.beginPath(), c.moveTo(a.x, a.y), c.lineTo(b.x, b.y), c.stroke(), c.setLineDash([])); }
    for (const a of agents) {
      c.fillStyle = a.color;
      c.beginPath();
      c.arc(a.x, a.y, 9, 0, Math.PI * 2);
      c.fill();
      if (a.selected) (c.strokeStyle = '#e3a63d', (c.lineWidth = 3), c.stroke(), (c.lineWidth = 1));
      c.fillStyle = '#1d2430';
      c.font = '11px system-ui, sans-serif';
      c.fillText(a.name, a.x - 18, a.y + 22);
      if (a.bubble) (c.fillStyle = '#fff', c.fillRect(a.x - 4, a.y - 32, 230, 18), (c.fillStyle = '#1d2430'), c.fillText(a.bubble.text.slice(0, 40), a.x + 2, a.y - 19));
    }
  }
  pick(x: number, y: number) {
    const r = this.cv.getBoundingClientRect();
    const lx = ((x - r.left) / r.width) * 960, ly = ((y - r.top) / r.height) * 540;
    return Object.entries(chars).find(([, ch]) => Math.hypot(ch.x - lx, ch.y - ly) < 14)?.[0] ?? null;
  }
  screenPos(id: string) {
    const ch = chars[id], r = this.cv.getBoundingClientRect();
    return ch ? { x: (ch.x / 960) * r.width, y: (ch.y / 540) * r.height } : null;
  }
}

let cv = $<HTMLCanvasElement>('world');
let world: Pick<World3D, 'render' | 'pick' | 'screenPos'> & { follow?: string | null };
try {
  world = new World3D(cv, Object.values(ROOMS), reduceMotion);
} catch (err) {
  const fresh = cv.cloneNode(false) as HTMLCanvasElement;
  cv.replaceWith(fresh);
  cv = fresh;
  world = new Flat2D(cv);
  $('banner').hidden = false;
  $('banner').textContent = `3D view unavailable in this browser (${err instanceof Error ? err.message : String(err)}). Showing the 2D map instead — same recorded events. To get 3D in Chrome: Settings → System → turn on "Use graphics acceleration when available", then relaunch.`;
}
function frame(t: number) {
  const v = (reduceMotion ? 9999 : 1.6) * Math.min(speed, 4);
  for (const c of Object.values(chars)) {
    const p = c.path[0];
    if (!p) continue;
    const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy);
    if (d <= v) ((c.x = p.x), (c.y = p.y), c.path.shift());
    else ((c.x += (dx / d) * v), (c.y += (dy / d) * v));
  }
  const now = performance.now();
  const draws: AgentDraw[] = Object.entries(chars).flatMap(([id, c]) => {
    const a = state.agents[id];
    return a ? [{ id, name: a.name, roleId: a.roleId, color: colorOf(a.roleId), status: a.status, x: c.x, y: c.y, moving: c.path.length > 0, selected: id === selected, bubble: c.bubble && now < c.bubble.until ? c.bubble : null }] : [];
  });
  const last = events[(viewSeq ?? live.lastSequence) - 1];
  world.render(t, draws, last?.type === 'MESSAGE_SENT' ? { from: last.payload.from, to: last.payload.to } : null);
  if (playing && viewSeq !== null) {
    acc += 16 * speed;
    if (acc >= 900) {
      acc = 0;
      if (viewSeq >= events.length) (playing = false), syncPlay();
      else step(viewSeq + 1);
    }
  }
  requestAnimationFrame(frame);
}
function step(seq: number) {
  viewSeq = Math.max(0, Math.min(events.length, seq));
  const e = events[viewSeq - 1];
  setState(stateAt(viewSeq), false);
  if (e) onNewEvent(e);
}
let downAt = { x: 0, y: 0 };
cv.addEventListener('pointerdown', (ev) => (downAt = { x: ev.clientX, y: ev.clientY }));
cv.addEventListener('click', (ev) => {
  if (Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return; // camera drag, not a click
  const id = world.pick(ev.clientX, ev.clientY);
  if (id) ((selected = id), renderPanels());
});

/* ---------- panels ---------- */
let lastPanel = 0;
function renderPanels() {
  const now = performance.now();
  if (now - lastPanel < 100) return void requestAnimationFrame(() => renderPanels());
  lastPanel = now;
  const s = state;
  const cfg = s.config;
  const scripted = cfg?.model.provider === 'scripted';
  const fallback = $('banner').textContent?.startsWith('3D view unavailable');
  if (!fallback) $('banner').hidden = !scripted && !s.contaminated;
  if (!fallback) $('banner').textContent = scripted ? 'SCRIPTED provider — this run tested runtime mechanics with deterministic responses. It is not real cognition and not a research result.' : 'This run is marked CONTAMINATED (user interference during an experiment); it is excluded from experiment aggregates.';
  $('chips').innerHTML = cfg
    ? [`<span class="chip amber">${esc(cfg.mode.toUpperCase())}</span>`, `<span class="chip">${esc(s.genome?.name ?? '')} · gen ${s.evolution.generation}</span>`, `<span class="chip ${cfg.model.provider === 'ollama' ? 'green' : scripted ? '' : 'red'}">${esc(cfg.model.provider)} · ${esc(cfg.model.model)}</span>`, `<span class="chip">${esc(cfg.condition)}</span>`].join('')
    : '';
  ($('nfTokens') as NumberFlow).update(s.costs.total.tokens);
  ($('nfCalls') as NumberFlow).update(s.costs.total.calls);
  ($('nfEvents') as NumberFlow).update(s.eventCount);
  $('usdTxt').textContent = `$${s.costs.total.usd.toFixed(4)}`;
  const task = s.activeTaskId ? s.tasks[s.activeTaskId] : s.tasks[s.taskOrder[s.taskOrder.length - 1] ?? ''];
  $('taskTitle').textContent = task?.title ?? 'No task yet';
  const st = $('taskStatus');
  st.textContent = task ? `${task.status}${task.score !== null ? ` · ${task.score.toFixed(2)}` : ''}` : '';
  st.className = 'pill' + (task?.status === 'COMPLETED' ? ' ok' : task?.status === 'FAILED' ? ' bad' : '');
  renderMission(task ?? null);
  const lastT = s.timeline[s.timeline.length - 1];
  $('activityTxt').textContent = lastT ? lastT.label.slice(0, 120) : '';
  const scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(events.length);
  scrub.value = String(viewSeq ?? live.lastSequence);
  $('seqTxt').textContent = `event ${viewSeq ?? live.lastSequence} / ${events.length}${viewSeq === null ? ' · live' : ' · replay'}`;
  $('liveBtn').setAttribute('aria-pressed', String(viewSeq === null));
  renderMarks();
  renderInspector();
  renderFeed();
  if ($('view-network').classList.contains('active')) renderNetwork();
  if ($('view-evolution').classList.contains('active')) renderEvolution();
}

function renderMission(task: WorldState['tasks'][string] | null) {
  const el = $('mission');
  if (!task) return void (el.hidden = true);
  el.hidden = false;
  const turns = Object.values(state.modelCallsInFlight).length;
  const working = state.agentOrder.map((id) => state.agents[id]!).filter((a) => a.currentTaskId === task.id && !a.removed);
  const done = state.taskOrder.filter((id) => ['COMPLETED', 'FAILED'].includes(state.tasks[id]!.status));
  $('missionMeta').textContent = `${task.category ?? 'objective'}${task.phaseId ? ` · phase ${task.phaseId}` : ''}${task.taskIndex !== null ? ` · task ${task.taskIndex + 1}` : ''} · ${task.calls} model calls${turns ? ' · thinking now' : ''} · ${done.length} done (${done.filter((id) => state.tasks[id]!.success).length} passed)`;
  $('missionText').textContent = task.objective;
  $('missionWho').textContent = working.length ? working.map((a) => `${a.name}: ${a.activity}`).join(' · ') : 'no agent assigned yet';
}

function renderMarks() {
  const n = Math.max(1, events.length);
  const color = (t: string) => (t === 'MESSAGE_SENT' ? 'var(--sim)' : t.startsWith('DECISION') ? 'var(--accent)' : t.startsWith('MEETING') ? '#b48ae8' : t === 'EXPERIMENT_COMPLETED' || t === 'EVALUATION_COMPLETED' ? 'var(--good)' : t.startsWith('ORGANIZATION_') || t.startsWith('MUTATION') ? 'var(--bad)' : t === 'AGENT_FAILED' || t === 'TASK_FAILED' ? '#ff4d4d' : null);
  $('marks').innerHTML = live.timeline.map((e) => (color(e.type) ? `<span data-seq="${e.seq}" title="#${e.seq} ${esc(e.label)}" style="left:${((e.seq - 0.5) / n) * 100}%;background:${color(e.type)}"></span>` : '')).join('');
}

function renderInspector() {
  const el = $('inspector');
  const a = selected ? state.agents[selected] : null;
  if (!a) return void (el.innerHTML = '<p class="hint">Click a character in the world to inspect it.</p>');
  const k = agentKnowledge(state, a.id)!;
  const list = (items: string[], empty: string) => (items.length ? items.map((x) => `<div class="item">${x}</div>`).join('') : `<p class="hint">${empty}</p>`);
  const body: Record<string, string> = {
    overview: `<dl class="kv"><dt>Status</dt><dd>${esc(a.status)}</dd><dt>Room</dt><dd>${esc(ROOM_LABELS[a.room])}</dd><dt>Doing</dt><dd>${esc(a.activity)}</dd><dt>Calls</dt><dd>${a.calls} · ${a.tokensConsumed.toLocaleString()} tok</dd><dt>Model</dt><dd>${esc(a.modelProvider)}/${esc(a.modelName)}</dd><dt>Work</dt><dd>${a.stats.messagesSent} msgs · ${a.stats.artifactsCreated} artifacts · ${a.stats.checksRun} checks · ${a.stats.actionsRejected} rejected</dd><dt>Generation</dt><dd>created gen ${a.generationCreated}</dd><dt>Source</dt><dd>event #${a.activitySeq}</dd></dl>`,
    messages: list(k.messages.slice(-20).reverse().map((m) => `<small>#${m.seq} ${esc(m.from)} → ${esc(m.to.join(', '))} · ${esc(m.kind)}</small>${esc(m.content.slice(0, 600))}`), 'No messages known.'),
    artifacts: list(k.artifacts.slice(-20).reverse().map((x) => `<small>#${x.seq} ${esc(x.kind)} by ${esc(x.authorId)}</small>${esc(x.title)}`), 'No artifacts known.'),
    beliefs: list(k.beliefs.map((b) => `<small>confidence ${b.confidence.toFixed(2)}</small>${esc(b.claim)}`), 'No recorded beliefs.'),
    memory: list(k.memory.map((m) => `<small>${esc(m.scope)}/${esc(m.kind)} · run ${esc(m.provenance.runId)}</small>${esc(m.content)}`), 'No readable memory.'),
  };
  el.innerHTML = `<div class="itop"><div class="avatar" style="background:${colorOf(a.roleId)}">${esc(codeOf(a.name))}</div><div><div style="font-weight:600">${esc(a.name)}</div><div class="hint">${esc(a.roleName)} — ${esc(a.roleObjective)}</div></div></div>
    <label class="hint"><input type="checkbox" id="viewAs" ${viewAs ? 'checked' : ''}> View as ${esc(a.name)} (only what it knows)</label>
    <div class="itabs">${Object.keys(body).map((t) => `<button data-insp="${t}" aria-selected="${t === inspTab}">${t[0]!.toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <div class="ibody">${body[inspTab]}</div>`;
  ($('viewAs') as HTMLInputElement).onchange = (e) => ((viewAs = (e.target as HTMLInputElement).checked), renderFeed());
  el.querySelectorAll<HTMLButtonElement>('[data-insp]').forEach((b) => (b.onclick = () => ((inspTab = b.dataset.insp!), renderInspector())));
}

const GLOBAL = new Set(['RUN_CREATED', 'RUN_STARTED', 'RUN_COMPLETED', 'RUN_FAILED', 'RUN_PAUSED', 'RUN_RESUMED', 'TASK_CREATED', 'TASK_COMPLETED', 'TASK_FAILED', 'ORGANIZATION_INSTANTIATED', 'ORGANIZATION_MUTATED', 'ORGANIZATION_ROLLED_BACK', 'PHASE_CHANGED']);
function renderFeed() {
  let items = state.timeline;
  let hidden = 0;
  const who = selected && state.agents[selected] ? selected : null;
  if (viewAs && who) {
    const k = agentKnowledge(state, who)!;
    const known = new Set([...k.messages.map((m) => m.messageId), ...k.artifacts.map((a) => a.artifactId), ...k.decisions.map((d) => d.decisionId), ...k.memory.map((m) => m.memoryId)]);
    const kept = items.filter((e) => e.actorId === who || (e.refId && known.has(e.refId)) || GLOBAL.has(e.type));
    hidden = items.length - kept.length;
    items = kept;
  }
  $('feedTitle').textContent = viewAs && who ? `Event stream · as ${state.agents[who]!.name}` : 'Event stream · God view';
  $('feedCount').textContent = `${state.eventCount} events`;
  const note = $('hiddenNote');
  note.hidden = !(viewAs && who);
  note.textContent = `${hidden} timeline entries are unknown to this agent and hidden.`;
  const cur = viewSeq ?? live.lastSequence;
  $('feed').innerHTML = items.slice(-300).reverse().map((e) => `<li data-seq="${e.seq}" data-actor="${esc(e.actorId ?? '')}" class="${e.seq === cur ? 'cur' : ''}"><span class="n">#${e.seq}</span><span class="t"><span class="ty">${esc(e.type)}</span><br>${esc(e.label)}</span></li>`).join('');
}

function renderNetwork() {
  const g = state.genome;
  const svg = $('netSvg');
  if (!g) return void (svg.innerHTML = '');
  const ids = g.agents.map((a) => a.id);
  const cx = 380, cy = 225, R = 170;
  const pos: Record<string, { x: number; y: number }> = {};
  const others = ids.filter((i) => i !== g.entryAgentId);
  pos[g.entryAgentId] = { x: cx, y: cy };
  others.forEach((id, i) => {
    const ang = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    pos[id] = { x: cx + R * 1.25 * Math.cos(ang), y: cy + R * Math.sin(ang) };
  });
  const sent: Record<string, number> = {};
  for (const id of state.messageOrder) for (const t of state.messages[id]!.to) sent[`${state.messages[id]!.from}>${t}`] = (sent[`${state.messages[id]!.from}>${t}`] ?? 0) + 1;
  let out = '<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#5d6878"/></marker></defs>';
  for (const e of g.edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, n = sent[`${e.from}>${e.to}`] ?? 0;
    out += `<line x1="${a.x + (dx / d) * 20 - (dy / d) * 4}" y1="${a.y + (dy / d) * 20 + (dx / d) * 4}" x2="${b.x - (dx / d) * 22 - (dy / d) * 4}" y2="${b.y - (dy / d) * 22 + (dx / d) * 4}" stroke="${n ? '#e3a63d' : '#3c4656'}" stroke-width="${1 + Math.min(5, n)}" marker-end="url(#arr)"><title>${esc(e.from)} → ${esc(e.to)} (${e.kind}) · ${n} messages</title></line>`;
  }
  for (const id of ids) {
    const p = pos[id]!, a = state.agents[id];
    out += `<circle cx="${p.x}" cy="${p.y}" r="18" fill="${colorOf(a?.roleId ?? id)}"/><text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="11" style="fill:#12161d">${esc(codeOf(a?.name ?? id))}</text><text x="${p.x}" y="${p.y + 34}" text-anchor="middle" font-size="11">${esc(a?.name ?? id)}</text>`;
  }
  svg.innerHTML = out;
}

function renderEvolution() {
  const ev = state.evolution;
  $('genTxt').textContent = `generation ${ev.generation} · ${Object.keys(ev.proposals).length} proposals`;
  if (!ev.entries.length) return void ($('evoList').innerHTML = '<p class="hint">No organizational changes recorded in this run.</p>');
  $('evoList').innerHTML = ev.entries
    .map((e) => {
      const p = e.proposalId ? ev.proposals[e.proposalId] : null;
      const col = e.kind === 'mutated' ? 'var(--good)' : e.kind === 'rejected' || e.kind === 'rolled_back' ? 'var(--bad)' : 'var(--line)';
      return `<div class="item" style="border-left-color:${col};margin-bottom:6px"><small>#${e.seq} · ${esc(e.kind)} · gen ${e.generation}</small>${esc(e.detail)}${p && e.kind === 'proposed' ? `<small>evidence ${esc(JSON.stringify(p.proposal.evidence))}</small>` : ''}</div>`;
    })
    .join('');
}

async function renderMetrics() {
  if (!runId) return;
  const m = await api<Record<string, any>>(`/runs/${encodeURIComponent(runId)}/metrics`);
  const rows: Array<[string, string]> = [
    ['Evaluated tasks', `${m.tasks} (${m.successes} succeeded)`],
    ['Success rate', m.successRate.toFixed(3)],
    ['Cumulative reward', m.cumulativeReward.toFixed(3)],
    ['Lifetime tokens / calls / $', `${m.lifetime.tokens.toLocaleString()} / ${m.lifetime.calls} / $${m.lifetime.usd.toFixed(4)}`],
    ['…of which validation (shadow runs)', `${m.lifetime.byCategory.validation.tokens.toLocaleString()} tokens`],
    ['Messages per task', m.communication.messagesPerTask.toFixed(2)],
    ['Generation · accepted / rejected mutations', `${m.generation} · ${m.mutations.accepted} / ${m.mutations.rejected}`],
    ['Structural churn per 100 tasks', m.churn.per100.toFixed(2)],
    ['Adaptation half-lives', m.halfLives.length ? m.halfLives.map((h: any) => (h.halfLife ?? 'never')).join(', ') : 'no phase shift'],
    ['Forced submissions', String(m.forcedSubmissions)],
    ['Provider', `${m.provider}${m.scripted ? ' (SCRIPTED — not a result)' : ''}`],
  ];
  $('metrics').innerHTML = `<table class="m">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
}

/* ---------- controls ---------- */
const syncPlay = () => ($('playBtn').textContent = playing ? 'Pause' : 'Play');
$('scrub').addEventListener('input', (e) => ((playing = false), syncPlay(), step(Number((e.target as HTMLInputElement).value))));
$('marks').addEventListener('click', (e) => {
  const s = (e.target as HTMLElement).dataset.seq;
  if (s) ((playing = false), syncPlay(), step(Number(s)));
});
$('feed').addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li) return;
  if (li.dataset.actor && state.agents[li.dataset.actor]) selected = li.dataset.actor;
  playing = false;
  syncPlay();
  step(Number(li.dataset.seq));
});
$('followBtn').onclick = () => {
  world.follow = world.follow ? null : selected;
  $('followBtn').setAttribute('aria-pressed', String(!!world.follow));
  $('followBtn').textContent = world.follow ? `Following ${state.agents[world.follow]?.name ?? ''}` : 'Follow agent';
};
$('liveBtn').onclick = () => ((viewSeq = null), (playing = false), syncPlay(), setState(live, true));
$('playBtn').onclick = () => {
  if (viewSeq === null) viewSeq = 0;
  playing = !playing;
  syncPlay();
};
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => (b.onclick = () => ((speed = Number(b.dataset.speed)), document.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))))));
const jump = (pred: (t: string) => boolean) => {
  const e = live.timeline.find((x) => pred(x.type) && x.seq > (viewSeq ?? 0)) ?? live.timeline.find((x) => pred(x.type));
  if (e) ((playing = false), syncPlay(), step(e.seq));
};
$('jumpDecision').onclick = () => jump((t) => t === 'DECISION_COMPLETED');
$('jumpMutation').onclick = () => jump((t) => t === 'ORGANIZATION_MUTATED' || t === 'ORGANIZATION_ROLLED_BACK' || t === 'MUTATION_REJECTED');
$('runSelect').addEventListener('change', (e) => void openRun((e.target as HTMLSelectElement).value));
window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  follow = id === 'latest';
  if (id && id !== 'latest' && id !== runId) void openRun(id);
});
$('runSelect').addEventListener('change', () => (follow = false));
document.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('nav.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${b.dataset.view}`));
  if (b.dataset.view === 'metrics') void renderMetrics();
  renderPanels();
}));
document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, select, textarea')) return;
  if (e.key === 'ArrowRight') step((viewSeq ?? live.lastSequence) + 1);
  if (e.key === 'ArrowLeft') step((viewSeq ?? live.lastSequence) - 1);
  if (e.key === ' ') (e.preventDefault(), $('playBtn').click());
});

requestAnimationFrame(frame);
loadRuns().catch((err) => ($('liveTxt').textContent = `cannot reach the OrgWorld runtime: ${err instanceof Error ? err.message : String(err)}`));

/** Read-only inspection handle for automated UI tests (build §78: "UI world state matches backend world state"). */
(window as unknown as Record<string, unknown>).__orgworld = {
  get runId() { return runId; },
  get lastSequence() { return state.lastSequence; },
  get eventCount() { return events.length; },
  get viewSeq() { return viewSeq; },
  agents: () => Object.fromEntries(Object.entries(state.agents).filter(([, a]) => !a.removed).map(([id, a]) => [id, { room: a.room, status: a.status, activitySeq: a.activitySeq }])),
  chars: () => Object.fromEntries(Object.entries(chars).map(([id, c]) => [id, { x: c.x, y: c.y, moving: c.path.length > 0 }])),
  screenPos: (id: string) => world.screenPos(id),
};
