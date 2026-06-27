/**
 * Lead Dedicated Queue
 *
 * A standalone BullMQ queue + worker exclusively for lead insert/update jobs
 * arriving via the API key path (POST/PUT /api/leads).
 *
 * All tuning knobs are driven by environment variables so they can be
 * adjusted per deployment without touching code (see .env.*).
 *
 * ── Queue config ────────────────────────────────────────────────────────────
 *   LEAD_QUEUE_CONCURRENCY            concurrent jobs per worker            (default: 5)
 *   LEAD_QUEUE_ACCT_RATE_LIMIT_MAX    max jobs per window per acctId        (default: 100)
 *   LEAD_QUEUE_ACCT_RATE_LIMIT_WINDOW_MS  window duration in ms            (default: 60000 = 60s)
 *   LEAD_QUEUE_JOB_ATTEMPTS           retry attempts on failure             (default: 3)
 *   LEAD_QUEUE_BACKOFF_DELAY_MS       initial exponential backoff delay ms  (default: 1000)
 *
 * ── Retention config ────────────────────────────────────────────────────────
 *   LEAD_QUEUE_COMPLETED_AGE_S        seconds to keep completed jobs        (default: 3600  = 1h)
 *   LEAD_QUEUE_COMPLETED_COUNT        max completed jobs to keep            (default: 1000)
 *   LEAD_QUEUE_FAILED_AGE_S           seconds to keep failed jobs           (default: 86400 = 24h)
 *
 * ── Guardrail ───────────────────────────────────────────────────────────────
 * Rate limiting is enforced PER acctId (groupKey = 'acctId').
 * Default: each account can create/update at most 100 leads every 60 seconds.
 * A burst from one account never delays jobs belonging to another.
 */
import { addJob, createWorker, getQueueStats } from '../config/queueManager.js';
import { eventType, processor } from './leadProcessor.js';
import logger from '../utils/logger.js';

const appAcct = process.env.APP_ACCT || 'development';
export const QUEUE_NAME = `lead-queue-${appAcct}`;

// ---------------------------------------------------------------------------
// Config — all values driven by environment variables
// ---------------------------------------------------------------------------
const CONCURRENCY         = parseInt(process.env.LEAD_QUEUE_CONCURRENCY                ?? '5',     10);
const RATE_LIMIT_MAX      = parseInt(process.env.LEAD_QUEUE_ACCT_RATE_LIMIT_MAX        ?? '100',   10);
const RATE_LIMIT_DURATION = parseInt(process.env.LEAD_QUEUE_ACCT_RATE_LIMIT_WINDOW_MS  ?? '60000', 10);
const JOB_ATTEMPTS        = parseInt(process.env.LEAD_QUEUE_JOB_ATTEMPTS               ?? '3',     10);
const BACKOFF_DELAY       = parseInt(process.env.LEAD_QUEUE_BACKOFF_DELAY_MS           ?? '1000',  10);

// Retention
const COMPLETED_AGE_S   = parseInt(process.env.LEAD_QUEUE_COMPLETED_AGE_S   ?? '3600',  10);
const COMPLETED_COUNT   = parseInt(process.env.LEAD_QUEUE_COMPLETED_COUNT   ?? '1000',  10);
const FAILED_AGE_S      = parseInt(process.env.LEAD_QUEUE_FAILED_AGE_S      ?? '86400', 10);

// ---------------------------------------------------------------------------
// Job options — applied to every lead job added to this queue
// ---------------------------------------------------------------------------
const JOB_OPTIONS = {
  attempts: JOB_ATTEMPTS,
  backoff: {
    type: 'exponential',
    delay: BACKOFF_DELAY
  },
  removeOnComplete: {
    age: COMPLETED_AGE_S,
    count: COMPLETED_COUNT
  },
  removeOnFail: {
    age: FAILED_AGE_S
  }
};

// ---------------------------------------------------------------------------
// Worker options — guardrail enforced per acctId
// ---------------------------------------------------------------------------
const WORKER_OPTIONS = {
  concurrency: CONCURRENCY,
  limiter: {
    max: RATE_LIMIT_MAX,
    duration: RATE_LIMIT_DURATION,
    // Each account gets its own independent token bucket.
    // A burst from one account never delays jobs of another.
    groupKey: 'acctId'
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a lead insert/update job.
 * Called by the controller immediately after responding 202 to the API caller.
 *
 * @param {Object} jobData   - { acctId, leadPayload, collection, mergeProperties }
 * @param {Object} [options] - Optional BullMQ job overrides (jobId, priority, delay …)
 * @returns {Promise<import('bullmq').Job>}
 */
export const addToQueue = async (jobData, options = {}) => {
  const jobId = options.jobId || `${eventType}-${jobData.acctId || 'na'}-${Date.now()}`;
  return addJob(
    QUEUE_NAME,
    eventType,
    { ...jobData, eventType },
    { ...JOB_OPTIONS, jobId, ...options }
  );
};

/**
 * Start the lead queue worker.
 * Call once during server startup — never per-request.
 * @returns {import('bullmq').Worker}
 */
export const initializeWorker = () => {
  logger.info(
    `[LeadQueue] Starting worker | queue=${QUEUE_NAME} | concurrency=${CONCURRENCY} | rateLimit=${RATE_LIMIT_MAX}/${RATE_LIMIT_DURATION}ms per acctId`
  );
  return createWorker(QUEUE_NAME, processor, WORKER_OPTIONS);
};

/**
 * Return health stats for the lead queue — used by the /health endpoint.
 * @returns {Promise<Object>}
 */
export const getHealth = async () => {
  try {
    const stats = await getQueueStats(QUEUE_NAME);
    return {
      success: true,
      queue: QUEUE_NAME,
      status: 'operational',
      config: {
        concurrency: CONCURRENCY,
        rateLimitMax: RATE_LIMIT_MAX,
        rateLimitDurationMs: RATE_LIMIT_DURATION,
        jobAttempts: JOB_ATTEMPTS,
        backoffDelayMs: BACKOFF_DELAY,
        completedRetentionS: COMPLETED_AGE_S,
        completedRetentionCount: COMPLETED_COUNT,
        failedRetentionS: FAILED_AGE_S
      },
      stats
    };
  } catch (error) {
    logger.error(`[LeadQueue] Health check failed: ${error.message}`);
    return {
      success: false,
      queue: QUEUE_NAME,
      status: 'unavailable',
      error: error.message
    };
  }
};
