import type { ProviderId, Usage } from '@orgworld/protocol';

export interface CognitionRequest {
  system: string;
  prompt: string;
  /** JSON Schema the response must satisfy (structured output). */
  jsonSchema?: Record<string, unknown>;
  model: string;
  maxOutputTokens?: number;
  /** Honoured only when the provider reports samplingControlled=true (conflict C-07). */
  temperature?: number;
  purpose: string;
  timeoutMs?: number;
}

export interface CognitionResult {
  text: string;
  json: unknown | null;
  usage: Usage;
  costUsd: number;
  model: string;
  provider: ProviderId;
  samplingControlled: boolean;
  latencyMs: number;
}

/** ADR-005: the only surface through which agent cognition enters OrgWorld. */
export interface CognitionProvider {
  readonly id: ProviderId;
  complete(req: CognitionRequest): Promise<CognitionResult>;
}

export interface CognitionErrorOptions {
  /** Server-requested wait before retrying (e.g. the `retry-after` header). */
  retryAfterMs?: number;
  /**
   * The request can never succeed as configured (bad request, auth, billing, unknown model). This is an
   * infrastructure/configuration fault, not agent behaviour: the run stops instead of scoring a failed task.
   */
  fatal?: boolean;
}

export class CognitionError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly fatal: boolean;
  constructor(
    message: string,
    public readonly retryable: boolean,
    opts: CognitionErrorOptions = {},
  ) {
    super(message);
    this.name = 'CognitionError';
    this.retryAfterMs = opts.retryAfterMs;
    this.fatal = opts.fatal ?? false;
  }
}
