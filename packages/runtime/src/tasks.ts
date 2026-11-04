import type { BenchTask } from '@orgworld/bench';

/** A unit of work for the organization. Bench tasks have hidden evaluators; objectives (product mode) do not (C-06). */
export type TaskSpec =
  | { kind: 'bench'; task: BenchTask; taskIndex?: number; phaseId?: string; split?: 'train' | 'validation' | 'test' | 'transfer' }
  | { kind: 'objective'; title: string; objective: string };

export interface TaskOutcome {
  taskId: string;
  benchTaskId: string | null;
  category: string | null;
  success: boolean;
  score: number;
  reward: number;
  evaluated: boolean;
  forced: boolean;
  submittedBy: string | null;
  turns: number;
  tokens: number;
  calls: number;
  usd: number;
  messages: number;
  genomeId: string;
  stopReason: 'submitted' | 'max-turns' | 'budget' | 'stalled' | 'stopped' | 'entry-failed';
}
