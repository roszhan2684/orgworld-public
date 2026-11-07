import type { OrgEvent, PayloadOf } from '@orgworld/protocol';

export type MemoryItem = PayloadOf<'MEMORY_WRITTEN'> & { runId: string; seq: number };

const STOP = new Set('the a an and or of to in on for with is are be by it this that as at from was were not no use'.split(' '));
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1 && !STOP.has(t));

/**
 * Scoped memory with provenance (ADR-007). Retrieval is deterministic lexical scoring (BM25-lite).
 * Access: private → owner only; team → same team; org → readable when genome memoryRead = 'org'.
 */
export class MemoryIndex {
  private items: MemoryItem[] = [];

  add(e: OrgEvent<'MEMORY_WRITTEN'>): void {
    this.items.push({ ...e.payload, runId: e.runId, seq: e.sequence });
  }

  get size(): number {
    return this.items.length;
  }

  all(): readonly MemoryItem[] {
    return this.items;
  }

  canRead(item: MemoryItem, agentId: string, teamId: string | null, memoryRead: 'none' | 'private' | 'team' | 'org'): boolean {
    if (item.scope === 'private') return item.ownerAgentId === agentId;
    if (memoryRead === 'none' || memoryRead === 'private') return false;
    if (item.scope === 'team') return !!teamId && item.teamId === teamId;
    return memoryRead === 'org';
  }

  /**
   * `opts` (C-21): `filter` limits candidates (e.g. by tag), `boost` multiplies the lexical score (e.g. lesson utility),
   * `recentFallback` returns the newest readable candidates when none matches the query lexically.
   */
  retrieve(
    query: string,
    agentId: string,
    teamId: string | null,
    memoryRead: 'none' | 'private' | 'team' | 'org',
    k = 3,
    opts: { filter?: (it: MemoryItem) => boolean; boost?: (it: MemoryItem) => number; recentFallback?: boolean } = {},
  ): { items: MemoryItem[]; denied: string[] } {
    if (opts.filter || opts.boost || opts.recentFallback) return this.retrieveWith(query, agentId, teamId, memoryRead, k, opts);
    const q = tokens(query);
    if (q.length === 0) return { items: [], denied: [] };
    const N = this.items.length;
    const df = new Map<string, number>();
    for (const it of this.items) for (const t of new Set(tokens(it.content))) df.set(t, (df.get(t) ?? 0) + 1);
    const scored = this.items
      .map((it) => {
        const tf = tokens(it.content);
        let score = 0;
        for (const t of q) {
          const f = tf.filter((x) => x === t).length;
          if (f) score += (Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5)) * f * 2.2) / (f + 1.2);
        }
        return { it, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.it.seq - b.it.seq);
    const items: MemoryItem[] = [];
    const denied: string[] = [];
    for (const { it } of scored) {
      if (!this.canRead(it, agentId, teamId, memoryRead)) denied.push(it.memoryId);
      else if (items.length < k) items.push(it);
    }
    return { items, denied };
  }

  private retrieveWith(query: string, agentId: string, teamId: string | null, memoryRead: 'none' | 'private' | 'team' | 'org', k: number, opts: { filter?: (it: MemoryItem) => boolean; boost?: (it: MemoryItem) => number; recentFallback?: boolean }): { items: MemoryItem[]; denied: string[] } {
    const pool = this.items.filter((it) => !opts.filter || opts.filter(it));
    const q = new Set(tokens(query));
    const denied: string[] = [];
    const readable = pool.filter((it) => {
      const ok = this.canRead(it, agentId, teamId, memoryRead);
      if (!ok) denied.push(it.memoryId);
      return ok;
    });
    const scored = readable
      .map((it) => {
        const t = tokens(it.content);
        const overlap = t.length ? t.filter((x) => q.has(x)).length / Math.sqrt(t.length) : 0;
        return { it, score: overlap * (opts.boost ? opts.boost(it) : 1) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.it.seq - a.it.seq);
    let items = scored.slice(0, k).map((x) => x.it);
    if (!items.length && opts.recentFallback) items = [...readable].sort((a, b) => (opts.boost ? opts.boost(b) - opts.boost(a) : 0) || b.seq - a.seq).slice(0, k);
    return { items, denied };
  }
}
