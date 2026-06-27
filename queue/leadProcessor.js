/**
 * Lead Queue Processor
 *
 * Consumed by the BullMQ worker in leadQueue.js.
 * Each job carries the full context needed to call leadService.createLead()
 * so the worker is completely self-contained and needs no HTTP context.
 *
 * Expected job.data shape:
 * {
 *   eventType       : 'lead-upsert'
 *   acctId          : string   — authenticated account id
 *   leadPayload     : object | object[]  — lead field data (collection already stripped)
 *   collection      : string | null      — resolved collection name
 *   mergeProperties : string[] | null    — fields used as merge key for upsert
 * }
 */
import leadService from '../services/leadService.js';
import logger from '../utils/logger.js';

export const eventType = 'lead-upsert';

/**
 * Process a single lead-upsert job.
 * Throws on failure so BullMQ can apply the configured retry / backoff policy.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<{ leadId: string|string[] }>}
 */
export const processor = async (job) => {
  const { acctId, leadPayload, collection, mergeProperties } = job.data;

  logger.info(`[LeadProcessor] Job [${job.id}] | acctId=${acctId} | collection=${collection ?? 'default'} | attempt=${job.attemptsMade + 1}`);

  try {
    const result = await leadService.createLead(leadPayload, acctId, collection, mergeProperties);

    // Normalise the lead result to an id or array of ids for the job return value
    const leadId = Array.isArray(result.lead)
      ? result.lead.map(l => l._id?.toString())
      : result.lead?._id?.toString();

    logger.info(`[LeadProcessor] Job [${job.id}] succeeded | acctId=${acctId} | leadId=${JSON.stringify(leadId)}`);

    return { leadId };
  } catch (error) {
    logger.error(`[LeadProcessor] Job [${job.id}] failed | acctId=${acctId} | error=${error.message}`);
    // Re-throw so BullMQ increments the attempt counter and schedules a retry
    throw error;
  }
};
