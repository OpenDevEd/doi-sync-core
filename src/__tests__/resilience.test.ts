import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderHttpError,
  isRetryableHttpStatus,
  retryAfterMsFromHeaders
} from '../resilience/errors.js';
import { DirectProviderOperationRunner, ResilientProviderOperationRunner, type ProviderOperationRunner } from '../resilience/provider-runner.js';
import { retryProviderOperation } from '../resilience/retry.js';
import type { ProviderRateLimiter } from '../resilience/rate-limit.js';

class RecordingLimiter implements ProviderRateLimiter {
  readonly providers: string[] = [];

  constructor(private readonly provider: string) {}

  async schedule<T>(operation: () => Promise<T>): Promise<T> {
    this.providers.push(this.provider);
    return operation();
  }

  stop(): Promise<void> {
    this.providers.push(`${this.provider}:stopped`);
    return Promise.resolve();
  }
}

describe('provider resilience', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies transient provider HTTP statuses as retryable', () => {
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(409)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it('parses Retry-After seconds', () => {
    expect(retryAfterMsFromHeaders({ get: () => '1.5' })).toBe(1_500);
  });

  it('parses Retry-After dates and clamps dates in the past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'));

    expect(retryAfterMsFromHeaders({
      get: () => 'Wed, 12 Aug 2026 00:01:00 GMT'
    })).toBe(60_000);
    expect(retryAfterMsFromHeaders({
      get: () => 'Tue, 11 Aug 2026 23:59:00 GMT'
    })).toBe(0);
  });

  it('ignores missing, invalid, and negative Retry-After values', () => {
    expect(retryAfterMsFromHeaders(undefined)).toBeUndefined();
    expect(retryAfterMsFromHeaders({ get: () => null })).toBeUndefined();
    expect(retryAfterMsFromHeaders({ get: () => 'not-a-delay' })).toBeUndefined();
    expect(retryAfterMsFromHeaders({ get: () => '-10' })).toBeUndefined();
  });

  it('retries retryable provider errors and returns the eventual result', async () => {
    let attempts = 0;

    await expect(retryProviderOperation((): Promise<string> => {
      attempts += 1;
      if (attempts < 3) {
        throw new ProviderHttpError({
          provider: 'zenodo',
          status: 503,
          body: 'temporarily unavailable'
        });
      }
      return Promise.resolve('ok');
    }, {
      provider: 'zenodo',
      retries: 3,
      minTimeoutMs: 0,
      maxTimeoutMs: 0,
      randomize: false
    })).resolves.toBe('ok');

    expect(attempts).toBe(3);
  });

  it('does not retry permanent provider errors', async () => {
    let attempts = 0;

    await expect(retryProviderOperation((): Promise<never> => {
      attempts += 1;
      throw new ProviderHttpError({
        provider: 'zenodo',
        status: 401,
        body: 'bad token'
      });
    }, {
      provider: 'zenodo',
      retries: 3,
      minTimeoutMs: 0,
      maxTimeoutMs: 0,
      randomize: false
    })).rejects.toMatchObject({
      provider: 'zenodo',
      status: 401,
      retryable: false
    });

    expect(attempts).toBe(1);
  });

  it('does not retry ordinary coding errors', async () => {
    let attempts = 0;

    await expect(retryProviderOperation((): Promise<never> => {
      attempts += 1;
      throw new TypeError('bad local shape');
    }, {
      provider: 'zenodo',
      retries: 3,
      minTimeoutMs: 0,
      maxTimeoutMs: 0,
      randomize: false
    })).rejects.toThrow('bad local shape');

    expect(attempts).toBe(1);
  });

  it('retries fetch-level network failures without retrying arbitrary TypeErrors', async () => {
    let attempts = 0;

    await expect(retryProviderOperation((): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      return Promise.resolve('ok');
    }, {
      provider: 'zenodo',
      retries: 2,
      minTimeoutMs: 0,
      maxTimeoutMs: 0,
      randomize: false
    })).resolves.toBe('ok');

    expect(attempts).toBe(2);
  });

  it('honors provider Retry-After delays before retrying', async () => {
    vi.useFakeTimers();
    let attempts = 0;

    const result = retryProviderOperation((): Promise<string> => {
      attempts += 1;
      if (attempts === 1) {
        throw new ProviderHttpError({
          provider: 'crossref',
          status: 429,
          body: 'slow down',
          retryAfterMs: 60_000
        });
      }
      return Promise.resolve('ok');
    }, {
      provider: 'crossref',
      retries: 1,
      minTimeoutMs: 0,
      maxTimeoutMs: 0,
      randomize: false
    });

    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });

  it('runs provider operations through the configured limiter before retrying', async () => {
    const zenodoLimiter = new RecordingLimiter('zenodo');
    const runner: ProviderOperationRunner = new ResilientProviderOperationRunner({
      limiters: new Map([['zenodo', zenodoLimiter]]),
      retry: {
        retries: 0,
        minTimeoutMs: 0,
        maxTimeoutMs: 0,
        randomize: false
      }
    });

    await expect(runner.run('zenodo', () => Promise.resolve(42))).resolves.toBe(42);
    await runner.close();

    expect(zenodoLimiter.providers).toEqual(['zenodo', 'zenodo:stopped']);
  });

  it('lets consumers name and limit services outside the publication providers', async () => {
    const zoteroLimiter = new RecordingLimiter('zotero');
    const runner: ProviderOperationRunner = new ResilientProviderOperationRunner({
      limiters: new Map([['zotero', zoteroLimiter]]),
      retry: {
        retries: 0,
        minTimeoutMs: 0,
        maxTimeoutMs: 0,
        randomize: false
      }
    });

    await expect(runner.run('zotero', () => Promise.resolve('read'))).resolves.toBe('read');
    await runner.close();

    expect(zoteroLimiter.providers).toEqual(['zotero', 'zotero:stopped']);
  });

  it('keeps a direct operation runner for unit tests and dry wiring checks', async () => {
    const runner = new DirectProviderOperationRunner();

    await expect(runner.run('crossref', () => Promise.resolve('done'))).resolves.toBe('done');
    await expect(runner.close()).resolves.toBeUndefined();
  });
});
