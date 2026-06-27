import Lead from '../models/leadModel.js';
import LeadCollection from '../models/leadCollectionModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import AnalyticsSchema from '../models/analyticsSchemaModel.js';
import { performAggregate, performUpsert } from '../config/mongoConnector.js';

// Fields that store timestamps and support granularity bucketing
const DATE_AXIS_FIELDS = ['createdAt', 'updatedAt'];

// Axes whose raw stored value is an id that must be resolved to a human label
// (stage id → stage name, responsible userId → admin full name) before charting.
const NAME_RESOLVED_FIELDS = ['stage', 'responsible'];

// Maps granularity keys to MongoDB $dateToString format strings and sort-friendly output
const GRANULARITY_FORMAT = {
    hour:  '%Y-%m-%dT%H:00',   // e.g. "2025-04-12T14:00"
    day:   '%Y-%m-%d',          // e.g. "2025-04-12"
    month: '%Y-%m',             // e.g. "2025-04"
    year:  '%Y',                // e.g. "2025"
};

class AnalyticsService {
    /**
     * Get chart data with grouping and aggregation
     * @param {Object} params - Query parameters
     * @param {string} params.xAxis - Field to group by for X-axis (e.g., 'createdAt', 'trainerName')
     * @param {string} params.yAxis - Field to aggregate for Y-axis (e.g., 'memberName')
     * @param {string} params.aggregation - Aggregation type (count, sum, avg, min, max)
     * @param {Object} params.dateFilter - Optional date range filter { from: Date, to: Date }
     * @param {string|null} params.dateGranularity - 'hour'|'day'|'month'|'year' — only used when xAxis is a date field
     * @returns {Promise<Array>} - Aggregated chart data
     */
    async getChartData({ xAxis, yAxis, zAxis, aggregation, dateFilter, acctId, collectionId, dateGranularity }) {
        try {
            const pipeline = [];
            const isDateAxis = DATE_AXIS_FIELDS.includes(xAxis);

            // ── Stage 1: $match ────────────────────────────────────────────────────────
            const matchStage = { acctId };

            if (collectionId) {
                matchStage.collectionId = collectionId;
            }

            if (dateFilter && (dateFilter.from || dateFilter.to)) {
                const dateMatch = {};
                if (dateFilter.from) dateMatch.$gte = dateFilter.from;
                if (dateFilter.to)   dateMatch.$lte = dateFilter.to;

                // Apply the date range to the actual xAxis field when it is a date field,
                // so that filtering by createdAt range works correctly when xAxis = 'createdAt'.
                // Always also filter updatedAt to catch records updated in the window.
                if (isDateAxis) {
                    matchStage[xAxis] = dateMatch;
                } else {
                    matchStage.updatedAt = dateMatch;
                }
            }

            pipeline.push({ $match: matchStage });

            // ── Build the xAxis group expression ──────────────────────────────────────
            // When xAxis is a timestamp field, bucket by the chosen granularity using
            // $dateToString so each bucket becomes a sortable string like "2025-04-12".
            const fmt = isDateAxis && dateGranularity ? GRANULARITY_FORMAT[dateGranularity] : null;
            const xGroupExpr = fmt
                ? { $dateToString: { format: fmt, date: `$${xAxis}` } }
                : `$${xAxis}`;

            if (zAxis) {
                // ── Grouped / Stacked mode ─────────────────────────────────────────────
                pipeline.push({
                    $group: {
                        _id: {
                            name: xGroupExpr,
                            zKey: `$${zAxis}`
                        },
                        value: this._getAggregationExpression(aggregation, yAxis)
                    }
                });

                // Sort chronologically for date axes, otherwise alphabetically
                pipeline.push({ $sort: { '_id.name': 1, '_id.zKey': 1 } });
                pipeline.push({ $limit: 500 });
                pipeline.push({
                    $project: {
                        _id: 0,
                        name: '$_id.name',
                        zKey: '$_id.zKey',
                        value: 1
                    }
                });
            } else {
                // ── Standard single-axis mode ──────────────────────────────────────────
                pipeline.push({
                    $group: {
                        _id: xGroupExpr,
                        value: this._getAggregationExpression(aggregation, yAxis)
                    }
                });

                // For date axes sort chronologically (ascending); otherwise by value descending
                if (isDateAxis && fmt) {
                    pipeline.push({ $sort: { _id: 1 } });
                } else {
                    pipeline.push({ $sort: { value: -1 } });
                }

                pipeline.push({ $limit: 500 });
                pipeline.push({
                    $project: {
                        _id: 0,
                        name: '$_id',
                        value: 1
                    }
                });
            }

            const rows = await performAggregate(Lead, pipeline);
            return await this._enrichNames(rows, { xAxis, zAxis, acctId, collectionId });
        } catch (error) {
            console.error('Error in getChartData:', error);
            throw new Error(`Failed to retrieve chart data: ${error.message}`);
        }
    }

    /**
     * Resolve id-valued axes (stage, responsible) to human labels in the chart rows.
     * Grouping stays keyed on the raw id (stable, exact counts) — only the output
     * `name` / `zKey` labels are replaced. Mutates and returns the same rows.
     * @private
     */
    async _enrichNames(rows, { xAxis, zAxis, acctId, collectionId }) {
        if (!Array.isArray(rows) || rows.length === 0) return rows;

        const needStage =
            (xAxis === 'stage' || zAxis === 'stage');
        const needResponsible =
            (xAxis === 'responsible' || zAxis === 'responsible');
        if (!needStage && !needResponsible) return rows;

        // Build a stage id→name map (collection-scoped).
        let stageMap = {};
        if (needStage && collectionId) {
            const col = await LeadCollection.findOne({ _id: collectionId, acctId }, { stages: 1 }).lean();
            for (const s of col?.stages || []) stageMap[s.id] = s.name;
        }

        // Build a responsible userId→"First Last" map from the ids actually present.
        let adminMap = {};
        if (needResponsible) {
            const ids = new Set();
            for (const r of rows) {
                if (xAxis === 'responsible' && r.name !== undefined && r.name !== null && r.name !== '') ids.add(String(r.name));
                if (zAxis === 'responsible' && r.zKey !== undefined && r.zKey !== null && r.zKey !== '') ids.add(String(r.zKey));
            }
            if (ids.size) {
                const admins = await AccountAdmin.find(
                    { acctId, userId: { $in: [...ids] } },
                    { userId: 1, firstName: 1, lastName: 1 }
                ).lean();
                for (const a of admins) {
                    adminMap[String(a.userId)] = [a.firstName, a.lastName].filter(Boolean).join(' ').trim() || 'Unknown';
                }
            }
        }

        const labelFor = (field, raw) => {
            if (field === 'stage') {
                return stageMap[raw] ?? (raw === null || raw === undefined || raw === '' ? 'No stage' : 'Unknown');
            }
            // responsible
            if (raw === null || raw === undefined || raw === '') return 'Unassigned';
            return adminMap[String(raw)] ?? 'Unknown';
        };

        for (const r of rows) {
            if (NAME_RESOLVED_FIELDS.includes(xAxis)) r.name = labelFor(xAxis, r.name);
            if (zAxis && NAME_RESOLVED_FIELDS.includes(zAxis)) r.zKey = labelFor(zAxis, r.zKey);
        }
        return rows;
    }

    /**
     * Get the appropriate MongoDB aggregation expression based on type
     * @private
     */
    _getAggregationExpression(aggregation, field) {
        // For numeric aggregations, wrap in $toDouble so string-encoded numbers
        // (e.g. phone stored as "9000000001") are handled — and non-numeric strings
        // coerce to null which $sum/$avg ignores (falls back to 0/count behaviour).
        // Use count for pure categorical yAxis fields.
        const numericAggregations = ['sum', 'avg', 'min', 'max'];
        const fieldExpr = numericAggregations.includes(aggregation)
            ? { $toDouble: `$${field}` }
            : `$${field}`;

        const expressions = {
            count: { $sum: 1 },
            sum:   { $sum: fieldExpr },
            avg:   { $avg: fieldExpr },
            min:   { $min: fieldExpr },
            max:   { $max: fieldExpr }
        };

        return expressions[aggregation] || { $sum: 1 };
    }

    async saveSchema({ userId, acctId, schema }) {
        return performUpsert(AnalyticsSchema, { userId, acctId }, { schema });
    }

    async getSchema({ userId, acctId }) {
        return AnalyticsSchema.findOne({ userId, acctId }).lean();
    }
}

export default new AnalyticsService();
