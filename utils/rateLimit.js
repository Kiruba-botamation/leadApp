/**
 * Shared per-account rate limiter (Redis fixed-window via INCR + EXPIRE).
 *
 * Used by both the HTTP lead API (middleware/leadRateLimiter.js) and the MCP
 * endpoint (mcp/leadAppMcpServer.js) so there is a single implementation.
 *
 * Algorithm: atomic INCR + TTL in one round-trip.
 *   - First request in a window sets the key and starts the TTL.
 *   - Each subsequent request increments the counter.
 *   - Once the counter exceeds `max`, requests are rejected until the TTL expires.
 *   - The window is fixed (not sliding), resetting when the Redis TTL expires.
 *
 * Fail-open: when Redis is unavailable, `allowed` is true (configurable) so a
 * Redis outage never blocks all legitimate traffic.
 */
import { getRedisConnection } from '../config/redisConnector.js';
import logger from '../utils/logger.js';

const withTimeout = (promise, timeoutMs, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
]);

/**
 * Check (and consume) one unit of an account's rate-limit budget.
 *
 * @param {string} acctId
 * @param {object} opts
 * @param {number} opts.max          max requests per window per acctId
 * @param {number} opts.windowS      window size in seconds
 * @param {string} opts.keyPrefix    Redis key prefix, e.g. 'ratelimit:lead:acct:'
 * @param {boolean} [opts.failOpen]  allow through if Redis is down (default true)
 * @param {number} [opts.timeoutMs]  per-op Redis timeout (default 1500ms)
 * @returns {Promise<{allowed:boolean, limit:number, remaining:number, resetAt:number, retryAfter:number, degraded?:boolean}>}
 */
export async function checkRateLimit(acctId, { max, windowS, keyPrefix, failOpen = true, timeoutMs = 1500 }) {
  const key = `${keyPrefix}${acctId}`;

  try {
    const redis = getRedisConnection();

    if (redis.status !== 'ready') {
      await withTimeout(redis.connect(), timeoutMs, `Redis connect timed out after ${timeoutMs}ms`);
    }

    const multi = redis.multi();
    multi.incr(key);
    multi.ttl(key);
    const results = await withTimeout(multi.exec(), timeoutMs, `Redis rate-limit command timed out after ${timeoutMs}ms`);

    const currentCount = results[0][1];
    const ttl = results[1][1];

    // First request in this window — set the expiry.
    if (ttl === -1) {
      await redis.expire(key, windowS);
    }

    const effectiveTtl = ttl > 0 ? ttl : windowS;
    const resetAt = Math.ceil(Date.now() / 1000) + effectiveTtl;
    const remaining = Math.max(0, max - currentCount);
    const allowed = currentCount <= max;

    return { allowed, limit: max, remaining, resetAt, retryAfter: effectiveTtl };
  } catch (error) {
    logger.error(`[RateLimit] Redis error for ${key}: ${error.message}`);
    if (failOpen) {
      logger.warn(`[RateLimit] Failing open for ${key} — Redis unavailable`);
      return { allowed: true, limit: max, remaining: max, resetAt: Math.ceil(Date.now() / 1000) + windowS, retryAfter: windowS, degraded: true };
    }
    return { allowed: false, limit: max, remaining: 0, resetAt: Math.ceil(Date.now() / 1000) + windowS, retryAfter: windowS, degraded: true };
  }
}
