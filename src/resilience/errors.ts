/** Name used to keep retries, limits, and logs separate for each outside service. */
export type ProviderName = string;

export interface ProviderHttpErrorInput {
  readonly provider: ProviderName;
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs?: number | undefined;
}

export interface ProviderResponseHeaders {
  readonly get: (name: string) => string | null;
}

/** Error thrown when a provider HTTP response is not successful. */
export class ProviderHttpError extends Error {
  readonly provider: ProviderName;
  readonly status: number;
  readonly body: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(input: ProviderHttpErrorInput) {
    super(`${input.provider} API request failed with HTTP ${input.status}: ${input.body}`);
    this.name = 'ProviderHttpError';
    this.provider = input.provider;
    this.status = input.status;
    this.body = input.body;
    this.retryable = isRetryableHttpStatus(input.status);
    this.retryAfterMs = input.retryAfterMs;
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function isRetryableProviderError(error: Error): boolean {
  if (error instanceof ProviderHttpError) return error.retryable;
  return isTransientNetworkError(error);
}

function isTransientNetworkError(error: Error): boolean {
  if (error instanceof TypeError && error.message === 'fetch failed') return true;
  const cause = error.cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
  return code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN'
    || code === 'ENOTFOUND';
}

export function retryAfterMsFromHeaders(headers: ProviderResponseHeaders | undefined): number | undefined {
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

export function errorLogFields(error: Error): {
  readonly errorName: string;
  readonly errorMessage: string;
} {
  return {
    errorName: error.name,
    errorMessage: error.message
  };
}
