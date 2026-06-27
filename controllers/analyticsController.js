import analyticsService from '../services/analyticsService.js';

class AnalyticsController {
  /**
   * Save dashboard schema
   * POST /api/ui/analytics/save-schema
   */
  async saveSchema(req, res) {
    try {
      const { userId, acctId, schema } = req.body;

      if (!userId || !acctId || !schema) {
        return res.status(400).json({ success: false, message: 'userId, acctId, and schema are required' });
      }

      const result = await analyticsService.saveSchema({ userId, acctId, schema });

      return res.status(200).json({ success: true, message: 'Schema saved successfully', data: result });
    } catch (error) {
      console.error('Error in saveSchema:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Get dashboard schema
   * GET /api/ui/analytics/get-schema
   */
  async getSchema(req, res) {
    try {
      const { userId, acctId, viewingAs, selectedUserId } = req.query;

      if (!acctId) {
        return res.status(400).json({ success: false, message: 'acctId is required' });
      }

      // Schemas are keyed by userId. In view-as mode, selectedUserId/viewingAs is
      // the target user's userId; otherwise load the caller's own schema.
      const effectiveUserId = selectedUserId || viewingAs || userId;

      const result = effectiveUserId
        ? await analyticsService.getSchema({ userId: effectiveUserId, acctId })
        : null;

      return res.status(200).json({ success: true, data: result || null });
    } catch (error) {
      console.error('Error in getSchema:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * View analytics as another user (admin feature)
   * POST /api/ui/analytics/view-as
   */
  async viewAs(req, res) {
    try {
      const { acctId, userId, selectedUserId } = req.body;

      if (!acctId || !userId || !selectedUserId) {
        return res.status(400).json({
          success: false,
          message: 'acctId, userId, and selectedUserId are required'
        });
      }

      // Load the selected user's saved dashboard (schemas are keyed by userId)
      const result = await analyticsService.getSchema({ userId: selectedUserId, acctId });

      return res.status(200).json({
        success: true,
        data: result || null,
        viewingAs: selectedUserId
      });
    } catch (error) {
      console.error('Error in viewAs:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Get chart data
   * GET /api/analytics/chart-data
   */
  async getChartData(req, res) {
    try {
      // Support both POST (body) and GET (query params)
      const source = req.body && Object.keys(req.body).length ? req.body : req.query;
      const { xAxis, yAxis, zAxis, aggregation, dateFrom, dateTo, collectionId, acctId: acctIdSource, dateGranularity } = source;

      // acctId always comes from the request (query/body) — never from req.user
      const acctId = acctIdSource || req.headers['x-acctno'];
      if (!acctId) {
        return res.status(403).json({
          success: false,
          message: 'No account associated with this session'
        });
      }

      // Validation
      if (!xAxis || !yAxis || !aggregation) {
        return res.status(400).json({
          success: false,
          message: 'xAxis, yAxis, and aggregation are required parameters'
        });
      }

      // Validate aggregation type
      const validAggregations = ['count', 'sum', 'avg', 'min', 'max'];
      if (!validAggregations.includes(aggregation)) {
        return res.status(400).json({
          success: false,
          message: `Invalid aggregation type. Allowed values: ${validAggregations.join(', ')}`
        });
      }

      // Validate dateGranularity if provided
      const validGranularities = ['hour', 'day', 'month', 'year'];
      const resolvedGranularity = validGranularities.includes(dateGranularity) ? dateGranularity : null;

      // Parse and validate dates if provided
      let dateFilter = null;
      if (dateFrom || dateTo) {
        const from = dateFrom ? new Date(dateFrom) : null;
        const to = dateTo ? new Date(new Date(dateTo).setHours(23, 59, 59, 999)) : null;

        if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) {
          return res.status(400).json({
            success: false,
            message: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)'
          });
        }

        dateFilter = { from, to };
      }

      const chartData = await analyticsService.getChartData({
        xAxis,
        yAxis,
        zAxis: zAxis || null,
        aggregation,
        dateFilter,
        acctId,
        collectionId: collectionId || null,
        dateGranularity: resolvedGranularity
      });

      return res.status(200).json({
        success: true,
        message: 'Chart data retrieved successfully',
        data: chartData
      });
    } catch (error) {
      console.error('Error in getChartData:', error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: 'Error retrieving chart data',
        error: error.message
      });
    }
  }
}

export default new AnalyticsController();
