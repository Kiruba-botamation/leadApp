import categoryService from '../services/categoryService.js';

/**
 * Controller for all category management operations.
 * All routes here are SSO-protected (/api/ui/leads/categories/*).
 */
class CategoryController {
    /** Shared helper: resolve acctId from request */
    _resolveAcctId(req) {
        return req.query.acctId || req.headers['x-acctno'] || req.acctId || null;
    }

    /**
     * GET /api/ui/leads/categories
     * Returns a lightweight list of categories (no field details).
     */
    async getCategories(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const data = await categoryService.getCategories(acctId);
            return res.status(200).json({ success: true, data });
        } catch (error) {
            console.error('[CategoryController] getCategories:', error);
            return res.status(error.statusCode || 500).json({ success: false, message: error.message });
        }
    }

    /**
     * GET /api/ui/leads/categories/:categoryId/fields
     * Returns full column definitions (system + user-defined) for one category.
     */
    async getCategoryFields(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryId } = req.params;
            const data = await categoryService.getCategoryFields(acctId, categoryId);
            return res.status(200).json({ success: true, data });
        } catch (error) {
            if (error.statusCode === 404) return res.status(404).json({ success: false, message: error.message });
            console.error('[CategoryController] getCategoryFields:', error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    /**
     * POST /api/ui/leads/categories
     * Body: { categoryName, fields?: [{ label, type }] }
     */
    async createCategory(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryName, fields = [] } = req.body;
            if (!categoryName) return res.status(400).json({ success: false, message: 'categoryName is required' });

            const data = await categoryService.createCategory(acctId, categoryName, fields);
            return res.status(201).json({ success: true, message: 'Category created successfully', data });
        } catch (error) {
            if (error.statusCode === 409) return res.status(409).json({ success: false, message: error.message });
            console.error('[CategoryController] createCategory:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * PUT /api/ui/leads/categories/:categoryId
     * Body: { categoryName?, fields?: [{ label, type }] }
     */
    async updateCategory(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryId } = req.params;
            const { categoryName, fields } = req.body;

            const data = await categoryService.updateCategory(acctId, categoryId, { categoryName, fields });
            return res.status(200).json({ success: true, message: 'Category updated successfully', data });
        } catch (error) {
            if (error.statusCode === 404) return res.status(404).json({ success: false, message: error.message });
            if (error.statusCode === 409) return res.status(409).json({ success: false, message: error.message });
            console.error('[CategoryController] updateCategory:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * PUT /api/ui/leads/categories/:categoryId/default
     */
    async setDefaultCategory(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryId } = req.params;
            const data = await categoryService.setDefaultCategory(acctId, categoryId);
            return res.status(200).json({ success: true, message: 'Default category updated', data });
        } catch (error) {
            if (error.statusCode === 404) return res.status(404).json({ success: false, message: error.message });
            console.error('[CategoryController] setDefaultCategory:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    // ── Stage management ─────────────────────────────────────────────────────

    /**
     * POST /api/ui/leads/categories/:categoryId/stages
     * Body: { name, color? }
     */
    async addStage(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryId } = req.params;
            const { name, color } = req.body;
            const stages = await categoryService.addStage(acctId, categoryId, { name, color });
            return res.status(201).json({ success: true, message: 'Stage added', data: stages });
        } catch (error) {
            console.error('[CategoryController] addStage:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * PUT /api/ui/leads/categories/:categoryId/stages/reorder
     * Body: { orderedIds: [Number] }
     */
    async reorderStages(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryId } = req.params;
            const { orderedIds = [] } = req.body;
            const stages = await categoryService.reorderStages(acctId, categoryId, orderedIds);
            return res.status(200).json({ success: true, message: 'Stages reordered', data: stages });
        } catch (error) {
            console.error('[CategoryController] reorderStages:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * PUT /api/ui/leads/categories/:categoryId/stages/:stageId
     * Body: { name?, color?, order? }
     */
    async updateStage(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryId, stageId } = req.params;
            const { name, color, order } = req.body;
            const stages = await categoryService.updateStage(acctId, categoryId, stageId, { name, color, order });
            return res.status(200).json({ success: true, message: 'Stage updated', data: stages });
        } catch (error) {
            console.error('[CategoryController] updateStage:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * DELETE /api/ui/leads/categories/:categoryId/stages/:stageId
     * Reassigns leads in the stage to the first remaining stage.
     */
    async deleteStage(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryId, stageId } = req.params;
            const result = await categoryService.deleteStage(acctId, categoryId, stageId);
            return res.status(200).json({
                success: true,
                message: `Stage deleted${result.reassignedCount ? `; ${result.reassignedCount} lead(s) reassigned` : ''}`,
                data:    result
            });
        } catch (error) {
            console.error('[CategoryController] deleteStage:', error);
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    /**
     * DELETE /api/ui/leads/categories/:categoryId
     */
    async deleteCategory(req, res) {
        try {
            const acctId = this._resolveAcctId(req);
            if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

            const { categoryId } = req.params;
            const result = await categoryService.deleteCategory(acctId, categoryId);
            return res.status(200).json({
                success: true,
                message: `Category "${result.categoryName}" and ${result.deletedLeads} associated lead(s) deleted successfully`,
                data:    result
            });
        } catch (error) {
            if (error.statusCode === 404) return res.status(404).json({ success: false, message: error.message });
            console.error('[CategoryController] deleteCategory:', error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }
}

export default new CategoryController();
