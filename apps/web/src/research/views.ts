import { deliberationView, knowledgeView, type WorldState } from '@orgworld/core';

/*
 * Research views for the organization-behaviour extensions (ideas 28–29, conflict C-21). Pure renderers: they take the
 * state reduced from events and return HTML, so what they show is exactly what was recorded. Not yet placed in the
 * app's layout (the web redesign is in progress); mount with `el.innerHTML = renderDeliberation(state)` and add
 * RESEARCH_VIEW_CSS once.
 */

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

/** Idea 28: every decision with its rounds of votes, arguments, changed minds, and prediction against the outcome. */
export function renderDeliberation(s: WorldState): string {
  const v = deliberationView(s);
  if (!v.decisions.length) return '<section class="ow-research"><h3>Decisions</h3><p class="ow-muted">No decisions recorded in this run.</p></section>';
  const decisions = v.decisions
    .slice()
    .reverse()
    .map((d) => {
      const outcome = d.taskSuccess === null ? 'task still open' : d.taskSuccess ? 'task passed' : 'task failed';
      const rounds = d.rounds
        .map(
          (r) =>
            `<div class="ow-round"><span class="ow-label">Round ${r.round}${r.votes.some((x) => x.blind) ? ' · blind' : ''}</span>${r.votes
              .map((x) => `<span class="ow-vote${x.option === d.chosen ? ' ow-win' : ''}" title="${esc(x.rationale)}">${esc(x.agentId)} → ${esc(x.option)}${x.confidence === null ? '' : ` · ${pct(x.confidence)}`}${x.previousOption && x.previousOption !== x.option ? ` <em>(was ${esc(x.previousOption)})</em>` : ''}</span>`)
              .join('')}</div>`,
        )
        .join('');
      const args = d.arguments
        .map((a) => `<li class="ow-arg ow-${a.stance}"><b>${esc(a.agentId)}</b> ${a.stance === 'against' ? 'argues against' : a.stance === 'rebuttal' ? 'rebuts for' : 'pre-mortem on'} <i>${esc(a.option)}</i>: ${esc(a.content)}${a.evidence.length ? ` <span class="ow-muted">[${a.evidence.map(esc).join(', ')}${a.evidenceValid ? '' : ' — not visible to them'}]</span>` : ''}</li>`)
        .join('');
      return `<article class="ow-decision">
  <header><b>${esc(d.question)}</b> <span class="ow-muted">${esc(d.policy)} · proposed by ${esc(d.proposerId)}</span></header>
  ${rounds}
  ${args ? `<ul class="ow-args">${args}</ul>` : ''}
  <footer>Chose <b>${esc(d.chosen ?? '—')}</b>${d.tieBreakBy ? ` (settled by ${esc(d.tieBreakBy)})` : ''} · predicted ${pct(d.predictedSuccess)} · <span class="${d.taskSuccess ? 'ow-good' : d.taskSuccess === false ? 'ow-bad' : ''}">${outcome}</span>${d.mindChanges.length ? ` · ${d.mindChanges.length} changed their mind` : ''}${d.minorityReport ? `<div class="ow-muted">Minority: ${esc(d.minorityReport)}</div>` : ''}</footer>
</article>`;
    })
    .join('\n');
  const track = v.trackRecords.length
    ? `<table class="ow-table"><thead><tr><th>Agent</th><th>Scored predictions</th><th>Brier (lower is better)</th><th>Track record</th></tr></thead><tbody>${v.trackRecords.map((t) => `<tr><td>${esc(t.agentId)}</td><td>${t.predictions}</td><td>${t.brier === null ? '—' : t.brier.toFixed(3)}</td><td>${pct(t.score)}</td></tr>`).join('')}</tbody></table>`
    : '';
  return `<section class="ow-research"><h3>Decisions</h3>${track}${decisions}</section>`;
}

/** Idea 29: lessons and playbook with how they performed, the reviews behind them, who knows what, and growth. */
export function renderKnowledge(s: WorldState): string {
  const k = knowledgeView(s);
  const items = k.items.filter((i) => i.type !== 'other');
  const rows = items
    .slice()
    .reverse()
    .map((i) => `<tr class="${i.retired ? 'ow-retired' : ''}"><td>${esc(i.type)}</td><td>${esc(i.category ?? '—')}</td><td>${esc(i.content)}</td><td>${i.uses ? `${i.wins}/${i.uses}` : '—'}</td><td>${i.utility === null ? '—' : pct(i.utility)}</td><td>${i.retired ? 'retired' : 'active'}</td></tr>`)
    .join('');
  const cats = [...new Set(Object.values(k.expertise).flatMap((r) => Object.keys(r)))].sort();
  const expertise = cats.length
    ? `<table class="ow-table"><thead><tr><th>Agent</th>${cats.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${Object.entries(k.expertise)
        .sort()
        .map(([a, r]) => `<tr><td>${esc(a)}</td>${cats.map((c) => `<td>${r[c] ? `${r[c]!.passed}/${r[c]!.worked}` : ''}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '<p class="ow-muted">No finished tasks yet.</p>';
  const reviews = k.reflections
    .slice(-5)
    .reverse()
    .map((x) => `<li><b>${esc(x.agentId)}</b> on a ${esc(x.category ?? '')} task that ${x.success ? 'passed' : 'failed'}: ${x.whys.map((w) => `why? ${esc(w)}`).join(' → ')} ⇒ <i>${esc(x.lesson)}</i></li>`)
    .join('');
  const g = k.growth;
  const max = Math.max(1, ...g.map((p) => p.items));
  const last = g.length ? g[g.length - 1]!.seq : 1;
  const spark = g.length > 1 ? `<svg class="ow-spark" viewBox="0 0 200 40" role="img" aria-label="Knowledge items over the run: ${g[g.length - 1]!.items}"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${g.map((p) => `${((p.seq / last) * 200).toFixed(1)},${(40 - (p.items / max) * 36).toFixed(1)}`).join(' ')}"/></svg>` : '';
  return `<section class="ow-research"><h3>Knowledge ${spark}</h3>
  ${rows ? `<table class="ow-table"><thead><tr><th>Type</th><th>Category</th><th>Content</th><th>Helped</th><th>Utility</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="ow-muted">No lessons or playbook entries yet.</p>'}
  ${reviews ? `<h4>Recent reviews</h4><ul class="ow-args">${reviews}</ul>` : ''}
  <h4>Who has done well at what</h4>${expertise}
  ${k.contributions.length ? `<h4>Contribution checks</h4><ul class="ow-args">${k.contributions.map((c) => `<li>${esc(c.agentId)}: ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(3)} (with ${c.withScore.toFixed(3)}, without ${c.withoutScore.toFixed(3)})</li>`).join('')}</ul>` : ''}
</section>`;
}

export const RESEARCH_VIEW_CSS = `
.ow-research{font:13px/1.45 system-ui,sans-serif}
.ow-research h3{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.ow-muted{opacity:.65}
.ow-decision{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;padding:8px 10px;margin:8px 0}
.ow-round{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0}
.ow-label{font-weight:600;min-width:72px}
.ow-vote{padding:1px 6px;border-radius:999px;background:color-mix(in srgb,currentColor 8%,transparent)}
.ow-vote.ow-win{outline:1px solid currentColor}
.ow-args{margin:6px 0;padding-left:18px}
.ow-good{color:#1a7f37}.ow-bad{color:#cf222e}
.ow-table{border-collapse:collapse;width:100%;margin:6px 0}
.ow-table th,.ow-table td{border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);padding:3px 6px;text-align:left;vertical-align:top}
.ow-retired{opacity:.5;text-decoration:line-through}
.ow-spark{width:120px;height:24px}
`;
