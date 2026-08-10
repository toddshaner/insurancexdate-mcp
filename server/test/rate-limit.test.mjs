/**
 * Unit tests for the token-bucket limiter (src/rate-limit.ts, built to
 * dist/). Injected clock — no timers, no network.
 *
 * Run from server/: npm test (builds first), or node --test test/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRateLimit, requestCost, RateLimiter } from "../dist/rate-limit.js";

function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advanceMs = (ms) => {
    t += ms;
  };
  return now;
}

test("blocks after the per-minute limit is spent, refills over time", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(3, 10, clock);
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), false, "4th request in the same instant must be denied");
  clock.advanceMs(20_000); // 1/3 of a minute at limit 3 -> one token back
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), false);
});

test("limit 0 disables limiting", () => {
  const limiter = new RateLimiter(0, 10, fakeClock());
  for (let i = 0; i < 100; i++) assert.equal(limiter.allow("k"), true);
});

test("keys are limited independently", () => {
  const limiter = new RateLimiter(1, 10, fakeClock());
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("b"), true);
  assert.equal(limiter.allow("a"), false);
});

test("cost > 1 charges the batch, not one token", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(5, 10, clock);
  assert.equal(limiter.allow("k", 3), true);
  assert.equal(limiter.allow("k", 3), false, "only 2 tokens left, batch of 3 denied");
  assert.equal(limiter.allow("k", 2), true);
  assert.equal(limiter.allow("k"), false);
});

test("a batch larger than the whole per-minute limit is always denied", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(5, 10, clock);
  assert.equal(limiter.allow("k", 6), false);
  clock.advanceMs(600_000);
  assert.equal(limiter.allow("k", 6), false, "no amount of waiting satisfies cost > limit");
});

test("bucket map never exceeds maxBuckets, even when every bucket is active", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(60, 100, clock);
  for (let i = 0; i < 500; i++) {
    clock.advanceMs(1); // strictly increasing `last`, no bucket ever idle-refills
    limiter.allow(`key-${i}`);
    assert.ok(limiter.trackedBuckets <= 100, `size ${limiter.trackedBuckets} at insert ${i}`);
  }
  assert.equal(limiter.trackedBuckets, 100);
});

test("idle buckets are evicted before active ones", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(60, 3, clock);
  limiter.allow("idle");
  clock.advanceMs(120_000); // "idle" fully refills -> evictable without losing state
  limiter.allow("active-1");
  limiter.allow("active-2");
  limiter.allow("active-2"); // spend active-2 down so it is clearly not idle
  limiter.allow("new-key"); // at cap: should evict "idle", keep both active buckets
  assert.equal(limiter.trackedBuckets, 3);
  // active-2 keeps its spent state: it has 58 tokens left, not a fresh 60.
  for (let i = 0; i < 58; i++) assert.equal(limiter.allow("active-2"), true);
  assert.equal(limiter.allow("active-2"), false, "eviction must not have reset active-2");
});

test("parseRateLimit accepts non-negative numbers, rejects everything else", () => {
  assert.equal(parseRateLimit("60"), 60);
  assert.equal(parseRateLimit(" 0 "), 0);
  assert.equal(parseRateLimit("2.5"), 2.5);
  assert.equal(parseRateLimit(""), null);
  assert.equal(parseRateLimit("   "), null);
  assert.equal(parseRateLimit("abc"), null);
  assert.equal(parseRateLimit("-1"), null);
  assert.equal(parseRateLimit("Infinity"), null);
  assert.equal(parseRateLimit("NaN"), null);
});

test("requestCost charges one per JSON-RPC request in a batch", () => {
  assert.equal(requestCost({ jsonrpc: "2.0", method: "tools/call" }), 1);
  assert.equal(requestCost([{}, {}, {}]), 3);
  assert.equal(requestCost([]), 1);
  assert.equal(requestCost(null), 1);
});
