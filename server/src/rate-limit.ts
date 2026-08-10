/**
 * Token-bucket rate limiting for the remote HTTP entrypoint (http.ts).
 *
 * Extracted into its own module so the eviction and charging logic is unit
 * testable with an injected clock. State is per-process — good enough for a
 * single-instance deployment; a horizontally scaled fleet multiplies the
 * effective limit by the instance count.
 */

export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
// Host-wide backstop defaults to this multiple of the per-key limit: enough
// headroom for many concurrent legitimate callers, low enough that a flood
// of fabricated keys can't fan out into unbounded upstream traffic.
export const GLOBAL_RATE_LIMIT_MULTIPLIER = 10;
export const MAX_TRACKED_BUCKETS = 10_000;

export type Clock = () => number;

type Bucket = { tokens: number; last: number };

/**
 * Parses a rate-limit env value. Returns null for anything that is not a
 * finite non-negative number (including blank), so callers can fail closed
 * instead of letting NaN flow into comparisons where it never blocks.
 */
export function parseRateLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Tokens a request must pay: one per JSON-RPC request it carries. A batch
 * array is N requests, not one — otherwise batching would let a caller run
 * many tools/call executions per charged token.
 */
export function requestCost(body: unknown): number {
  return Array.isArray(body) ? Math.max(1, body.length) : 1;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limitPerMin: number,
    private readonly maxBuckets: number = MAX_TRACKED_BUCKETS,
    private readonly now: Clock = () => performance.now(),
  ) {}

  /** Number of tracked buckets; guaranteed <= maxBuckets. Exposed for tests. */
  get trackedBuckets(): number {
    return this.buckets.size;
  }

  /**
   * Charges `cost` tokens against `id`'s bucket; false = over the limit.
   * A cost larger than the per-minute limit can never be satisfied and is
   * always denied. limitPerMin <= 0 disables limiting entirely.
   */
  allow(id: string, cost = 1): boolean {
    if (this.limitPerMin <= 0) return true;
    const now = this.now();
    let bucket = this.buckets.get(id);
    if (!bucket) {
      this.evictForInsert(now);
      bucket = { tokens: this.limitPerMin, last: now };
      this.buckets.set(id, bucket);
    }
    bucket.tokens = this.refilled(bucket, now);
    bucket.last = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  private refilled(bucket: Bucket, now: number): number {
    return Math.min(this.limitPerMin, bucket.tokens + ((now - bucket.last) / 60_000) * this.limitPerMin);
  }

  /**
   * Makes room for one new bucket when at capacity. Prefers buckets that
   * would be full after refill (idle for at least a full refill period —
   * dropping them loses no throttling state). If every bucket is active,
   * evicts the least-recently-used so the map can NEVER exceed maxBuckets,
   * even under a flood of distinct ids.
   */
  private evictForInsert(now: number): void {
    if (this.buckets.size < this.maxBuckets) return;
    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.limitPerMin) {
        this.buckets.delete(key);
        if (this.buckets.size < this.maxBuckets) return;
      }
    }
    while (this.buckets.size >= this.maxBuckets) {
      let lruKey: string | undefined;
      let lruLast = Infinity;
      for (const [key, bucket] of this.buckets) {
        if (bucket.last < lruLast) {
          lruLast = bucket.last;
          lruKey = key;
        }
      }
      if (lruKey === undefined) return;
      this.buckets.delete(lruKey);
    }
  }
}
