import { AppError } from './errors.ts';

/** Bounded concurrency with a bounded queue, so a flood of requests cannot exhaust memory. */
export class Semaphore {
  private available: number;
  private readonly maxQueue: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number, maxQueue: number) {
    if (!Number.isInteger(permits) || permits < 1) throw new RangeError('permits must be >= 1');
    this.available = permits;
    this.maxQueue = maxQueue;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) {
      throw new AppError(503, 'server_busy', 'The server is busy. Try again shortly.', {
        headers: { 'Retry-After': '2' },
      });
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}
