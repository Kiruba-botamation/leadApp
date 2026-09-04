import analyticsService from '../services/analyticsService.js';

class AnalyticsController {
  /**
   * Save dashboard schema
   * POST /api/ui/analytics/save-schema
   */
  async saveSchema(req, res) {
    try {
      const { schema } = req.body;
      const userId = req.user.userId;
      const acctId = req.tenant.acctId;

      if (!schema) {
        return res.status(400).json({ success: false, message: 'schema is required' });
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
      const { viewingAs, selectedUserId } = req.query;
      const acctId = req.tenant.acctId;

      // Schemas are keyed by userId. In view-as mode, selectedUserId/viewingAs is
      // the target user's userId; otherwise load the caller's own schema.
      const requestedUserId = selectedUserId || viewingAs;
      const effectiveUserId = req.user.accessLevel === 'superadmin' && requestedUserId
        ? requestedUserId
        : req.user.userId;

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
      const { selectedUserId } = req.body;
      const acctId = req.tenant.acctId;

      if (!selectedUserId) {
        return res.status(400).json({
          success: false,
          message: 'selectedUserId is required'
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
      const { xAxis, yAxis, zAxis, aggregation, dateFrom, dateTo, dateFilterField, collectionId, dateGranularity } = source;
      const acctId = req.tenant?.acctId;
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

      // Keep old clients compatible: date axes historically filtered themselves,
      // while categorical axes filtered by updatedAt.
      const validDateFilterFields = ['createdAt', 'updatedAt'];
      if (dateFilterField && !validDateFilterFields.includes(dateFilterField)) {
        return res.status(400).json({
          success: false,
          message: `Invalid date filter field. Allowed values: ${validDateFilterFields.join(', ')}`
        });
      }
      const resolvedDateFilterField = dateFilterField
        || (validDateFilterFields.includes(xAxis) ? xAxis : 'updatedAt');

      // Parse and validate dates if provided
      let dateFilter = null;
      if (dateFrom || dateTo) {
        const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
        const parseUtcDate = (value) => {
          if (!value || !dateOnlyPattern.test(value)) return null;
          const parsed = new Date(`${value}T00:00:00.000Z`);
          return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
        };
        const from = parseUtcDate(dateFrom);
        const toExclusive = parseUtcDate(dateTo);
        if (toExclusive) toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

        if ((dateFrom && !from) || (dateTo && !toExclusive)
          || (from && isNaN(from.getTime())) || (toExclusive && isNaN(toExclusive.getTime()))) {
          return res.status(400).json({
            success: false,
            message: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)'
          });
        }
        if (from && toExclusive && from >= toExclusive) {
          return res.status(400).json({ success: false, message: 'dateFrom must be on or before dateTo' });
        }

        dateFilter = { from, toExclusive };
      }

      const chartData = await analyticsService.getChartData({
        xAxis,
        yAxis,
        zAxis: zAxis || null,
        aggregation,
        dateFilter,
        dateFilterField: resolvedDateFilterField,
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
