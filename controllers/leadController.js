import leadService from '../services/leadService.js';
import { addToQueue } from '../queue/leadQueue.js';
import UserAccount from '../models/userAccountModel.js';
import { perfomDataExistanceCheck } from '../config/mongoConnector.js';

const QUEUE_ENQUEUE_TIMEOUT_MS = parseInt(process.env.LEAD_QUEUE_ENQUEUE_TIMEOUT_MS ?? '3000', 10);

const withTimeout = (promise, ms, message) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);

class LeadController {
    /** Resolve the caller's acctId from the request.
     * acctId is never stored on req.user — it always comes from the request
     * so that account switching in the UI always works correctly.
     */
    async _resolveAcctId(req) {
        return req.query.acctId || req.body?.acctId || req.headers['x-acctno'] || req.acctId || null;
    }

    /**
     * Create lead(s).
     * POST /api/leads[/:category]       — API key path → queued  (202)
     * POST /api/ui/leads[/:category]    — SSO path     → sync    (201)
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

            const category     = req.params.category || req.query.category || null;
            const mergeProperties = req.body?.config?.merge?.properties ?? null;

            // Strip routing-only fields from the payload
            const stripMeta = (item) => {
                const { category: _c, acctId: _a, acctNo: _n, ...rest } = item;
                return rest;
            };
            const leadPayload = Array.isArray(data) ? data.map(stripMeta) : stripMeta(data);

            const isApiKeyRequest = !req.user && !!req.acctId;

            if (isApiKeyRequest) {
                try {
                    const job = await withTimeout(
                        addToQueue({ acctId, leadPayload, category, mergeProperties }),
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
            const result = await leadService.createLead(leadPayload, acctId, category, mergeProperties);

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
                page, limit, sortBy, sortOrder, search,
                acctId: acctIdQuery,
                categoryId,
                fieldFilters
            } = req.query;

            const acctId = acctIdQuery || req.headers['x-acctno'] || req.acctId;
            if (!acctId) {
                return res.status(400).json({ success: false, message: 'acctId is required' });
            }

            const sortOrderVal = sortOrder === 'asc' ? 1 : sortOrder === 'desc' ? -1 : (sortOrder ? parseInt(sortOrder) : -1);

            const result = await leadService.getAllLeads({
                page:         page  ? parseInt(page)  : 1,
                limit:        limit ? parseInt(limit) : 10,
                sortBy:       sortBy || 'updatedAt',
                sortOrder:    sortOrderVal,
                search,
                acctId,
                categoryId,
                fieldFilters,
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
            const lead = await leadService.getLeadById(id);
            if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
            if (String(lead.acctId) !== String(callerAcctId)) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
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

            const rawBody = req.body?.data ?? req.body;
            const { acctId: _a, acctNo: _n, ...updateData } = rawBody || {};
            if (!updateData || Object.keys(updateData).length === 0) {
                return res.status(400).json({ success: false, message: 'No update data provided' });
            }

            const existing = await leadService.getLeadById(id);
            if (!existing) return res.status(404).json({ success: false, message: 'Lead not found' });
            if (String(existing.acctId) !== String(callerAcctId)) {
                return res.status(403).json({ success: false, message: 'Access denied: lead does not belong to your account' });
            }

            const updated = await leadService.updateLead(id, updateData, {
                acctId: callerAcctId,
                prevResponsible: existing.responsible ?? null
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
            const bodyAcctId     = req.query?.acctId || req.body?.acctId;
            let   callerAcctId   = bodyAcctId || req.headers['x-acctno'] || req.acctId;

            if (!callerAcctId) {
                if (bodyAcctId && req.user?.userId) {
                    const linked = await perfomDataExistanceCheck(UserAccount, { userId: req.user.userId, acctId: bodyAcctId });
                    if (!linked) return res.status(403).json({ success: false, message: 'Access denied' });
                    callerAcctId = bodyAcctId;
                } else {
                    callerAcctId = bodyAcctId;
                }
            }
            if (!callerAcctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const existing = await leadService.getLeadById(id);
            if (!existing) return res.status(404).json({ success: false, message: 'Lead not found' });
            if (String(existing.acctId) !== String(callerAcctId)) {
                return res.status(403).json({ success: false, message: 'Access denied: lead does not belong to your account' });
            }

            await leadService.deleteLead(id);
            return res.status(200).json({ success: true, message: 'Lead deleted successfully' });
        } catch (error) {
            console.error('[LeadController] deleteLead:', error);
            return res.status(400).json({ success: false, message: error.message });
        }
    }
}

export default new LeadController();
