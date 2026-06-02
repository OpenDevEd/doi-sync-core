import Bottleneck from 'bottleneck';

export interface ProviderRateLimiter {
  readonly schedule: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly stop: () => Promise<void>;
}

export interface CreateProviderRateLimiterInput {
  readonly maxConcurrent: number;
  readonly minTimeMs: number;
}

export class BottleneckProviderRateLimiter implements ProviderRateLimiter {
  private readonly limiter: Bottleneck;

  constructor(input: CreateProviderRateLimiterInput) {
    this.limiter = new Bottleneck({
      maxConcurrent: input.maxConcurrent,
      minTime: input.minTimeMs
    });
  }

  async schedule<T>(operation: () => Promise<T>): Promise<T> {
    return this.limiter.schedule(operation);
  }

  async stop(): Promise<void> {
    await this.limiter.stop({ dropWaitingJobs: false });
  }
}
