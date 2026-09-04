import LeadExport from '../models/leadExportModel.js';
import { createExport, openDownload, publicExport } from '../services/exportService.js';
import { cancelExport, enqueueExport } from '../queue/exportQueue.js';

const scope = req => ({
    acctId: req.tenant.acctId,
    userId: String(req.user.userId),
    accessLevel: req.user.accessLevel
});

const findScoped = req => LeadExport.findOne({
    _id: req.params.id,
    acctId: req.tenant.acctId,
    userId: String(req.user.userId)
});

const sendError = (res, error) => res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode ? error.message : 'Export operation failed'
});

export const create = async (req, res) => {
    let doc;
    try {
        doc = await createExport(req.body, scope(req));
        await enqueueExport(doc);
        return res.status(202).json({ success: true, data: publicExport(doc) });
    } catch (error) {
        if (doc) await LeadExport.updateOne({ _id: doc._id }, { status: 'failed', active: false, error: 'Unable to queue export' });
        return sendError(res, error);
    }
};

export const status = async (req, res) => {
    try {
        const doc = await findScoped(req).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Export not found' });
        return res.json({ success: true, data: publicExport(doc) });
    } catch (error) { return sendError(res, error); }
};

export const cancel = async (req, res) => {
    try {
        const doc = await findScoped(req);
        if (!doc) return res.status(404).json({ success: false, message: 'Export not found' });
        if (!['queued', 'running'].includes(doc.status)) return res.status(409).json({ success: false, message: `Cannot cancel a ${doc.status} export` });
        await cancelExport(doc);
        const updated = await findScoped(req).lean();
        return res.json({ success: true, data: publicExport(updated) });
    } catch (error) { return sendError(res, error); }
};

export const download = async (req, res) => {
    try {
        const doc = await findScoped(req);
        if (!doc) return res.status(404).json({ success: false, message: 'Export not found' });
        const stream = await openDownload(doc);
        res.setHeader('Content-Type', doc.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName.replaceAll('"', '')}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        stream.on('error', error => { if (!res.headersSent) sendError(res, error); else res.destroy(error); });
        stream.pipe(res);
    } catch (error) { if (!res.headersSent) return sendError(res, error); }
};

export default { create, status, cancel, download };
