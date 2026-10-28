/**
 * Spaces requests out so we never send faster than the CRM allows.
 *
 * The CRM allows 100 requests per minute. We default to 90 - about 10% headroom
 * for timing drift between our clock and the CRM's, retries, and any other
 * systems sharing the same CRM limit. If a 429 still happens, the processor
 * honours Retry-After as a second line of defence.
 */
export class RateLimiter {
  private nextSlot = 0;
  private readonly intervalMs: number;

  constructor(requestsPerMinute: number) {
    this.intervalMs = requestsPerMinute > 0 ? 60_000 / requestsPerMinute : 0;
  }

  /** Wait until we are allowed to send the next request. */
  async acquire(): Promise<void> {
    if (this.intervalMs === 0) return; // disabled (used in one demo scenario)
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
