import collectionService from '../services/collectionService.js';

/**
 * Controller for all collection management operations.
 * All routes here are SSO-protected (/api/ui/leads/collections/*).
 */
class CollectionController {
    /** Shared helper: resolve acctId from request */
    _resolveAcctId(req) {
        return req.query.acctId || req.headers['x-acctno'] || req.acctId || null;
    }

    /**
     * GET /api/ui/leads/collections
     * Returns a lightweight list of collections (no field details).
     */
    async getCollections(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const data = await collectionService.getCollections(acctId);
            return res.status(200).json({ success: true, data });
        } catch (error) {
            console.error('[CollectionController] getCollections:', error);
            return res.status(error.statusCode || 500).json({ success: false, message: error.message });
        }
    }

    /**
     * GET /api/ui/leads/collections/:collectionId/fields
     * Returns full column definitions (system + user-defined) for one collection.
     */
    async getCollectionFields(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { collectionId } = req.params;
            const data = await collectionService.getCollectionFields(acctId, collectionId);
            return res.status(200).json({ success: true, data });
        } catch (error) {
            if (error.statusCode === 404) return res.status(404).json({ success: false, message: error.message });
            console.error('[CollectionController] getCollectionFields:', error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    /**
     * POST /api/ui/leads/collections
     * Body: { collectionName, fields?: [{ label, type }] }
     */
    async createCollection(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { collectionName, fields = [] } = req.body;
            if (!collectionName) return res.status(400).json({ success: false, message: 'collectionName is required' });

            const data = await collectionService.createCollection(acctId, collectionName, fields);
            return res.status(201).json({ success: true, message: 'Collection created successfully', data });
        } catch (error) {
            if (error.statusCode === 409) return res.status(409).json({ success: false, message: error.message });
            console.error('[CollectionController] createCollection:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * PUT /api/ui/leads/collections/:collectionId
     * Body: { collectionName?, fields?: [{ label, type }] }
     */
    async updateCollection(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { collectionId } = req.params;
            const { collectionName, fields } = req.body;

            const data = await collectionService.updateCollection(acctId, collectionId, { collectionName, fields });
            return res.status(200).json({ success: true, message: 'Collection updated successfully', data });
        } catch (error) {
            if (error.statusCode === 404) return res.status(404).json({ success: false, message: error.message });
            if (error.statusCode === 409) return res.status(409).json({ success: false, message: error.message });
            console.error('[CollectionController] updateCollection:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * PUT /api/ui/leads/collections/:collectionId/default
     */
    async setDefaultCollection(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { collectionId } = req.params;
            const data = await collectionService.setDefaultCollection(acctId, collectionId);
            return res.status(200).json({ success: true, message: 'Default collection updated', data });
        } catch (error) {
            if (error.statusCode === 404) return res.status(404).json({ success: false, message: error.message });
            console.error('[CollectionController] setDefaultCollection:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    // ── Stage management ─────────────────────────────────────────────────────

    /**
     * POST /api/ui/leads/collections/:collectionId/stages
     * Body: { name, color? }
     */
    async addStage(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { collectionId } = req.params;
            const { name, color } = req.body;
            const stages = await collectionService.addStage(acctId, collectionId, { name, color });
            return res.status(201).json({ success: true, message: 'Stage added', data: stages });
        } catch (error) {
            console.error('[CollectionController] addStage:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * PUT /api/ui/leads/collections/:collectionId/stages/reorder
     * Body: { orderedIds: [Number] }
     */
    async reorderStages(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { collectionId } = req.params;
            const { orderedIds = [] } = req.body;
            const stages = await collectionService.reorderStages(acctId, collectionId, orderedIds);
            return res.status(200).json({ success: true, message: 'Stages reordered', data: stages });
        } catch (error) {
            console.error('[CollectionController] reorderStages:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * PUT /api/ui/leads/collections/:collectionId/stages/:stageId
     * Body: { name?, color?, order? }
     */
    async updateStage(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { collectionId, stageId } = req.params;
            const { name, color, order } = req.body;
            const stages = await collectionService.updateStage(acctId, collectionId, stageId, { name, color, order });
            return res.status(200).json({ success: true, message: 'Stage updated', data: stages });
        } catch (error) {
            console.error('[CollectionController] updateStage:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * DELETE /api/ui/leads/collections/:collectionId/stages/:stageId
     * Reassigns leads in the stage to the first remaining stage.
     */
    async deleteStage(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { collectionId, stageId } = req.params;
            const result = await collectionService.deleteStage(acctId, collectionId, stageId);
            return res.status(200).json({
                success: true,
                message: `Stage deleted${result.reassignedCount ? `; ${result.reassignedCount} lead(s) reassigned` : ''}`,
                data:    result
            });
        } catch (error) {
            console.error('[CollectionController] deleteStage:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * DELETE /api/ui/leads/collections/:collectionId
     */
    async deleteCollection(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            // Destructive: only super admins may delete a collection (and its leads)
            if (req.user?.accessLevel !== 'superadmin') {
                return res.status(403).json({ success: false, message: 'Only super admins can delete a collection' });
            }

            const { collectionId } = req.params;
            const result = await collectionService.deleteCollection(acctId, collectionId);
            return res.status(200).json({
                success: true,
                message: `Collection "${result.collectionName}" and ${result.deletedLeads} associated lead(s) deleted successfully`,
                data:    result
            });
        } catch (error) {
            if (error.statusCode === 404) return res.status(404).json({ success: false, message: error.message });
            console.error('[CollectionController] deleteCollection:', error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }
}

export default new CollectionController();
