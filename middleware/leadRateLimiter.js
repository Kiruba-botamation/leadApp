/**
 * Lead API — HTTP-level rate limiter (per acctId, Redis sliding window)
 *
 * Applied on the API key path only: POST/PUT /api/leads
 * The SSO/UI path (/api/ui/leads) is NOT rate-limited here — it goes
 * straight to the synchronous service and is protected by SSO session controls.
 *
 * Algorithm: Redis INCR + EXPIRE (atomic via MULTI/EXEC)
 *   - First request in a window sets the key and starts the TTL.
 *   - Each subsequent request increments the counter.
 *   - Once the counter exceeds the limit, requests are rejected with 429.
 *   - The window is fixed (not sliding), resetting when the Redis TTL expires.
 *
 * Environment variables (see .env.*):
 *   LEAD_RATE_LIMIT_MAX        max requests per window per acctId  (default: 100)
 *   LEAD_RATE_LIMIT_WINDOW_S   window size in seconds              (default: 60)
 *   LEAD_RATE_LIMIT_FAIL_OPEN  allow through if Redis is down      (default: true)
 */
import logger from '../utils/logger.js';
import { checkRateLimit } from '../utils/rateLimit.js';

// ---------------------------------------------------------------------------
// Config — driven entirely by environment variables
// ---------------------------------------------------------------------------
const MAX_REQUESTS = parseInt(process.env.LEAD_RATE_LIMIT_MAX ?? '100', 10);
const WINDOW_S = parseInt(process.env.LEAD_RATE_LIMIT_WINDOW_S ?? '60', 10);
// failOpen=true means: if Redis is unavailable, let the request through rather
// than blocking legitimate traffic. Set to false for stricter enforcement.
const FAIL_OPEN = (process.env.LEAD_RATE_LIMIT_FAIL_OPEN ?? 'true') !== 'false';
const REDIS_OP_TIMEOUT_MS = parseInt(process.env.LEAD_RATE_LIMIT_REDIS_TIMEOUT_MS ?? '1500', 10);

const KEY_PREFIX = 'ratelimit:lead:acct:';

/**
 * Express middleware — rejects requests over LEAD_RATE_LIMIT_MAX per LEAD_RATE_LIMIT_WINDOW_S
 * seconds for the authenticated acctId.
 *
 * Must be placed AFTER apiKeyAuthMiddleware so req.acctId is already set.
 *
 * Response headers on every request:
 *   X-RateLimit-Limit     — configured max
 *   X-RateLimit-Remaining — requests left in the current window
 *   X-RateLimit-Reset     — Unix timestamp (seconds) when the window resets
 *
 * On limit exceeded → 429 JSON:
 *   { success: false, message: '...', retryAfter: <seconds> }
 */
const leadRateLimiter = async (req, res, next) => {
  // Allow trusted callers to bypass rate limiting when explicitly requested.
  const skipLimitHeader = req.get('skip-limit');
  if (typeof skipLimitHeader === 'string' && skipLimitHeader.toLowerCase() === 'true') {
    logger.info('[LeadRateLimit] Bypassed via skip-limit header');
    return next();
  }

  // acctId is guaranteed to be set by apiKeyAuthMiddleware upstream
  const acctId = req.acctId;

  if (!acctId) {
    // Should never reach here — apiKeyAuthMiddleware rejects before us
    return res.status(400).json({ success: false, message: 'acctId is required for rate limiting' });
  }

  const { allowed, limit, remaining, resetAt, retryAfter, degraded } = await checkRateLimit(acctId, {
    max: MAX_REQUESTS,
    windowS: WINDOW_S,
    keyPrefix: KEY_PREFIX,
    failOpen: FAIL_OPEN,
    timeoutMs: REDIS_OP_TIMEOUT_MS
  });

  // Redis down + fail-closed → reject with 503 rather than 429.
  if (degraded && !allowed) {
    return res.status(503).json({
      success: false,
      message: 'Rate limiting service temporarily unavailable. Please retry.'
    });
  }

  // Always send rate limit headers so callers can self-throttle.
  res.set({
    'X-RateLimit-Limit': limit,
    'X-RateLimit-Remaining': remaining,
    'X-RateLimit-Reset': resetAt
  });

  if (!allowed) {
    logger.warn(`[LeadRateLimit] acctId=${acctId} exceeded ${MAX_REQUESTS} req/${WINDOW_S}s | retryAfter=${retryAfter}s`);
    return res.status(429).json({
      success: false,
      message: `Rate limit exceeded: max ${MAX_REQUESTS} lead requests per ${WINDOW_S} seconds per account.`,
      retryAfter
    });
  }

  next();
};

export default leadRateLimiter;
