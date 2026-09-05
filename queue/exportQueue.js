import { addJob, createWorker, getQueue, getQueueStats } from '../config/queueManager.js';
import LeadExport from '../models/leadExportModel.js';
import { processor } from './exportProcessor.js';
import logger from '../utils/logger.js';

const appAcct = process.env.APP_ACCT || 'development';
export const QUEUE_NAME = `export-queue-${appAcct}`;
const concurrency = Number.parseInt(process.env.EXPORT_QUEUE_CONCURRENCY || '2', 10);

export const enqueueExport = exportDoc => addJob(QUEUE_NAME, 'generate-export', {
    exportId: exportDoc._id, acctId: exportDoc.acctId
}, {
    jobId: `export-${exportDoc._id}`,
    attempts: 1,
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 7 * 86400 }
});

export const cancelExport = async (exportDoc) => {
    await LeadExport.updateOne({ _id: exportDoc._id, active: true }, { cancelRequested: true });
    const job = await getQueue(QUEUE_NAME).getJob(`export-${exportDoc._id}`);
    if (job && ['waiting', 'delayed', 'prioritized'].includes(await job.getState())) {
        await job.remove();
        await LeadExport.updateOne(
            { _id: exportDoc._id, status: 'queued' },
            { status: 'cancelled', active: false, completedAt: new Date() }
        );
    }
};

export const removeExportJobs = async (exportDoc) => {
    await cancelExport(exportDoc);
    const queue = getQueue(QUEUE_NAME);
    for (const jobId of [`export-${exportDoc._id}`, `cleanup-${exportDoc._id}`]) {
        const job = await queue.getJob(jobId);
        if (job && await job.getState() !== 'active') await job.remove().catch(() => {});
    }
};

export const initializeWorker = () => {
    logger.info(`[ExportQueue] Starting worker | queue=${QUEUE_NAME} | concurrency=${concurrency}`);
    return createWorker(QUEUE_NAME, processor, { concurrency, limiter: undefined });
};

export const getHealth = async () => {
    try { return { success: true, status: 'operational', ...(await getQueueStats(QUEUE_NAME)) }; }
    catch (error) { return { success: false, status: 'unavailable', error: error.message }; }
};
