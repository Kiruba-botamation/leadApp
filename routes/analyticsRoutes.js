import express from 'express';
import analyticsController from '../controllers/analyticsController.js';
import { requireSuperadmin } from '../middleware/verifiedTenantMiddleware.js';

const router = express.Router();

/**
 * API: GET /api/analytics/chart-data
 * @desc    Get chart data for visualization
 * @access  Protected (requires authentication)
 * @query   xAxis (trainerName), yAxis (memberName), aggregation (count), fromDate (optional), toDate (optional)
 */
router.post('/chart-data', analyticsController.getChartData.bind(analyticsController));
router.get('/chart-data', analyticsController.getChartData.bind(analyticsController));

router.post('/save-schema', analyticsController.saveSchema.bind(analyticsController));
router.get('/get-schema', analyticsController.getSchema.bind(analyticsController));

router.post('/view-as', requireSuperadmin, analyticsController.viewAs.bind(analyticsController));

export default router;
