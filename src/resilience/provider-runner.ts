import { createNoopLogger, type CoreLogger } from '../logging.js';
import type { ProviderName } from './errors.js';
import { BottleneckProviderRateLimiter, type ProviderRateLimiter } from './rate-limit.js';
import { retryProviderOperation, type ProviderRetryOptions } from './retry.js';

export interface ProviderOperationRunner {
  readonly run: <T>(provider: ProviderName, operation: () => Promise<T>) => Promise<T>;
  readonly runOnce?: <T>(provider: ProviderName, operation: () => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
}

export interface ResilientProviderOperationRunnerInput {
  readonly limiters?: ReadonlyMap<ProviderName, ProviderRateLimiter>;
  readonly retry?: Omit<ProviderRetryOptions, 'provider' | 'logger'>;
  readonly logger?: CoreLogger;
}

/** Runs provider operations immediately with no retry or rate limiting. */
export class DirectProviderOperationRunner implements ProviderOperationRunner {
  async run<T>(_provider: ProviderName, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async runOnce<T>(_provider: ProviderName, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Runs provider operations through retry and per-provider rate limiting. */
export class ResilientProviderOperationRunner implements ProviderOperationRunner {
  private readonly limiters: ReadonlyMap<ProviderName, ProviderRateLimiter>;
  private readonly retry: Omit<ProviderRetryOptions, 'provider' | 'logger'>;
  private readonly logger: CoreLogger;

  constructor(input: ResilientProviderOperationRunnerInput = {}) {
    this.limiters = input.limiters ?? createDefaultProviderLimiters();
    this.retry = input.retry ?? {};
    this.logger = input.logger ?? createNoopLogger();
  }

  async run<T>(provider: ProviderName, operation: () => Promise<T>): Promise<T> {
    const limiter = this.limiters.get(provider);
    if (!limiter) {
      return retryProviderOperation(operation, {
        provider,
        ...this.retry,
        logger: this.logger
      });
    }

    return limiter.schedule(() => retryProviderOperation(operation, {
      provider,
      ...this.retry,
      logger: this.logger
    }));
  }

  async runOnce<T>(provider: ProviderName, operation: () => Promise<T>): Promise<T> {
    const limiter = this.limiters.get(provider);
    if (!limiter) return operation();
    return limiter.schedule(operation);
  }

  async close(): Promise<void> {
    const uniqueLimiters = new Set(this.limiters.values());
    await Promise.all([...uniqueLimiters].map((limiter) => limiter.stop()));
  }
}

export function createDefaultProviderLimiters(): ReadonlyMap<ProviderName, ProviderRateLimiter> {
  return new Map<ProviderName, ProviderRateLimiter>([
    ['clerk', new BottleneckProviderRateLimiter({ maxConcurrent: 2, minTimeMs: 100 })],
    ['crossref', new BottleneckProviderRateLimiter({ maxConcurrent: 1, minTimeMs: 500 })],
    ['zenodo', new BottleneckProviderRateLimiter({ maxConcurrent: 1, minTimeMs: 500 })],
    ['zotero', new BottleneckProviderRateLimiter({ maxConcurrent: 2, minTimeMs: 250 })]
  ]);
}
