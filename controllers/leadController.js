import leadService from '../services/leadService.js';
import { addToQueue } from '../queue/leadQueue.js';

const QUEUE_ENQUEUE_TIMEOUT_MS = parseInt(process.env.LEAD_QUEUE_ENQUEUE_TIMEOUT_MS ?? '3000', 10);

const withTimeout = (promise, ms, message) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);

class LeadController {
    async _resolveAcctId(req) {
        return req.tenant?.acctId || req.acctId || null;
    }

    /**
     * Create lead(s).
     * POST /api/leads[/:collection]       — API key path → queued  (202)
     * POST /api/ui/leads[/:collection]    — SSO path     → sync    (201)
     */
    async createLead(req, res) {
        try {
            const data = req.body?.data;
            if (!data || (Array.isArray(data) && data.length === 0)) {
                return res.status(400).json({ success: false, message: 'data is required' });
            }

            const acctId = await this._resolveAcctId(req);
            if (!acctId) {
                return res.status(400).json({ success: false, message: 'Authenticated account context is required' });
            }

            const collection = req.params.collection || null;
            const mergeProperties = req.body?.config?.merge?.properties ?? null;

            // Strip routing-only fields from the payload
            const stripMeta = (item) => {
                const { collection: _c, acctId: _a, acctNo: _n, ...rest } = item;
                return rest;
            };
            const leadPayload = Array.isArray(data) ? data.map(stripMeta) : stripMeta(data);

            const isApiKeyRequest = !req.user && !!req.acctId;

            if (isApiKeyRequest) {
                try {
                    const job = await withTimeout(
                        addToQueue({ acctId, leadPayload, collection, mergeProperties }),
                        QUEUE_ENQUEUE_TIMEOUT_MS,
                        `Queue enqueue timed out after ${QUEUE_ENQUEUE_TIMEOUT_MS}ms`
                    );
                    return res.status(202).json({
                        success: true,
                        message: Array.isArray(leadPayload)
                            ? `${leadPayload.length} lead(s) queued for processing`
                            : 'Lead queued for processing',
                        jobId: job.id
                    });
                } catch (queueError) {
                    console.warn('[LeadController] Queue unavailable, processing synchronously:', queueError.message);
                    // Fall through to synchronous create below
                }
            }

            // Synchronous create (SSO path, or API key with queue unavailable)
            const result = await leadService.createLead(leadPayload, acctId, collection, mergeProperties);

            return res.status(201).json({
                success: true,
                message: Array.isArray(leadPayload)
                    ? `${result.lead.length} leads created successfully`
                    : 'Lead created successfully',
                data: result.lead
            });
        } catch (error) {
            console.error('[LeadController] createLead:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * Get paginated leads.
     * GET /api/ui/leads
     */
    async getAllLeads(req, res) {
        try {
            const {
                limit, sortBy, sortOrder, search,
                collectionId,
                fieldFilters,
                responsibleFilter,
                cursor,
                includeCount,
                fields
            } = req.query;

            const acctId = req.tenant?.acctId;
            if (!acctId) {
                return res.status(400).json({ success: false, message: 'acctId is required' });
            }
            if (includeCount !== undefined && !['true', 'false'].includes(includeCount)) {
                return res.status(400).json({ success: false, message: 'includeCount must be true or false' });
            }

            const sortOrderVal = sortOrder === 'asc' ? 1 : sortOrder === 'desc' ? -1 : (sortOrder ? Number(sortOrder) : -1);

            const result = await leadService.getAllLeads({
                limit:        limit ?? 10,
                sortBy:       sortBy || 'updatedAt',
                sortOrder:    sortOrderVal,
                search,
                acctId,
                collectionId,
                fieldFilters,
                responsibleFilter,
                cursor,
                includeCount: includeCount === 'true',
                requestedFields: fields,
                // Per-admin visibility — superadmins see all, others see only their assigned leads
                accessLevel:  req.user?.accessLevel ?? null,
                userId:       req.user?.userId ?? null
            });

            return res.status(200).json({ success: true, message: 'Leads retrieved successfully', ...result });
        } catch (error) {
            console.error('[LeadController] getAllLeads:', error);
            return res.status(error.statusCode || 500).json({ success: false, message: error.message });
        }
    }

    /**
     * Get a single lead by ID.
     * GET /api/ui/leads/:id
     */
    async getLeadById(req, res) {
        try {
            const { id } = req.params;
            const callerAcctId = await this._resolveAcctId(req);
            if (!callerAcctId) {
                return res.status(400).json({ success: false, message: 'Authenticated account context is required' });
            }
            const lead = await leadService.getLeadById(id, callerAcctId);
            if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
            return res.status(200).json({ success: true, data: lead });
        } catch (error) {
            console.error('[LeadController] getLeadById:', error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    /**
     * Update a lead.
     * PUT /api/ui/leads/:id
     */
    async updateLead(req, res) {
        try {
            const { id } = req.params;

            const callerAcctId = await this._resolveAcctId(req);
            if (!callerAcctId) {
                return res.status(400).json({ success: false, message: 'Authenticated account context is required' });
            }

            const updateData = req.body;
            if (!updateData || Object.keys(updateData).length === 0) {
                return res.status(400).json({ success: false, message: 'No update data provided' });
            }

            const existing = await leadService.getLeadById(id, callerAcctId);
            if (!existing) return res.status(404).json({ success: false, message: 'Lead not found' });
            if (req.user?.accessLevel !== 'superadmin' && String(existing.responsible || '') !== String(req.user?.userId || '')) {
                return res.status(403).json({ success: false, message: 'You can update only leads assigned to you' });
            }

            const updated = await leadService.updateLead(id, updateData, {
                acctId: callerAcctId,
                prevResponsible: existing.responsible ?? null,
                prevStage: existing.stage ?? null,
                collectionId: existing.collectionId ?? null
            });
            return res.status(200).json({ success: true, message: 'Lead updated successfully', data: updated });
        } catch (error) {
            console.error('[LeadController] updateLead:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * Delete a lead.
     * DELETE /api/ui/leads/:id
     */
    async deleteLead(req, res) {
        try {
            const { id }         = req.params;
            const callerAcctId = req.tenant?.acctId;
            if (!callerAcctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            // Destructive: only super admins may delete a lead
            if (req.user?.accessLevel !== 'superadmin') {
                return res.status(403).json({ success: false, message: 'Only super admins can delete a lead' });
            }

            const existing = await leadService.getLeadById(id, callerAcctId);
            if (!existing) return res.status(404).json({ success: false, message: 'Lead not found' });

            await leadService.deleteLead(id, callerAcctId);
            return res.status(200).json({ success: true, message: 'Lead deleted successfully' });
        } catch (error) {
            console.error('[LeadController] deleteLead:', error);
            return res.status(400).json({ success: false, message: error.message });
        }
    }
}

export default new LeadController();
