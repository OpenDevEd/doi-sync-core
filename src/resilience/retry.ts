import pRetry from 'p-retry';
import type { CoreLogger } from '../logging.js';
import type { ProviderName } from './errors.js';
import { errorLogFields, isRetryableProviderError, ProviderHttpError } from './errors.js';

export interface ProviderRetryOptions {
  readonly provider: ProviderName;
  readonly retries?: number;
  readonly minTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly randomize?: boolean;
  readonly logger?: CoreLogger;
}

export async function retryProviderOperation<T>(
  operation: () => Promise<T>,
  options: ProviderRetryOptions
): Promise<T> {
  return pRetry(operation, {
    retries: options.retries ?? 3,
    minTimeout: options.minTimeoutMs ?? 250,
    maxTimeout: options.maxTimeoutMs ?? 2000,
    randomize: options.randomize ?? true,
    shouldRetry: ({ error }) => isRetryableProviderError(error),
    onFailedAttempt: async ({ error, attemptNumber, retriesLeft, retryDelay }) => {
      options.logger?.warn({
        provider: options.provider,
        attemptNumber,
        retriesLeft,
        retryDelay,
        ...errorLogFields(error)
      }, 'provider operation failed; retrying if allowed');
      if (retriesLeft > 0 && error instanceof ProviderHttpError && error.retryable && error.retryAfterMs && error.retryAfterMs > 0) {
        await sleep(error.retryAfterMs);
      }
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
