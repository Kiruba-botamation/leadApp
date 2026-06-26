import Lead from '../models/leadModel.js';
import LeadCategory from '../models/leadCategoryModel.js';
import { performUpsert, performGet, performDelete, perfomDataExistanceCheck } from '../config/mongoConnector.js';
import categoryService, { SYSTEM_FIELDS, STAGE_FIELD } from './categoryService.js';
import { emitEvent, EVENTS } from './eventBus.js';

/** Sentinel values that mean "clear the responsible / unassign". */
const UNASSIGNED_VALUES = new Set(['', 'none', 'None', null, undefined]);

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

        // Build set of allowed field keys: system + stage + user-defined
        const allowedFields = new Set([
            ...SYSTEM_FIELDS.map(f => f.field),
            STAGE_FIELD.field,
            ...(categoryDoc.fields || []).map(f => f.field)
        ]);

        // Stage resolution: valid ids, the default (first) stage, and id→name for events.
        const stageIds        = new Set((categoryDoc.stages || []).map(s => s.id));
        const defaultStageId  = categoryService.getFirstStageId(categoryDoc);
        const stageNameById   = new Map((categoryDoc.stages || []).map(s => [s.id, s.name]));

        const hasStageValue = (v) => v !== undefined && v !== null && v !== '';

        // ── 2. Validate each item in the payload ────────────────────────────
        const items = Array.isArray(leadData) ? leadData : [leadData];
        for (const item of items) {
            // Mandatory system fields: "name" and "phone"
            if (!item.name) {
                const err = new Error('Field "name" is required for all leads.');
                err.statusCode = 400;
                throw err;
            }
            if (!item.phone) {
                const err = new Error('Field "phone" is required for all leads.');
                err.statusCode = 400;
                throw err;
            }

            // A supplied stage must be one of the category's stage ids.
            if (hasStageValue(item.stage) && !stageIds.has(Number(item.stage))) {
                const err = new Error(
                    `Unknown stage "${item.stage}" for category "${categoryName}". ` +
                    `Use one of: ${[...stageIds].join(', ') || '(none)'}.`
                );
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
        // Default the stage to the category's first stage when omitted; coerce to Number.
        const addMeta = (item) => {
            const meta = { ...item, acctId, categoryId };
            const sid = hasStageValue(item.stage) ? Number(item.stage) : defaultStageId;
            if (sid !== null && sid !== undefined) meta.stage = sid;
            return meta;
        };

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

        // Emit a created event per lead so webhooks can fan out to external systems.
        // Include resolved stage details — a lead can be created directly on any stage.
        const createdLeads = Array.isArray(leadResult) ? leadResult : [leadResult];
        for (const lead of createdLeads) {
            if (!lead) continue;
            const stage = (lead.stage !== undefined && lead.stage !== null)
                ? { id: lead.stage, name: stageNameById.get(lead.stage) ?? null }
                : null;
            emitEvent(EVENTS.LEAD_CREATED, { acctId, data: { leadId: lead._id, lead, stage } });
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
            fieldFilters: fieldFiltersRaw,
            responsibleFilter,
            // Per-admin visibility: superadmins see all leads; everyone else sees
            // only leads assigned to them (responsible === their userId).
            accessLevel,
            userId
        } = filters;

        const restrictToOwn = accessLevel !== 'superadmin' && !!userId;

        const query = { acctId };
        if (categoryId) query.categoryId = categoryId;
        if (restrictToOwn) {
            query.responsible = userId;
        } else if (accessLevel === 'superadmin' && responsibleFilter) {
            if (responsibleFilter === '__unassigned__') {
                query.$or = [{ responsible: { $exists: false } }, { responsible: null }, { responsible: '' }];
            } else {
                query.responsible = responsibleFilter;
            }
        }

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
            if (restrictToOwn) scopeConditions.push({ responsible: userId });
            else if (accessLevel === 'superadmin' && responsibleFilter) {
                if (responsibleFilter === '__unassigned__') {
                    scopeConditions.push({ $or: [{ responsible: { $exists: false } }, { responsible: null }, { responsible: '' }] });
                } else {
                    scopeConditions.push({ responsible: responsibleFilter });
                }
            }
            const stringFields = Object.keys(Lead.schema.paths).filter(
                k => Lead.schema.paths[k].instance === 'String' && !['_id', 'acctId', 'responsible'].includes(k)
            );
            const searchConditions = stringFields.map(field => ({ [field]: { $regex: search, $options: 'i' } }));
            query.$and = [...scopeConditions, { $or: searchConditions }];
            delete query.acctId;
            delete query.categoryId;
            delete query.responsible;
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
                                localField:   'responsible',
                                foreignField: 'userId',
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
                                                else: { $cond: [{ $ifNull: ['$responsible', false] }, 'Unknown', null] }
                                            }
                                        }
                                    }
                                },
                                adminProfileImage: { $arrayElemAt: ['$_adminArr.profileImage', 0] }
                            }
                        },
                        { $project: { _adminArr: 0 } }
                    ],
                    total: [{ $count: 'count' }]
                }
            }
        ];

        const [aggResult] = await Lead.aggregate(pipeline).option({ allowDiskUse: true });

        // Expose the category's field keys (system + stage + user-defined) so the
        // analytics axis pickers have a source of truth. Account-wide view (no
        // categoryId) falls back to system fields + stage only.
        let fields = [...SYSTEM_FIELDS.map(f => f.field), STAGE_FIELD.field];
        if (categoryId) {
            const cat = await LeadCategory.findOne({ _id: categoryId, acctId }, { fields: 1 }).lean();
            if (cat) fields = [...SYSTEM_FIELDS.map(f => f.field), STAGE_FIELD.field, ...(cat.fields || []).map(f => f.field)];
        }

        return {
            data: aggResult?.data ?? [],
            fields,
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

    /**
     * Update a lead by _id.
     *
     * When `responsible` is part of the update we:
     *   - resolve & snapshot the assignee's name/image (so it survives admin removal),
     *   - clear the field + snapshot when the value is an "unassigned" sentinel,
     *   - emit lead.assigned / lead.unassigned events on an actual transition.
     *
     * @param {string} id
     * @param {object} updateData
     * @param {object} context  { acctId, prevResponsible }
     */
    async updateLead(id, updateData, context = {}) {
        const { acctId, prevResponsible = null, prevStage = null, categoryId = null } = context;
        const data = { ...updateData };

        const hasResponsible = Object.prototype.hasOwnProperty.call(data, 'responsible');
        const unassigning = hasResponsible && UNASSIGNED_VALUES.has(data.responsible);
        let nextResponsible = null;

        if (hasResponsible && !unassigning) {
            nextResponsible = data.responsible;
        }

        // Stage transition detection. Coerce to Number so leads store a numeric
        // stage id (the grid filters by number) and comparisons are reliable.
        const hasStage  = Object.prototype.hasOwnProperty.call(data, 'stage');
        const prevStageNum = (prevStage === null || prevStage === undefined || prevStage === '') ? null : Number(prevStage);
        let   nextStageNum = null;
        if (hasStage) {
            nextStageNum = (data.stage === null || data.stage === undefined || data.stage === '') ? null : Number(data.stage);
            if (nextStageNum !== null) data.stage = nextStageNum;
        }

        let doc;
        if (unassigning) {
            delete data.responsible;
            doc = await Lead.findOneAndUpdate(
                { _id: id },
                { $set: data, $unset: { responsible: '', responsibleName: '', responsibleProfileImage: '' } },
                { new: true }
            ).lean();
        } else {
            const result = await performUpsert(Lead, { _id: id }, data);
            doc = result.doc || null;
        }

        // Emit assignment transition events for webhooks
        if (hasResponsible && String(prevResponsible || '') !== String(nextResponsible || '')) {
            if (nextResponsible) {
                emitEvent(EVENTS.LEAD_ASSIGNED, { acctId, data: { leadId: id, responsible: nextResponsible, previous: prevResponsible, lead: doc } });
            } else {
                emitEvent(EVENTS.LEAD_UNASSIGNED, { acctId, data: { leadId: id, previous: prevResponsible, lead: doc } });
            }
        }

        // Emit a stage-change event when the lead actually moves to a different stage.
        if (hasStage && nextStageNum !== null && prevStageNum !== nextStageNum) {
            const stageMap = categoryId ? await categoryService.resolveStageMap(acctId, categoryId) : {};
            emitEvent(EVENTS.LEAD_STAGE_CHANGED, {
                acctId,
                data: {
                    leadId:   id,
                    previous: prevStageNum === null ? null : { id: prevStageNum, name: stageMap[prevStageNum] ?? null },
                    current:  { id: nextStageNum, name: stageMap[nextStageNum] ?? null },
                    lead:     doc
                }
            });
        }

        return doc;
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
