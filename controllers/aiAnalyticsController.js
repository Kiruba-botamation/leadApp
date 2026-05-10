/**
 * aiAnalyticsController.js
 * ────────────────────────────────────────────────────────────────────────────
 * Handles AI chat requests for the analytics chart assistant.
 * Fetches categories + fields, then delegates to the active AI provider.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { getAiProvider } from '../connectors/ai/index.js';
import leadService from '../services/leadService.js';

class AiAnalyticsController {
    /**
     * POST /api/ui/analytics/ai/chat
     *
     * Body:
     *   message  {string}  - Latest user message
     *   history  {Array}   - Prior conversation turns [{ role, text }]
     *   acctId   {string}  - Account ID
     */
    async chat(req, res) {
        try {
            const { message, history = [], acctId: bodyAcctId, currentCharts = [] } = req.body;

            // Resolve acctId from SSO context or body
            const acctId = req.user?.acctId || req.acctId || bodyAcctId;

            // ── Input validation ────────────────────────────────────────────
            if (!acctId) {
                return res.status(400).json({
                    success: false,
                    message: 'acctId is required',
                });
            }

            if (!message || typeof message !== 'string' || message.trim() === '') {
                return res.status(400).json({
                    success: false,
                    message: 'message is required and must be a non-empty string',
                });
            }

            if (!Array.isArray(history)) {
                return res.status(400).json({
                    success: false,
                    message: 'history must be an array',
                });
            }

            // Cap history at last 6 turns to keep prompt size reasonable and avoid Gemini timeouts
            const recentHistory = history.slice(-6);

            // ── Fetch categories with their fields ──────────────────────────
            let categoriesWithFields = [];
            try {
                // getFieldsByCategory returns all categories with fields in a single query
                const rawCategories = await leadService.getFieldsByCategory(acctId);
                categoriesWithFields = rawCategories.map(cat => ({
                    _id: String(cat.categoryId),
                    categoryName: cat.categoryName,
                    fields: cat.fields || [],
                }));
            } catch (fetchErr) {
                // Non-fatal — AI can still help even without category context
                console.error('[AiAnalytics] Failed to fetch categories:', fetchErr.message);
            }

            // ── Call AI provider ────────────────────────────────────────────
            const ai = getAiProvider();
            const result = await ai.generateAnalyticsCharts(
                message.trim(),
                recentHistory,
                categoriesWithFields,
                Array.isArray(currentCharts) ? currentCharts : []
            );

            return res.status(200).json({
                success: true,
                data: result,
            });
        } catch (err) {
            console.error('[AiAnalytics] Error:', err.message);

            // Differentiate between provider config errors and runtime errors
            if (err.message?.includes('API key') || err.message?.includes('not configured')) {
                return res.status(503).json({
                    success: false,
                    message: 'AI service is not configured. Please contact your administrator.',
                });
            }

            if (err.message?.includes('not yet implemented')) {
                return res.status(501).json({
                    success: false,
                    message: 'This AI provider is not yet implemented.',
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Failed to generate chart suggestion. Please try again.',
            });
        }
    }
}

export default new AiAnalyticsController();
