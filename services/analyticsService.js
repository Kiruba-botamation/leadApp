import Lead from '../models/leadModel.js';

class AnalyticsService {
    /**
     * Get chart data with grouping and aggregation
     * @param {Object} params - Query parameters
     * @param {string} params.xAxis - Field to group by for X-axis (e.g., 'trainerName')
     * @param {string} params.yAxis - Field to aggregate for Y-axis (e.g., 'memberName')
     * @param {string} params.aggregation - Aggregation type (count, sum, avg, min, max)
     * @param {Object} params.dateFilter - Optional date range filter { from: Date, to: Date }
     * @returns {Promise<Array>} - Aggregated chart data
     */
    async getChartData({ xAxis, yAxis, aggregation, dateFilter }) {
        try {
            // Build aggregation pipeline
            const pipeline = [];

            // Stage 1: Filter by date if provided
            if (dateFilter && (dateFilter.from || dateFilter.to)) {
                const dateMatch = {};
                if (dateFilter.from) {
                    dateMatch.$gte = dateFilter.from;
                }
                if (dateFilter.to) {
                    dateMatch.$lte = dateFilter.to;
                }
                pipeline.push({
                    $match: {
                        updatedAt: dateMatch
                    }
                });
            }

            // Stage 2: Group by xAxis and aggregate yAxis
            const groupStage = {
                _id: `$${xAxis}`,
                value: this._getAggregationExpression(aggregation, yAxis)
            };

            pipeline.push({
                $group: groupStage
            });

            // Stage 3: Sort by _id for consistent results
            pipeline.push({
                $sort: { _id: 1 }
            });

            // Stage 4: Project to format the output
            pipeline.push({
                $project: {
                    _id: 0,
                    name: '$_id',
                    value: 1
                }
            });

            const result = await Lead.aggregate(pipeline);

            return result;
        } catch (error) {
            console.error('Error in getChartData:', error);
            throw new Error(`Failed to retrieve chart data: ${error.message}`);
        }
    }

    /**
     * Get the appropriate MongoDB aggregation expression based on type
     * @private
     */
    _getAggregationExpression(aggregation, field) {
        const expressions = {
            count: { $sum: 1 },
            sum: { $sum: `$${field}` },
            avg: { $avg: `$${field}` },
            min: { $min: `$${field}` },
            max: { $max: `$${field}` }
        };

        return expressions[aggregation] || { $sum: 1 };
    }
}

export default new AnalyticsService();
