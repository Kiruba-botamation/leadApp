import Lead from '../models/leadModel.js';
import { performUpsert, performGet, performDelete, perfomDataExistanceCheck } from '../config/mongoConnector.js';
import categoryService, { SYSTEM_FIELDS } from './categoryService.js';

/** Fields that are internal / framework-managed and should never be treated as lead data */
const INTERNAL_FIELDS = new Set(['_id', 'acctId', 'categoryId', '__v', 'createdAt', 'updatedAt', 'category']);

class LeadService {
    /**
     * Create one or more leads.
     *
     * Validation rules:
     *  - The category must already exist in the DB.
     *  - Every key in the payload must be a field defined in the category (system or user-defined).
     *  - The "id" field is mandatory (system field).
     *
     * @param {object|object[]} leadData   — single lead object or array
     * @param {string}          acctId
     * @param {string|null}     category   — category name (uses default when null)
     * @param {string[]|null}   mergeProperties
     */
    async createLead(leadData, acctId, category = null, mergeProperties = null) {
        const categoryName = category || 'default';

        // ── 1. Resolve & validate category ──────────────────────────────────
        const categoryDoc = await categoryService.findByName(acctId, categoryName);
        if (!categoryDoc) {
            const err = new Error(`Category "${categoryName}" not found. Create it in Settings → Category before pushing data.`);
            err.statusCode = 404;
            throw err;
        }
        const categoryId = categoryDoc._id;

        // Build set of allowed field keys: system + user-defined
        const allowedFields = new Set([
            ...SYSTEM_FIELDS.map(f => f.field),
            ...(categoryDoc.fields || []).map(f => f.field)
        ]);

        // ── 2. Validate each item in the payload ────────────────────────────
        const items = Array.isArray(leadData) ? leadData : [leadData];
        for (const item of items) {
            // Mandatory system field: "id"
            if (!item.id && item.id !== 0) {
                const err = new Error('Field "id" is required for all leads.');
                err.statusCode = 400;
                throw err;
            }

            // Reject unknown fields
            const unknownFields = Object.keys(item).filter(k => !INTERNAL_FIELDS.has(k) && !allowedFields.has(k));
            if (unknownFields.length > 0) {
                const err = new Error(
                    `Unknown field(s) for category "${categoryName}": ${unknownFields.join(', ')}. ` +
                    `Define them in Settings → Category before using them.`
                );
                err.statusCode = 400;
                throw err;
            }
        }

        // ── 3. Insert lead(s) ───────────────────────────────────────────────
        const addMeta = (item) => ({ ...item, acctId, categoryId });

        const buildMergeFilter = (item) => {
            if (!mergeProperties?.length) return {};
            const filter = { acctId };
            let found = false;
            for (const prop of mergeProperties) {
                if (prop in item) { filter[prop] = item[prop]; found = true; }
            }
            return found ? filter : {};
        };

        let leadResult;
        if (Array.isArray(leadData)) {
            if (mergeProperties?.length) {
                const ops = leadData.map(item => {
                    const enriched = addMeta({ ...item });
                    return { updateOne: { filter: buildMergeFilter(item), update: { $set: enriched }, upsert: true } };
                });
                await Lead.bulkWrite(ops, { ordered: false });
                const mergeFilters = leadData.map(item => buildMergeFilter(item));
                leadResult = await Lead.find({ $or: mergeFilters }).lean();
            } else {
                const results = await Promise.all(
                    leadData.map(item => performUpsert(Lead, {}, addMeta({ ...item })))
                );
                leadResult = results.map(r => r.doc);
            }
        } else {
            const result = await performUpsert(Lead, buildMergeFilter(leadData), addMeta({ ...leadData }));
            leadResult = result.doc;
        }

        return { lead: leadResult, categoryId };
    }

    /**
     * Get paginated leads.
     *
     * Filters are passed as a `fieldFilters` JSON string for typed filtering:
     *   { fieldName: { type: 'text'|'number'|'date'|'boolean', value?, op?, min?, max?, from?, to? } }
     *
     * categoryFields is intentionally NOT returned here — the UI fetches column
     * definitions separately via GET /categories/:id/fields.
     */
    async getAllLeads(filters = {}) {
        const {
            page = 1,
            limit = 10,
            sortBy = 'updatedAt',
            sortOrder = -1,
            search,
            acctId,
            categoryId,
            fieldFilters: fieldFiltersRaw
        } = filters;

        const query = { acctId };
        if (categoryId) query.categoryId = categoryId;

        // ── Parse and apply typed field filters ─────────────────────────────
        if (fieldFiltersRaw) {
            let parsed = {};
            try { parsed = JSON.parse(fieldFiltersRaw); } catch { /* invalid JSON — ignore */ }

            for (const [key, filterDef] of Object.entries(parsed)) {
                if (!filterDef || INTERNAL_FIELDS.has(key)) continue;
                const condition = this._buildFilterCondition(filterDef);
                if (condition !== null) query[key] = condition;
            }
        }

        // ── Global text search across string fields ──────────────────────────
        if (search) {
            const scopeConditions = [{ acctId }];
            if (categoryId) scopeConditions.push({ categoryId });
            const stringFields = Object.keys(Lead.schema.paths).filter(
                k => Lead.schema.paths[k].instance === 'String' && !['_id', 'acctId', 'adminId'].includes(k)
            );
            const searchConditions = stringFields.map(field => ({ [field]: { $regex: search, $options: 'i' } }));
            query.$and = [...scopeConditions, { $or: searchConditions }];
            delete query.acctId;
            delete query.categoryId;
        }

        const skip = (page - 1) * limit;
        const sort = { [sortBy]: sortOrder };

        // Single $facet aggregation: data + total in one round-trip
        const pipeline = [
            { $match: query },
            {
                $facet: {
                    data: [
                        { $sort: sort },
                        { $skip: skip },
                        { $limit: limit },
                        {
                            $lookup: {
                                from:         'account_admins',
                                localField:   'adminId',
                                foreignField: 'chatbotAdminId',
                                as:           '_adminArr'
                            }
                        },
                        {
                            $addFields: {
                                adminName: {
                                    $let: {
                                        vars: {
                                            fn: { $ifNull: [{ $arrayElemAt: ['$_adminArr.firstName', 0] }, ''] },
                                            ln: { $ifNull: [{ $arrayElemAt: ['$_adminArr.lastName', 0] }, ''] }
                                        },
                                        in: {
                                            $cond: {
                                                if:   { $or: [{ $ne: ['$$fn', ''] }, { $ne: ['$$ln', ''] }] },
                                                then: { $trim: { input: { $concat: ['$$fn', ' ', '$$ln'] } } },
                                                else: null
                                            }
                                        }
                                    }
                                },
                                adminProfileImage: { $ifNull: [{ $arrayElemAt: ['$_adminArr.profileImage', 0] }, null] }
                            }
                        },
                        { $project: { _adminArr: 0 } }
                    ],
                    total: [{ $count: 'count' }]
                }
            }
        ];

        const [aggResult] = await Lead.aggregate(pipeline).option({ allowDiskUse: true });

        return {
            data: aggResult?.data ?? [],
            pagination: {
                total: aggResult?.total?.[0]?.count ?? 0,
                page,
                limit,
                pages: Math.ceil((aggResult?.total?.[0]?.count ?? 0) / limit)
            }
        };
    }

    /** Get a single lead by _id */
    async getLeadById(id) {
        const result = await performGet(Lead, { _id: id });
        return result?.data?.[0] || null;
    }

    /** Update a lead by _id */
    async updateLead(id, updateData) {
        const result = await performUpsert(Lead, { _id: id }, updateData);
        return result.doc || null;
    }

    /** Delete a lead by _id */
    async deleteLead(id) {
        await performDelete(Lead, { _id: id });
        return true;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Convert a typed filter definition to a MongoDB query condition.
     * Returns null when there is no meaningful filter to apply.
     */
    _buildFilterCondition(filterDef) {
        const { type, value, op, min, max, from, to } = filterDef;

        switch (type) {
            case 'text': {
                if (!value && value !== 0) return null;
                return { $regex: String(value), $options: 'i' };
            }

            case 'number': {
                if (op === 'between') {
                    const lo = parseFloat(min);
                    const hi = parseFloat(max);
                    if (isNaN(lo) && isNaN(hi)) return null;
                    const cond = {};
                    if (!isNaN(lo)) cond.$gte = lo;
                    if (!isNaN(hi)) cond.$lte = hi;
                    return cond;
                }
                const num = parseFloat(value);
                if (isNaN(num)) return null;
                const opMap = { eq: '$eq', ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };
                const mongoOp = opMap[op] || '$eq';
                return { [mongoOp]: num };
            }

            case 'date': {
                const cond = {};
                if (from) cond.$gte = new Date(from);
                if (to) {
                    // Include the full "to" day
                    const toDate = new Date(to);
                    toDate.setHours(23, 59, 59, 999);
                    cond.$lte = toDate;
                }
                return Object.keys(cond).length > 0 ? cond : null;
            }

            case 'boolean': {
                if (value === undefined || value === null || value === '') return null;
                return value === true || value === 'true';
            }

            default:
                return null;
        }
    }
}

export default new LeadService();
