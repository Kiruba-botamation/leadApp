import LeadExport from '../models/leadExportModel.js';
import { addJob } from '../config/queueManager.js';
import { deleteStoredExport, runExport } from '../services/exportService.js';

const appAcct = process.env.APP_ACCT || 'development';
const queueName = `export-queue-${appAcct}`;

export const processor = async (job) => {
    if (job.name === 'cleanup-export') {
        const doc = await LeadExport.findOne({ _id: job.data.exportId, status: 'completed' });
        if (!doc) return;
        await deleteStoredExport(doc);
        await LeadExport.updateOne({ _id: doc._id, status: 'completed' }, { status: 'expired' });
        return;
    }

    const result = await runExport(job.data.exportId);
    if (result?.expiresAt) {
        await addJob(queueName, 'cleanup-export', { exportId: job.data.exportId }, {
            jobId: `cleanup-${job.data.exportId}`,
            delay: Math.max(0, result.expiresAt.getTime() - Date.now()),
            attempts: 5,
            removeOnComplete: true
        });
    }
};
