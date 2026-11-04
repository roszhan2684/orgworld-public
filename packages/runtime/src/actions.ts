import { z } from 'zod';
import { MESSAGE_KINDS } from '@orgworld/protocol';

/**
 * Agent action vocabulary. The model returns a flat JSON object per action (easy for structured output);
 * the runtime validates each action with the per-type schema below and rejects invalid ones with a reason
 * that the agent sees on its next turn (ACTION_REJECTED). Nothing is silently dropped.
 */
export const ACTION_TYPES = [
  'send_message',
  'write_code',
  'write_tests',
  'run_checks',
  'review',
  'submit',
  'record_belief',
  'remember',
  'recall',
  'propose_decision',
  'call_meeting',
  'read_file',
  'list_files',
  'wait',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const str = (max: number) => z.string().min(1).max(max);

export const ActionSchemas = {
  send_message: z.object({ type: z.literal('send_message'), to: z.array(z.string()).min(1).max(12), kind: z.enum(MESSAGE_KINDS), content: str(4000), attach: z.array(z.string()).max(6).optional() }),
  write_code: z.object({ type: z.literal('write_code'), title: str(120), code: str(60_000) }),
  write_tests: z.object({ type: z.literal('write_tests'), title: str(120), code: str(60_000) }),
  run_checks: z.object({ type: z.literal('run_checks'), artifactId: str(64) }),
  review: z.object({ type: z.literal('review'), artifactId: str(64), verdict: z.enum(['approve', 'request_changes']), comments: str(4000) }),
  submit: z.object({ type: z.literal('submit'), artifactId: str(64) }),
  record_belief: z.object({ type: z.literal('record_belief'), claim: str(400), confidence: z.number().min(0).max(1) }),
  remember: z.object({ type: z.literal('remember'), content: str(1500), scope: z.enum(['private', 'team', 'org']), kind: z.enum(['episodic', 'semantic', 'decision', 'failure']).default('semantic') }),
  recall: z.object({ type: z.literal('recall'), query: str(300) }),
  propose_decision: z.object({ type: z.literal('propose_decision'), question: str(300), options: z.array(str(120)).min(2).max(5), recommendation: str(120) }),
  call_meeting: z.object({ type: z.literal('call_meeting'), participants: z.array(z.string()).min(1).max(8), agenda: str(400) }),
  read_file: z.object({ type: z.literal('read_file'), path: str(400) }),
  list_files: z.object({ type: z.literal('list_files'), path: z.string().max(400).default('.') }),
  wait: z.object({ type: z.literal('wait') }),
} as const;

export type Action = { [K in ActionType]: z.infer<(typeof ActionSchemas)[K]> }[ActionType];

export function parseAction(raw: unknown): { ok: true; action: Action } | { ok: false; reason: string; type: string } {
  const type = (raw as { type?: unknown })?.type;
  if (typeof type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(type)) return { ok: false, reason: `unknown action type ${JSON.stringify(type)}`, type: String(type) };
  // Strip nulls/empty strings the model may emit for unused flat fields.
  const cleaned = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));
  const r = ActionSchemas[type as ActionType].safeParse(cleaned);
  if (!r.success) return { ok: false, reason: r.error.issues.map((i) => `${i.path.join('.') || type}: ${i.message}`).join('; '), type };
  return { ok: true, action: r.data as Action };
}

/** JSON Schema handed to the provider for structured output (flat, permissive; strict validation happens in parseAction). */
export const TURN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string', description: 'One or two sentences: what you are doing and why (public, recorded).' },
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...ACTION_TYPES] },
          to: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: [...MESSAGE_KINDS] },
          content: { type: 'string' },
          attach: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
          code: { type: 'string' },
          artifactId: { type: 'string' },
          verdict: { type: 'string', enum: ['approve', 'request_changes'] },
          comments: { type: 'string' },
          claim: { type: 'string' },
          confidence: { type: 'number' },
          scope: { type: 'string', enum: ['private', 'team', 'org'] },
          query: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
          participants: { type: 'array', items: { type: 'string' } },
          agenda: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['type'],
      },
    },
  },
  required: ['reasoning', 'actions'],
} as const;

export const VOTE_JSON_SCHEMA = {
  type: 'object',
  properties: { option: { type: 'string' }, rationale: { type: 'string' } },
  required: ['option', 'rationale'],
  additionalProperties: false,
} as const;

export const MEETING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['PROPOSAL', 'EVIDENCE', 'CHALLENGE', 'ANSWER', 'STATUS_UPDATE'] },
    content: { type: 'string' },
  },
  required: ['kind', 'content'],
  additionalProperties: false,
} as const;

/** Actions that let an agent keep working without waiting for someone else. */
export const SELF_CONTINUING: ReadonlySet<ActionType> = new Set(['write_code', 'write_tests', 'run_checks', 'record_belief', 'remember', 'recall', 'read_file', 'list_files']);
