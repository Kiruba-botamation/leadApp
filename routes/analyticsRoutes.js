import express from 'express';
import analyticsController from '../controllers/analyticsController.js';
import ssoAuthMiddleware from '../middleware/ssoAuthMiddleware.js';

const router = express.Router();

// Apply SSO authentication to all analytics routes
router.use(ssoAuthMiddleware);

/**
 * API: GET /api/analytics/chart-data
 * @desc    Get chart data for visualization
 * @access  Protected (requires authentication)
 * @query   xAxis (trainerName), yAxis (memberName), aggregation (count), fromDate (optional), toDate (optional)
 */
router.get('/chart-data', analyticsController.getChartData.bind(analyticsController));

export default router;
