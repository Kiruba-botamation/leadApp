import express from 'express';
import aiAnalyticsController from '../controllers/aiAnalyticsController.js';

const router = express.Router();

/**
 * POST /api/ui/analytics/ai/chat
 * @desc    Generate chart suggestions via AI assistant
 * @access  Protected (SSO required — applied in server.js)
 * @body    { message: string, history: Array, acctId: string }
 */
router.post('/chat', aiAnalyticsController.chat.bind(aiAnalyticsController));

export default router;
