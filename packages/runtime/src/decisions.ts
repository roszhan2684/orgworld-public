import type { DecisionPolicy } from '@orgworld/protocol';

export interface Ballot {
  agentId: string;
  option: string;
  weight: number;
  isEntry: boolean;
  canReview: boolean;
  /** Tally value under non-weighted policies (default 1). The evidence rule and track record lower or raise it (C-21). */
  value?: number;
}

export interface Resolution {
  chosen: string;
  confidence: number;
  tally: Record<string, number>;
  rationale: string;
  opposition: string[];
}

/** Policies implemented in v0.1. Others are refused explicitly (never silently substituted). */
export const IMPLEMENTED_POLICIES: ReadonlySet<DecisionPolicy> = new Set(['DIRECTOR', 'MAJORITY', 'WEIGHTED_VOTE', 'CONSENSUS', 'VETO']);

export function resolveDecision(policy: DecisionPolicy, options: string[], ballots: Ballot[], recommendation: string): Resolution {
  if (!IMPLEMENTED_POLICIES.has(policy)) throw new Error(`decision policy ${policy} is not implemented in v0.1`);
  const tally: Record<string, number> = Object.fromEntries(options.map((o) => [o, 0]));
  for (const b of ballots) tally[b.option] = (tally[b.option] ?? 0) + (policy === 'WEIGHTED_VOTE' ? b.weight : (b.value ?? 1));
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] === recommendation ? -1 : b[0] === recommendation ? 1 : 0));
  const top = ranked[0]?.[0] ?? recommendation;
  const share = total > 0 ? (tally[top] ?? 0) / total : 0;
  const against = (c: string) => ballots.filter((b) => b.option !== c).map((b) => b.agentId);
  switch (policy) {
    case 'DIRECTOR': {
      const d = ballots.find((b) => b.isEntry);
      const chosen = d?.option ?? recommendation;
      return { chosen, confidence: d ? 1 : 0.5, tally, rationale: d ? 'entry agent (director) decides' : 'director did not vote; recommendation adopted', opposition: against(chosen) };
    }
    case 'CONSENSUS': {
      const unanimous = ballots.length > 0 && ballots.every((b) => b.option === ballots[0]!.option);
      const chosen = unanimous ? ballots[0]!.option : recommendation;
      return { chosen, confidence: unanimous ? 1 : 0.3, tally, rationale: unanimous ? 'unanimous' : 'no consensus — proposer recommendation adopted with low confidence', opposition: against(chosen) };
    }
    case 'VETO': {
      const vetoers = ballots.filter((b) => b.canReview && b.option !== recommendation);
      if (vetoers.length) {
        const alt = options.find((o) => o !== recommendation) ?? recommendation;
        return { chosen: alt, confidence: 0.6, tally, rationale: `vetoed by ${vetoers.map((v) => v.agentId).join(', ')}`, opposition: against(alt) };
      }
      return { chosen: top, confidence: share, tally, rationale: 'no veto; plurality', opposition: against(top) };
    }
    default:
      return { chosen: top, confidence: share, tally, rationale: `${policy === 'WEIGHTED_VOTE' ? 'weighted ' : ''}plurality ${(share * 100).toFixed(0)}%`, opposition: against(top) };
  }
}
