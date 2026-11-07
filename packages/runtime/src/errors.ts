/**
 * The model service failed in a way that says nothing about the agents: retries exhausted on a transient error
 * (rate limit, overload, 5xx, network) or a fatal configuration error (auth, billing, bad request). It is never
 * scored as a failed task; it propagates and stops the run, which experiments exclude and re-attempt (C-19).
 */
export class InfrastructureError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'InfrastructureError';
  }
}
