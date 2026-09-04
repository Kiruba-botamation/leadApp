import Lead from '../models/leadModel.js';
import LeadCollection from '../models/leadCollectionModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import LeadNote from '../models/leadNoteModel.js';
import LeadReminder from '../models/leadReminderModel.js';
import { performUpsert } from '../config/mongoConnector.js';
import { cancelReminderJobs } from '../queue/reminderQueue.js';
import collectionService, { SYSTEM_FIELDS, STAGE_FIELD } from './collectionService.js';
import { emitEvent, EVENTS } from './eventBus.js';
import {
    assertSafeFieldKey,
    buildKeysetCondition,
    decodeLeadCursor,
    encodeLeadCursor,
    escapeRegexLiteral,
    parseFieldFilters,
    parseLeadLimit
} from '../utils/leadQueryUtils.js';

/** Sentinel values that mean "clear the responsible / unassign". */
const UNASSIGNED_VALUES = new Set(['', 'none', 'None', null, undefined]);

/** Fields that are internal / framework-managed and should never be treated as lead data */
const INTERNAL_FIELDS = new Set(['_id', 'acctId', 'collectionId', '__v', 'createdAt', 'updatedAt', 'collection']);
const MAX_CREATE_BATCH_SIZE = 1000;
const MAX_LEAD_FIELDS = 150;
const MAX_LEAD_DOCUMENT_BYTES = 512 * 1024;
const MERGE_WRITE_BATCH_SIZE = 100;
const LEAD_QUERY_MAX_TIME_MS = Number.parseInt(process.env.LEAD_QUERY_MAX_TIME_MS || '5000', 10);

const identifierValue = value => value === undefined || value === null ? '' : String(value).trim();

export function resolveResponsibleUserIds(admins, identifiers) {
    const byChatbotAdminId = new Map();
    const byAdminId = new Map();
    const byUserId = new Map();

    for (const admin of admins) {
        if (identifierValue(admin.chatbotAdminId)) byChatbotAdminId.set(identifierValue(admin.chatbotAdminId), admin.userId);
        if (identifierValue(admin._id)) byAdminId.set(identifierValue(admin._id), admin.userId);
        if (identifierValue(admin.userId)) byUserId.set(identifierValue(admin.userId), admin.userId);
    }

    return new Map(identifiers.map(identifier => {
        const id = identifierValue(identifier);
        return [id, byChatbotAdminId.get(id) ?? byAdminId.get(id) ?? byUserId.get(id)];
    }));
}

async function findResponsibleUserIds(acctId, identifiers) {
    const ids = [...new Set(identifiers.map(identifierValue).filter(Boolean))];
    if (!ids.length) return new Map();

    const admins = await AccountAdmin.find({
        acctId,
        $or: [
            { chatbotAdminId: { $in: ids } },
            { _id: { $in: ids } },
            { userId: { $in: ids } }
        ]
    }, { chatbotAdminId: 1, userId: 1 }).lean();

    return resolveResponsibleUserIds(admins, ids);
}

function requestError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

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
     * @param {string|null}     collection
     * @param {string[]|null}   mergeProperties
     */
    async createLead(leadData, acctId, collection = null, mergeProperties = null) {
        const collectionDoc = collection
            ? await collectionService.findByName(acctId, collection)
            : await collectionService.findDefault(acctId);
        if (!collectionDoc) {
            const err = new Error(collection ? `Collection "${collection}" not found.` : 'Default collection not found.');
            err.statusCode = 404;
            throw err;
        }
        const collectionName = collectionDoc.collectionName;
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
        if (items.length > MAX_CREATE_BATCH_SIZE) {
            throw requestError(`A lead batch cannot exceed ${MAX_CREATE_BATCH_SIZE} items`);
        }

        if (mergeProperties !== null) {
            if (!Array.isArray(mergeProperties) || mergeProperties.length === 0) {
                throw requestError('merge.properties must be a non-empty array when merge is enabled');
            }
            for (const property of mergeProperties) assertSafeFieldKey(property, allowedFields, 'merge property');
        }

        const hasIdentifier = value => identifierValue(value) !== '';
        const responsibleIds = new Set();

        for (const item of items) {
            if (hasIdentifier(item.responsible)) responsibleIds.add(identifierValue(item.responsible));
        }

        const responsibleUserIds = await findResponsibleUserIds(acctId, [...responsibleIds]);

        for (const item of items) {
            if (hasIdentifier(item.responsible)) {
                const id = identifierValue(item.responsible);
                const userId = responsibleUserIds.get(id);
                if (!userId) {
                    const err = new Error(`No admin found for responsible identifier "${id}" in this account.`);
                    err.statusCode = 400;
                    throw err;
                }
                item.responsible = userId;
            }
        }

        for (const item of items) {
            if (Object.keys(item).length > MAX_LEAD_FIELDS || Buffer.byteLength(JSON.stringify(item)) > MAX_LEAD_DOCUMENT_BYTES) {
                throw requestError('Lead exceeds the supported field or document size');
            }
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
            const filter = { acctId, collectionId };
            for (const prop of mergeProperties) {
                if (!Object.hasOwn(item, prop) || item[prop] === undefined) {
                    throw requestError(`Merge property "${prop}" is required on every lead`);
                }
                filter[prop] = item[prop];
            }
            return filter;
        };

        let leadResult;
        if (Array.isArray(leadData)) {
            if (mergeProperties?.length) {
                leadResult = [];
                for (let start = 0; start < items.length; start += MERGE_WRITE_BATCH_SIZE) {
                    const batch = items.slice(start, start + MERGE_WRITE_BATCH_SIZE);
                    const filters = batch.map(buildMergeFilter);
                    const ops = batch.map((item, index) => ({
                        updateOne: { filter: filters[index], update: { $set: addMeta(item) }, upsert: true }
                    }));
                    await Lead.bulkWrite(ops, { ordered: false });
                    const docs = await Lead.find({ acctId, collectionId, $or: filters }, null, { maxTimeMS: LEAD_QUERY_MAX_TIME_MS }).lean();
                    leadResult.push(...docs);
                }
            } else {
                leadResult = await Lead.insertMany(items.map(item => addMeta(item)), { ordered: false });
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
            limit = 10,
            sortBy = 'updatedAt',
            sortOrder = -1,
            search,
            acctId,
            collectionId,
            fieldFilters: fieldFiltersRaw,
            responsibleFilter,
            cursor: cursorRaw,
            includeCount = false,
            requestedFields,
            // Per-admin visibility: superadmins see all leads; everyone else sees
            // only leads assigned to them (responsible === their userId).
            accessLevel,
            userId
        } = filters;
        if (typeof acctId !== 'string' || !acctId) throw requestError('acctId is required');
        if (collectionId !== undefined && collectionId !== null && typeof collectionId !== 'string') {
            throw requestError('collectionId must be a string');
        }
        const boundedLimit = parseLeadLimit(limit);

        let collectionDoc = null;
        if (collectionId) {
            collectionDoc = await LeadCollection.findOne({ _id: collectionId, acctId }, { fields: 1 }).lean();
            if (!collectionDoc) throw requestError('Collection not found', 404);
        }

        const configuredFields = collectionDoc?.fields || [];
        const allowedDataFields = new Set([
            ...SYSTEM_FIELDS.map(field => field.field),
            STAGE_FIELD.field,
            ...configuredFields.map(field => field.field)
        ]);
        const allowedQueryFields = new Set([...allowedDataFields, 'createdAt', 'updatedAt', '_id']);
        assertSafeFieldKey(sortBy, allowedQueryFields, 'sort');
        if (![1, -1].includes(sortOrder)) throw requestError('sortOrder must be asc, desc, 1, or -1');

        const fieldTypes = new Map([
            ...SYSTEM_FIELDS.map(field => [field.field, field.type]),
            [STAGE_FIELD.field, 'number'],
            ...configuredFields.map(field => [field.field, field.type]),
            ['createdAt', 'date'],
            ['updatedAt', 'date'],
            ['_id', 'text']
        ]);
        const filterableFields = new Set([...allowedDataFields, 'createdAt', 'updatedAt']);
        const conditions = [{ acctId }];
        if (collectionId) conditions.push({ collectionId });

        const restrictToOwn = accessLevel !== 'superadmin' && !!userId;
        if (restrictToOwn) conditions.push({ responsible: userId });
        else if (accessLevel === 'superadmin' && responsibleFilter) {
            if (typeof responsibleFilter !== 'string' || responsibleFilter.length > 256) {
                throw requestError('responsibleFilter must be a string');
            }
            conditions.push(responsibleFilter === '__unassigned__'
                ? { $or: [{ responsible: { $exists: false } }, { responsible: null }, { responsible: '' }] }
                : { responsible: responsibleFilter });
        }

        const typedFilters = parseFieldFilters(fieldFiltersRaw, filterableFields, fieldTypes);
        for (const [key, value] of Object.entries(typedFilters)) conditions.push({ [key]: value });

        if (search !== undefined && search !== null && search !== '') {
            const escapedSearch = escapeRegexLiteral(search, 'search');
            const stringFields = [...fieldTypes.entries()]
                .filter(([field, type]) => type === 'text' && !['_id', 'responsible'].includes(field))
                .map(([field]) => field);
            if (stringFields.length) {
                // Atlas Search is deferred until an Atlas index and tenant-aware search mapping are deployed.
                conditions.push({ $or: stringFields.map(field => ({ [field]: { $regex: escapedSearch, $options: 'i' } })) });
            }
        }

        const selectedFields = requestedFields
            ? String(requestedFields).split(',').map(field => field.trim()).filter(Boolean)
            : [...allowedDataFields];
        if (requestedFields && selectedFields.length === 0) throw requestError('fields must contain at least one field');
        for (const field of selectedFields) assertSafeFieldKey(field, allowedDataFields, 'projection');
        const projection = Object.fromEntries([
            ...selectedFields,
            '_id', 'acctId', 'collectionId', 'createdAt', 'updatedAt', 'responsible', sortBy
        ].map(field => [field, 1]));

        let decodedCursor = cursorRaw ? decodeLeadCursor(cursorRaw, { sortBy, sortOrder }) : null;
        if (decodedCursor && ['createdAt', 'updatedAt'].includes(sortBy) && decodedCursor.value !== null) {
            const date = new Date(decodedCursor.value);
            if (Number.isNaN(date.getTime())) throw requestError('Invalid cursor');
            decodedCursor = { ...decodedCursor, value: date };
        }

        const pageConditions = decodedCursor
            ? [...conditions, buildKeysetCondition(sortBy, sortOrder, decodedCursor)]
            : conditions;
        const found = await Lead.find({ $and: pageConditions }, projection)
            .sort({ [sortBy]: sortOrder, _id: sortOrder })
            .limit(boundedLimit + 1)
            .maxTimeMS(LEAD_QUERY_MAX_TIME_MS)
            .lean();
        const hasNextPage = found.length > boundedLimit;
        let rows = found.slice(0, boundedLimit);

        const responsibleIds = [...new Set(rows.map(row => row.responsible).filter(Boolean))];
        const admins = responsibleIds.length
            ? await AccountAdmin.find({ acctId, userId: { $in: responsibleIds } }, { userId: 1, firstName: 1, lastName: 1, profileImage: 1 })
                .maxTimeMS(LEAD_QUERY_MAX_TIME_MS).lean()
            : [];
        const adminByUserId = new Map(admins.map(admin => [String(admin.userId), admin]));
        rows = rows.map(row => {
            if (!row.responsible) return { ...row, adminName: null, adminProfileImage: null };
            const admin = adminByUserId.get(String(row.responsible));
            const name = admin ? `${admin.firstName || ''} ${admin.lastName || ''}`.trim() : '';
            return { ...row, adminName: name || 'Unknown', adminProfileImage: admin?.profileImage || null };
        });

        const last = rows.at(-1);
        const nextCursor = hasNextPage && last
            ? encodeLeadCursor({ sortBy, sortOrder, value: last[sortBy] ?? null, id: String(last._id) })
            : null;
        const total = includeCount
            ? await Lead.countDocuments({ $and: conditions }).maxTimeMS(LEAD_QUERY_MAX_TIME_MS)
            : null;

        return {
            data: rows,
            fields: [...allowedDataFields],
            pageInfo: {
                hasNextPage,
                nextCursor
            },
            total
        };
    }

    /** Get a single lead by _id */
    async getLeadById(id, acctId) {
        if (!acctId) throw requestError('acctId is required');
        return Lead.findOne({ _id: id, acctId }).maxTimeMS(LEAD_QUERY_MAX_TIME_MS).lean();
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
        if (!acctId || !collectionId) throw requestError('Account and collection context are required');
        if (Object.keys(data).length > MAX_LEAD_FIELDS || Buffer.byteLength(JSON.stringify(data)) > MAX_LEAD_DOCUMENT_BYTES) {
            throw requestError('Lead update exceeds the supported field or document size');
        }
        const collectionDoc = await LeadCollection.findOne({ _id: collectionId, acctId }, { fields: 1, stages: 1 }).lean();
        if (!collectionDoc) throw requestError('Collection not found', 404);
        const allowedUpdateFields = new Set([
            ...SYSTEM_FIELDS.map(field => field.field),
            STAGE_FIELD.field,
            ...(collectionDoc.fields || []).map(field => field.field)
        ]);
        for (const key of Object.keys(data)) assertSafeFieldKey(key, allowedUpdateFields, 'update field');

        const hasResponsible = Object.prototype.hasOwnProperty.call(data, 'responsible');
        const unassigning = hasResponsible && UNASSIGNED_VALUES.has(data.responsible);
        let nextResponsible = null;

        if (hasResponsible && !unassigning) {
            const id = identifierValue(data.responsible);
            const responsibleUserIds = await findResponsibleUserIds(acctId, [id]);
            nextResponsible = responsibleUserIds.get(id);
            if (!nextResponsible) throw requestError('Responsible admin does not belong to this account');
            data.responsible = nextResponsible;
        }

        // Stage transition detection. Coerce to Number so leads store a numeric
        // stage id (the grid filters by number) and comparisons are reliable.
        const hasStage  = Object.prototype.hasOwnProperty.call(data, 'stage');
        const prevStageNum = (prevStage === null || prevStage === undefined || prevStage === '') ? null : Number(prevStage);
        let   nextStageNum = null;
        if (hasStage) {
            nextStageNum = (data.stage === null || data.stage === undefined || data.stage === '') ? null : Number(data.stage);
            if (nextStageNum !== null && !(collectionDoc.stages || []).some(stage => stage.id === nextStageNum)) {
                throw requestError('Unknown stage for this collection');
            }
            if (nextStageNum !== null) data.stage = nextStageNum;
        }

        let doc;
        if (unassigning) {
            delete data.responsible;
            doc = await Lead.findOneAndUpdate(
                { _id: id, acctId },
                { $set: data, $unset: { responsible: '', responsibleName: '', responsibleProfileImage: '' } },
                { new: true }
            ).lean();
        } else {
            doc = await Lead.findOneAndUpdate({ _id: id, acctId }, { $set: data }, { new: true }).lean();
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
    async deleteLead(id, acctId) {
        if (!acctId) throw requestError('acctId is required');
        while (true) {
            const reminders = await LeadReminder.find({ acctId, leadId: id }, { _id: 1 })
                .limit(200)
                .maxTimeMS(LEAD_QUERY_MAX_TIME_MS)
                .lean();
            if (!reminders.length) break;
            const reminderIds = reminders.map(reminder => reminder._id);
            await LeadReminder.updateMany(
                { acctId, leadId: id, _id: { $in: reminderIds } },
                { $set: { mainSent: true, preReminderSent: true, clientSent: true, jobScheduled: false, clientJobScheduled: false } }
            );
            await Promise.allSettled(reminderIds.map(reminderId => cancelReminderJobs(reminderId)));
            await LeadReminder.deleteMany({ acctId, leadId: id, _id: { $in: reminderIds } });
        }
        await LeadNote.deleteMany({ acctId, leadId: id });
        const result = await Lead.deleteOne({ _id: id, acctId });
        return result.deletedCount === 1;
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
        let total = 0;
        while (true) {
            const affected = await Lead.find(
                { acctId, responsible: userId },
                { _id: 1, collectionId: 1 }
            ).limit(200).maxTimeMS(LEAD_QUERY_MAX_TIME_MS).lean();
            if (!affected.length) break;
            const ids = affected.map(lead => lead._id);
            await Lead.updateMany(
                { acctId, responsible: userId, _id: { $in: ids } },
                { $unset: { responsible: '', responsibleName: '', responsibleProfileImage: '' } }
            );
            total += affected.length;
            for (const lead of affected) {
                emitEvent(EVENTS.LEAD_UNASSIGNED, { acctId, collectionId: lead.collectionId ?? null, data: { leadId: lead._id, previous: userId, lead: null } });
            }
        }
        return total;
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

        const set = { responsible: toUserId };
        if (snapshot.name !== undefined) set.responsibleName = snapshot.name;
        if (snapshot.profileImage !== undefined) set.responsibleProfileImage = snapshot.profileImage;

        let total = 0;
        while (true) {
            const affected = await Lead.find(
                { acctId, responsible: fromUserId },
                { _id: 1, collectionId: 1 }
            ).limit(200).maxTimeMS(LEAD_QUERY_MAX_TIME_MS).lean();
            if (!affected.length) break;
            const ids = affected.map(lead => lead._id);
            await Lead.updateMany({ acctId, responsible: fromUserId, _id: { $in: ids } }, { $set: set });
            total += affected.length;
            for (const lead of affected) {
                emitEvent(EVENTS.LEAD_ASSIGNED, { acctId, collectionId: lead.collectionId ?? null, data: { leadId: lead._id, responsible: toUserId, previous: fromUserId, lead: null } });
            }
        }
        return total;
    }

}

export default new LeadService();
