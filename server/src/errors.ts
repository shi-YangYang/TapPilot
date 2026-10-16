export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function publicError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError("INTERNAL_ERROR", "Internal operation failed. No action was retried.");
}
