import Lead from '../models/leadModel.js';
import LeadCollection from '../models/leadCollectionModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import { performUpsert, performGet, performDelete, perfomDataExistanceCheck } from '../config/mongoConnector.js';
import collectionService, { SYSTEM_FIELDS, STAGE_FIELD } from './collectionService.js';
import { emitEvent, EVENTS } from './eventBus.js';

/** Sentinel values that mean "clear the responsible / unassign". */
const UNASSIGNED_VALUES = new Set(['', 'none', 'None', null, undefined]);

/** Fields that are internal / framework-managed and should never be treated as lead data */
const INTERNAL_FIELDS = new Set(['_id', 'acctId', 'collectionId', '__v', 'createdAt', 'updatedAt', 'collection']);

class LeadService {
    /**
     * Create one or more leads.
     *
     * Validation rules:
     *  - The collection must already exist in the DB.
     *  - Every key in the payload must be a field defined in the collection (system or user-defined).
     *  - The "id" field is mandatory (system field).
     *
     * @param {object|object[]} leadData   — single lead object or array
     * @param {string}          acctId
     * @param {string|null}     collection — collection name (uses default when null)
     * @param {string[]|null}   mergeProperties
     */
    async createLead(leadData, acctId, collection = null, mergeProperties = null) {
        const collectionName = collection || 'default';

        // ── 1. Resolve & validate collection ────────────────────────────────
        const collectionDoc = await collectionService.findByName(acctId, collectionName);
        if (!collectionDoc) {
            const err = new Error(`Collection "${collectionName}" not found. Create it in Settings → Collection before pushing data.`);
            err.statusCode = 404;
            throw err;
        }
        const collectionId = collectionDoc._id;

        // Build set of allowed field keys: system + stage + user-defined
        const allowedFields = new Set([
            ...SYSTEM_FIELDS.map(f => f.field),
            STAGE_FIELD.field,
            ...(collectionDoc.fields || []).map(f => f.field)
        ]);

        // Stage resolution: valid ids, the default (first) stage, and id→name for events.
        const stageIds        = new Set((collectionDoc.stages || []).map(s => s.id));
        const defaultStageId  = collectionService.getFirstStageId(collectionDoc);
        const stageNameById   = new Map((collectionDoc.stages || []).map(s => [s.id, s.name]));

        const hasStageValue = (v) => v !== undefined && v !== null && v !== '';

        // ── 2. Validate each item in the payload ────────────────────────────
        const items = (Array.isArray(leadData) ? leadData : [leadData]).map(item => ({ ...item }));

        // `responsible` accepts a chatbotAdminId, account-admin _id, or userId.
        // Resolve all three forms to the canonical lead-app userId before storage.
        const identifierValue = value => value === undefined || value === null ? '' : String(value).trim();
        const hasIdentifier = value => identifierValue(value) !== '';
        const responsibleIds = new Set();

        for (const item of items) {
            if (hasIdentifier(item.responsible)) responsibleIds.add(identifierValue(item.responsible));
        }

        const admins = responsibleIds.size
            ? await AccountAdmin.find(
                {
                    acctId,
                    $or: [
                        { chatbotAdminId: { $in: [...responsibleIds] } },
                        { _id: { $in: [...responsibleIds] } },
                        { userId: { $in: [...responsibleIds] } }
                    ]
                },
                { chatbotAdminId: 1, userId: 1 }
            ).lean()
            : [];

        const userIdByChatbotId = new Map(admins.map(admin => [String(admin.chatbotAdminId), admin.userId]));
        const userIdByAccountAdminId = new Map(admins.map(admin => [String(admin._id), admin.userId]));
        const userIdByUserId = new Map(admins.map(admin => [String(admin.userId), admin.userId]));

        for (const item of items) {
            if (hasIdentifier(item.responsible)) {
                const id = identifierValue(item.responsible);
                const userId = userIdByChatbotId.get(id)
                    ?? userIdByAccountAdminId.get(id)
                    ?? userIdByUserId.get(id);
                if (!userId) {
                    const err = new Error(`No admin found for responsible identifier "${id}" in this account.`);
                    err.statusCode = 400;
                    throw err;
                }
                item.responsible = userId;
            }
        }

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

            // A supplied stage must be one of the collection's stage ids.
            if (hasStageValue(item.stage) && !stageIds.has(Number(item.stage))) {
                const err = new Error(
                    `Unknown stage "${item.stage}" for collection "${collectionName}". ` +
                    `Use one of: ${[...stageIds].join(', ') || '(none)'}.`
                );
                err.statusCode = 400;
                throw err;
            }

            // Reject unknown fields
            const unknownFields = Object.keys(item).filter(k => !INTERNAL_FIELDS.has(k) && !allowedFields.has(k));
            if (unknownFields.length > 0) {
                const err = new Error(
                    `Unknown field(s) for collection "${collectionName}": ${unknownFields.join(', ')}. ` +
                    `Define them in Settings → Collection before using them.`
                );
                err.statusCode = 400;
                throw err;
            }
        }

        // ── 3. Insert lead(s) ───────────────────────────────────────────────
        // Default the stage to the collection's first stage when omitted; coerce to Number.
        const addMeta = (item) => {
            const meta = { ...item, acctId, collectionId };
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
                const ops = items.map(item => {
                    const enriched = addMeta({ ...item });
                    return { updateOne: { filter: buildMergeFilter(item), update: { $set: enriched }, upsert: true } };
                });
                await Lead.bulkWrite(ops, { ordered: false });
                const mergeFilters = items.map(item => buildMergeFilter(item));
                leadResult = await Lead.find({ $or: mergeFilters }).lean();
            } else {
                const results = await Promise.all(
                    items.map(item => performUpsert(Lead, {}, addMeta({ ...item })))
                );
                leadResult = results.map(r => r.doc);
            }
        } else {
            const item = items[0];
            const result = await performUpsert(Lead, buildMergeFilter(item), addMeta(item));
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
            emitEvent(EVENTS.LEAD_CREATED, { acctId, collectionId: lead.collectionId ?? collectionId, data: { leadId: lead._id, lead, stage } });
        }

        return { lead: leadResult, collectionId };
    }

    /**
     * Get paginated leads.
     *
     * Filters are passed as a `fieldFilters` JSON string for typed filtering:
     *   { fieldName: { type: 'text'|'number'|'date'|'boolean', value?, op?, min?, max?, from?, to? } }
     *
     * collectionFields is intentionally NOT returned here — the UI fetches column
     * definitions separately via GET /collections/:id/fields.
     */
    async getAllLeads(filters = {}) {
        const {
            page = 1,
            limit = 10,
            sortBy = 'updatedAt',
            sortOrder = -1,
            search,
            acctId,
            collectionId,
            fieldFilters: fieldFiltersRaw,
            responsibleFilter,
            // Per-admin visibility: superadmins see all leads; everyone else sees
            // only leads assigned to them (responsible === their userId).
            accessLevel,
            userId
        } = filters;

        const restrictToOwn = accessLevel !== 'superadmin' && !!userId;

        const query = { acctId };
        if (collectionId) query.collectionId = collectionId;
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
            if (collectionId) scopeConditions.push({ collectionId });
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
            delete query.collectionId;
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

        // Expose the collection's field keys (system + stage + user-defined) so the
        // analytics axis pickers have a source of truth. Account-wide view (no
        // collectionId) falls back to system fields + stage only.
        let fields = [...SYSTEM_FIELDS.map(f => f.field), STAGE_FIELD.field];
        if (collectionId) {
            const col = await LeadCollection.findOne({ _id: collectionId, acctId }, { fields: 1 }).lean();
            if (col) fields = [...SYSTEM_FIELDS.map(f => f.field), STAGE_FIELD.field, ...(col.fields || []).map(f => f.field)];
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
        const { acctId, prevResponsible = null, prevStage = null, collectionId = null } = context;
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

        // Collection the lead belongs to — webhooks are scoped per collection.
        const evtCollectionId = collectionId || doc?.collectionId || null;

        // Emit assignment transition events for webhooks
        if (hasResponsible && String(prevResponsible || '') !== String(nextResponsible || '')) {
            if (nextResponsible) {
                emitEvent(EVENTS.LEAD_ASSIGNED, { acctId, collectionId: evtCollectionId, data: { leadId: id, responsible: nextResponsible, previous: prevResponsible, lead: doc } });
            } else {
                emitEvent(EVENTS.LEAD_UNASSIGNED, { acctId, collectionId: evtCollectionId, data: { leadId: id, previous: prevResponsible, lead: doc } });
            }
        }

        // Emit a stage-change event when the lead actually moves to a different stage.
        if (hasStage && nextStageNum !== null && prevStageNum !== nextStageNum) {
            const stageMap = collectionId ? await collectionService.resolveStageMap(acctId, collectionId) : {};
            emitEvent(EVENTS.LEAD_STAGE_CHANGED, {
                acctId,
                collectionId: evtCollectionId,
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

    /**
     * Unassign every lead currently assigned to an admin (responsible === userId)
     * within an account. Used when an admin is removed from the account so their
     * leads don't keep pointing at a non-existent admin.
     *
     * Clears responsible and its name/image snapshots, and emits a lead.unassigned
     * event per affected lead so webhooks stay consistent.
     *
     * @param {string} acctId
     * @param {string} userId  — the removed admin's lead-app user id
     * @returns {Promise<number>} number of leads unassigned
     */
    async unassignAdminLeads(acctId, userId) {
        if (!acctId || !userId) return 0;

        const affected = await Lead.find({ acctId, responsible: userId }, { _id: 1, collectionId: 1 }).lean();
        if (affected.length === 0) return 0;

        await Lead.updateMany(
            { acctId, responsible: userId },
            { $unset: { responsible: '', responsibleName: '', responsibleProfileImage: '' } }
        );

        for (const lead of affected) {
            emitEvent(EVENTS.LEAD_UNASSIGNED, { acctId, collectionId: lead.collectionId ?? null, data: { leadId: lead._id, previous: userId, lead: null } });
        }

        return affected.length;
    }

    /**
     * Reassign every lead from one admin to another within an account
     * (responsible: fromUserId → toUserId). Used when an account link maps an
     * existing Botamation admin (chatbotAdminId) onto a different lead-app user —
     * the leads must follow the admin to the new user id.
     *
     * Refreshes the responsible name/image snapshots to the new admin, and emits a
     * lead.assigned event per affected lead.
     *
     * @param {string} acctId
     * @param {string} fromUserId
     * @param {string} toUserId
     * @param {{name?: string|null, profileImage?: string|null}} snapshot — new admin's display fields
     * @returns {Promise<number>} number of leads reassigned
     */
    async reassignAdminLeads(acctId, fromUserId, toUserId, snapshot = {}) {
        if (!acctId || !fromUserId || !toUserId || String(fromUserId) === String(toUserId)) return 0;

        const affected = await Lead.find({ acctId, responsible: fromUserId }, { _id: 1, collectionId: 1 }).lean();
        if (affected.length === 0) return 0;

        const set = { responsible: toUserId };
        if (snapshot.name !== undefined) set.responsibleName = snapshot.name;
        if (snapshot.profileImage !== undefined) set.responsibleProfileImage = snapshot.profileImage;

        await Lead.updateMany({ acctId, responsible: fromUserId }, { $set: set });

        for (const lead of affected) {
            emitEvent(EVENTS.LEAD_ASSIGNED, { acctId, collectionId: lead.collectionId ?? null, data: { leadId: lead._id, responsible: toUserId, previous: fromUserId, lead: null } });
        }

        return affected.length;
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
