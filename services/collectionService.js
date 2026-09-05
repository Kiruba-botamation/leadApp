import LeadCollection from '../models/leadCollectionModel.js';
import Lead from '../models/leadModel.js';
import LeadNote from '../models/leadNoteModel.js';
import LeadReminder from '../models/leadReminderModel.js';
import LeadExport from '../models/leadExportModel.js';
import AnalyticsSchema from '../models/analyticsSchemaModel.js';
import WebhookConfig from '../models/webhookConfigModel.js';
import WebhookDelivery from '../models/webhookDeliveryModel.js';
import { cancelReminderJobs } from '../queue/reminderQueue.js';
import { removeWebhookJobs } from '../queue/webhookQueue.js';
import { performGet, perfomDataExistanceCheck, performCount } from '../config/mongoConnector.js';

/**
 * System fields that every collection implicitly has.
 * These are injected at read-time and NEVER stored in the DB fields array.
 */
export const SYSTEM_FIELDS = [
    {
        label:    'Name',
        field:    'name',
        type:     'text',
        system:   true,
        required: true,
        tooltip:  'Mandatory — full name of the lead'
    },
    {
        label:    'Phone',
        field:    'phone',
        type:     'text',
        system:   true,
        required: true,
        tooltip:  'Mandatory — phone number of the lead'
    },
    {
        label:    'Email',
        field:    'email',
        type:     'text',
        system:   true,
        required: false,
        tooltip:  'Optional — email address of the lead'
    },
    {
        label:    'Responsible',
        field:    'responsible',
        type:     'text',
        system:   true,
        required: false,
        tooltip:  'Optional — represents the assignee of the lead'
    }
];
const SYSTEM_FIELD_KEYS = new Set(SYSTEM_FIELDS.map(field => field.field));

const withSystemFields = (fields = []) => [
    ...SYSTEM_FIELDS,
    ...fields.filter(field => !SYSTEM_FIELD_KEYS.has(field.field))
];

/**
 * The `stage` system field. Kept out of SYSTEM_FIELDS but still an allowed lead field
 * and a selectable analytics axis. Stage values reference a per-collection stage id.
 */
export const STAGE_FIELD = {
    label:    'Stage',
    field:    'stage',
    type:     'stage',
    system:   true,
    required: false,
    tooltip:  'Optional — pipeline stage of the lead'
};

/** Default colour for the seeded "New" stage and any stage saved without a valid colour. */
export const DEFAULT_STAGE_COLOR = '#4f46e5';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DELETE_BATCH_SIZE = 200;

async function deleteReminderBatch(acctId, leadIds) {
    const reminders = await LeadReminder.find(
        { acctId, leadId: { $in: leadIds } },
        { _id: 1 }
    ).limit(DELETE_BATCH_SIZE).lean();
    if (!reminders.length) return false;
    const reminderIds = reminders.map(reminder => reminder._id);

    // Workers require an unsent state to claim a reminder. Neutralize in Mongo
    // first so cancellation remains safe when Redis is unavailable.
    await LeadReminder.updateMany(
        { _id: { $in: reminderIds }, acctId },
        {
            $set: {
                mainSent: true,
                preReminderSent: true,
                clientSent: true,
                jobScheduled: false,
                clientJobScheduled: false
            }
        }
    );
    for (const reminderId of reminderIds) await cancelReminderJobs(reminderId);
    await LeadReminder.deleteMany({ _id: { $in: reminderIds }, acctId });
    return true;
}

async function deleteLeadDependents(acctId, leadIds) {
    while (await deleteReminderBatch(acctId, leadIds)) {
        // Drain the next bounded reminder batch.
    }
    await LeadNote.deleteMany({ acctId, leadId: { $in: leadIds } });
}

export function pruneCollectionAnalytics(schema, collectionId) {
    if (!schema || typeof schema !== 'object' || !Array.isArray(schema.filters)) return schema;
    const id = String(collectionId);
    const filters = schema.filters.filter(chart => {
        const chartCollection = chart?.chartCollection;
        const chartCollectionId = chartCollection && typeof chartCollection === 'object'
            ? chartCollection._id
            : chartCollection;
        return String(chartCollectionId || '') !== id;
    });
    return filters.length === schema.filters.length ? schema : { ...schema, filters };
}

async function deleteCollectionExports(acctId, collectionId) {
    const exports = await LeadExport.find({ acctId, 'input.collectionId': collectionId }).lean();
    if (!exports.length) return;
    const [{ removeExportJobs }, { deleteStoredExport }] = await Promise.all([
        import('../queue/exportQueue.js'),
        import('./exportService.js')
    ]);
    for (const exportDoc of exports) {
        await removeExportJobs(exportDoc).catch(() => {});
        await deleteStoredExport(exportDoc).catch(() => {});
    }
    await LeadExport.deleteMany({ acctId, _id: { $in: exports.map(item => item._id) } });
}

async function deleteCollectionAnalytics(acctId, collectionId) {
    const schemas = await AnalyticsSchema.find({ acctId }, { schema: 1 }).lean();
    const operations = schemas.map(item => ({ item, schema: pruneCollectionAnalytics(item.schema, collectionId) }))
        .filter(({ item, schema }) => schema !== item.schema)
        .map(({ item, schema }) => ({
            updateOne: { filter: { _id: item._id, acctId }, update: { $set: { schema } } }
        }));
    if (operations.length) await AnalyticsSchema.bulkWrite(operations);
}

/** Coerce a colour to a valid 6-digit hex, falling back to the default. */
function normaliseColor(color) {
    return typeof color === 'string' && HEX_COLOR_RE.test(color.trim())
        ? color.trim().toLowerCase()
        : DEFAULT_STAGE_COLOR;
}

/** Stages sorted by display order (tiebreak: lowest id). */
function sortStages(stages = []) {
    return [...stages].sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
}

export const stageIdKey = id => String(id ?? '').trim().toLowerCase();

export function normaliseCustomStageId(id) {
    const value = String(id ?? '').trim();
    if (!/^[A-Za-z0-9]{1,64}$/.test(value)) {
        const err = new Error('Stage ID must contain only letters and numbers (maximum 64 characters)');
        err.statusCode = 400;
        throw err;
    }
    if (value.toLowerCase() === 'reorder') {
        const err = new Error('Stage ID "reorder" is reserved');
        err.statusCode = 400;
        throw err;
    }
    return value;
}

export const resolveStageId = (stages, id) => stages.find(stage => stageIdKey(stage.id) === stageIdKey(id))?.id;

/** Normalise a collection name: lowercase, spaces → underscore, strip non-alphanumeric-underscore */
export function normaliseCollectionName(name) {
    return name
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
}

/** Normalise a column label into a field key: lowercase + spaces to underscore */
export function normaliseFieldKey(label) {
    return label
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
}

class CollectionService {
    /**
     * Get all collections for an account (lightweight list, no field details).
     */
    async getCollections(acctId) {
        const result = await performGet(LeadCollection, { acctId }, [], { sort: { createdAt: 1 } });
        return (result.data || []).map(c => ({
            _id:            c._id,
            collectionName: c.collectionName,
            default:        c.default,
            stages:         sortStages(c.stages)
        }));
    }

    /**
     * Get column definitions for a single collection.
     * System fields are injected at read time and are not stored in the collection.
     */
    async getCollectionFields(acctId, collectionId) {
        const collection = await LeadCollection.findOne({ _id: collectionId, acctId }).lean();
        if (!collection) {
            const err = new Error('Collection not found');
            err.statusCode = 404;
            throw err;
        }

        const fields = withSystemFields(collection.fields);

        return {
            _id:            collection._id,
            collectionName: collection.collectionName,
            default:        collection.default,
            fields,
            stages:         sortStages(collection.stages),
            nextStageId:    collection.nextStageId,
        };
    }

    /**
     * Create a brand-new collection with an optional initial field list.
     */
    async createCollection(acctId, collectionName, fields = []) {
        const normalisedName = normaliseCollectionName(collectionName);
        if (!normalisedName) {
            const err = new Error('Collection name must contain at least one alphanumeric character');
            err.statusCode = 400;
            throw err;
        }

        const existing = await perfomDataExistanceCheck(LeadCollection, { acctId, collectionName: normalisedName });
        if (existing) {
            const err = new Error(`Collection "${normalisedName}" already exists`);
            err.statusCode = 409;
            throw err;
        }

        const count     = await performCount(LeadCollection, { acctId });
        const isDefault = count === 0;

        const validatedFields = this._validateAndNormaliseFields(fields);

        const collection = await LeadCollection.create({
            acctId,
            collectionName: normalisedName,
            default:        isDefault,
            fields:         validatedFields,
            // Every collection starts with one mandatory default stage.
            stages:         [{ id: 1, name: 'New', color: DEFAULT_STAGE_COLOR, order: 0 }],
            nextStageId:    2
        });

        const allFields = withSystemFields(collection.fields);

        return {
            _id:            collection._id,
            collectionName: collection.collectionName,
            default:        collection.default,
            fields:         allFields,
            stages:         sortStages(collection.stages),
            nextStageId:    collection.nextStageId
        };
    }

    /**
     * Update collection name and/or column definitions.
     */
    async updateCollection(acctId, collectionId, { collectionName, fields }) {
        const collection = await LeadCollection.findOne({ _id: collectionId, acctId });
        if (!collection) {
            const err = new Error('Collection not found');
            err.statusCode = 404;
            throw err;
        }

        if (collectionName !== undefined) {
            const normalisedName = normaliseCollectionName(collectionName);
            if (!normalisedName) {
                const err = new Error('Collection name must contain at least one alphanumeric character');
                err.statusCode = 400;
                throw err;
            }

            // Check uniqueness if name actually changes
            if (normalisedName !== collection.collectionName) {
                const duplicate = await perfomDataExistanceCheck(LeadCollection, {
                    acctId,
                    collectionName: normalisedName,
                    _id: { $ne: collectionId }
                });
                if (duplicate) {
                    const err = new Error(`Collection "${normalisedName}" already exists`);
                    err.statusCode = 409;
                    throw err;
                }
            }
            collection.collectionName = normalisedName;
        }

        if (fields !== undefined) {
            collection.fields = this._validateAndNormaliseFields(fields);
        }

        await collection.save();

        const allFields = withSystemFields(collection.fields);

        return {
            _id:            collection._id,
            collectionName: collection.collectionName,
            default:        collection.default,
            fields:         allFields,
            stages:         sortStages(collection.stages),
            nextStageId:    collection.nextStageId
        };
    }

    /**
     * Set a collection as the account default.
     */
    async setDefaultCollection(acctId, collectionId) {
        const collection = await perfomDataExistanceCheck(LeadCollection, { _id: collectionId, acctId });
        if (!collection) {
            const err = new Error('Collection not found');
            err.statusCode = 404;
            throw err;
        }

        await LeadCollection.updateMany({ acctId }, { $set: { default: false } });
        const updated = await LeadCollection.findByIdAndUpdate(
            collectionId,
            { $set: { default: true } },
            { new: true }
        );
        return updated;
    }

    /**
     * Delete a collection and all its leads.
     */
    async deleteCollection(acctId, collectionId) {
        const collection = await LeadCollection.findOne({ _id: collectionId, acctId }).lean();
        if (!collection) {
            const err = new Error('Collection not found');
            err.statusCode = 404;
            throw err;
        }

        let deletedLeads = 0;
        const { removeLeadJobs } = await import('../queue/leadQueue.js');
        await removeLeadJobs({ acctId, collectionName: collection.collectionName });
        while (true) {
            const leads = await Lead.find({ acctId, collectionId }, { _id: 1 })
                .sort({ _id: 1 })
                .limit(DELETE_BATCH_SIZE)
                .lean();
            if (!leads.length) break;
            const leadIds = leads.map(lead => lead._id);

            await deleteLeadDependents(acctId, leadIds);
            const result = await Lead.deleteMany({ acctId, collectionId, _id: { $in: leadIds } });
            deletedLeads += result.deletedCount ?? 0;
            // Catch dependents created after the first sweep but before lead removal.
            await deleteLeadDependents(acctId, leadIds);
        }

        const webhookConfigs = await WebhookConfig.find({ acctId, collectionId }, { _id: 1 }).lean();
        const webhookConfigIds = webhookConfigs.map(config => config._id);
        await removeWebhookJobs({ acctId, configIds: webhookConfigIds });
        await WebhookConfig.deleteMany({ acctId, collectionId });
        await Promise.all([
            WebhookDelivery.deleteMany({ acctId, configId: { $in: webhookConfigIds } }),
            deleteCollectionExports(acctId, collectionId),
            deleteCollectionAnalytics(acctId, collectionId)
        ]);
        // Catch a delivery worker that completed while its config was being removed.
        await WebhookDelivery.deleteMany({ acctId, configId: { $in: webhookConfigIds } });
        await LeadCollection.deleteOne({ _id: collectionId, acctId });

        return {
            deletedLeads,
            deletedCollection: true,
            collectionName:    collection.collectionName
        };
    }

    /**
     * Return the set of allowed field keys for a collection (system + user-defined).
     * Used by leadService to validate incoming payloads.
     */
    async getAllowedFields(acctId, collectionName) {
        const collection = await LeadCollection.findOne({ acctId, collectionName }).lean();
        if (!collection) return null; // caller handles 404

        const userFields   = (collection.fields || []).map(f => f.field);
        const systemFields = SYSTEM_FIELDS.map(f => f.field);
        return new Set([...systemFields, STAGE_FIELD.field, ...userFields]);
    }

    /**
     * Retrieve a collection document by name (for createLead lookup).
     */
    async findByName(acctId, collectionName) {
        return LeadCollection.findOne({ acctId, collectionName }).lean();
    }

    async findDefault(acctId) {
        return LeadCollection.findOne({ acctId, default: true }).lean();
    }

    // ── Stage lifecycle ──────────────────────────────────────────────────────

    /**
     * The id of a collection's "first" stage (lowest order, tiebreak lowest id).
     * Used as the default stage when a lead is created without one, and as the
     * reassignment target when a stage is deleted. Returns null if no stages.
     * Accepts a plain collection doc (lean) or a Mongoose document.
     */
    getFirstStageId(collectionDoc) {
        const sorted = sortStages(collectionDoc?.stages);
        return sorted.length ? sorted[0].id : null;
    }

    /** Build an { [stageId]: name } map for a collection (analytics / MCP / webhooks). */
    async resolveStageMap(acctId, collectionId) {
        const collection = await LeadCollection.findOne({ _id: collectionId, acctId }, { stages: 1 }).lean();
        const map = {};
        for (const s of collection?.stages || []) map[s.id] = s.name;
        return map;
    }

    /** Add a stage to a collection. Returns the updated, sorted stage list. */
    async addStage(acctId, collectionId, { id: requestedId, name, color } = {}) {
        const collection = await this._loadCollectionForStageEdit(acctId, collectionId);

        const trimmed = (name || '').trim();
        if (!trimmed) {
            const err = new Error('Stage name is required');
            err.statusCode = 400;
            throw err;
        }
        this._assertStageNameUnique(collection.stages, trimmed);

        let id;
        if (requestedId === undefined || requestedId === null || requestedId === '') {
            id = Number.isSafeInteger(collection.nextStageId) ? collection.nextStageId : 1;
            while (collection.stages.some(stage => stageIdKey(stage.id) === stageIdKey(id))) id += 1;
            collection.nextStageId = id + 1;
        } else {
            id = normaliseCustomStageId(requestedId);
            const numericId = Number(id);
            const nextStageId = Number.isSafeInteger(collection.nextStageId) ? collection.nextStageId : 1;
            if (Number.isSafeInteger(numericId) && numericId >= nextStageId) {
                collection.nextStageId = numericId + 1;
            }
        }
        this._assertStageIdUnique(collection.stages, id);
        const order = collection.stages.length
            ? Math.max(...collection.stages.map(s => s.order)) + 1
            : 0;

        collection.stages.push({ id, name: trimmed, color: normaliseColor(color), order });
        await collection.save();

        return sortStages(collection.stages);
    }

    /** Update a stage's name / colour / order. Returns the updated, sorted stage list. */
    async updateStage(acctId, collectionId, stageId, { id: requestedId, name, color, order } = {}) {
        const collection = await this._loadCollectionForStageEdit(acctId, collectionId);

        const currentId = resolveStageId(collection.stages, stageId);
        const stage = collection.stages.find(s => s.id === currentId);
        if (!stage) {
            const err = new Error('Stage not found');
            err.statusCode = 404;
            throw err;
        }

        if (name !== undefined) {
            const trimmed = (name || '').trim();
            if (!trimmed) {
                const err = new Error('Stage name cannot be empty');
                err.statusCode = 400;
                throw err;
            }
            this._assertStageNameUnique(collection.stages, trimmed, stage.id);
            stage.name = trimmed;
        }
        if (color !== undefined) stage.color = normaliseColor(color);
        if (order !== undefined && !Number.isNaN(Number(order))) stage.order = Number(order);

        let nextId = currentId;
        if (requestedId !== undefined && stageIdKey(requestedId) !== stageIdKey(currentId)) {
            nextId = normaliseCustomStageId(requestedId);
            this._assertStageIdUnique(collection.stages, nextId, currentId);
            stage.id = nextId;
        }

        await collection.save();
        if (nextId !== currentId) {
            await Lead.updateMany({ acctId, collectionId, stage: currentId }, { $set: { stage: nextId } });
        }
        return sortStages(collection.stages);
    }

    /** Reorder stages to match the given array of stage ids. Returns the sorted list. */
    async reorderStages(acctId, collectionId, orderedIds = []) {
        const collection = await this._loadCollectionForStageEdit(acctId, collectionId);

        const position = new Map(orderedIds.map((id, idx) => [stageIdKey(id), idx]));
        collection.stages.forEach(s => {
            if (position.has(stageIdKey(s.id))) s.order = position.get(stageIdKey(s.id));
        });

        await collection.save();
        return sortStages(collection.stages);
    }

    /**
     * Delete a stage. Leads in that stage are reassigned to the (remaining) first
     * stage. At least one stage must always remain. No per-lead webhook is fired
     * for the bulk reassignment.
     *
     * Returns { stages, reassignedCount, reassignedToStageId }.
     */
    async deleteStage(acctId, collectionId, stageId) {
        const collection = await this._loadCollectionForStageEdit(acctId, collectionId);

        const id = resolveStageId(collection.stages, stageId);
        if (id === undefined) {
            const err = new Error('Stage not found');
            err.statusCode = 404;
            throw err;
        }
        if (collection.stages.length <= 1) {
            const err = new Error('At least one stage is required per collection');
            err.statusCode = 400;
            throw err;
        }

        // First stage among the ones that will remain.
        const remaining   = sortStages(collection.stages.filter(s => s.id !== id));
        const targetId    = remaining[0].id;

        const reassign = await Lead.updateMany(
            { acctId, collectionId, stage: id },
            { $set: { stage: targetId } }
        );

        collection.stages = remaining;
        await collection.save();

        return {
            stages:              sortStages(collection.stages),
            reassignedCount:     reassign.modifiedCount ?? 0,
            reassignedToStageId: targetId
        };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /** Load a collection as a Mongoose doc for stage mutation, or throw 404. */
    async _loadCollectionForStageEdit(acctId, collectionId) {
        const collection = await LeadCollection.findOne({ _id: collectionId, acctId });
        if (!collection) {
            const err = new Error('Collection not found');
            err.statusCode = 404;
            throw err;
        }
        if (!Array.isArray(collection.stages)) collection.stages = [];
        return collection;
    }

    /** Throw 409 if `name` collides (case-insensitive) with another stage. */
    _assertStageNameUnique(stages, name, exceptId = null) {
        const lower = name.toLowerCase();
        const clash = stages.some(s => s.id !== exceptId && s.name.toLowerCase() === lower);
        if (clash) {
            const err = new Error(`A stage named "${name}" already exists in this collection`);
            err.statusCode = 409;
            throw err;
        }
    }

    _assertStageIdUnique(stages, id, exceptId = null) {
        const key = stageIdKey(id);
        if (stages.some(stage => stage.id !== exceptId && stageIdKey(stage.id) === key)) {
            const err = new Error(`Stage ID "${id}" already exists in this collection`);
            err.statusCode = 409;
            throw err;
        }
    }

    /**
     * Validate and normalise an array of user-supplied column definitions.
     * Input fields come from the UI in the form { label, field?, type }.
     */
    _validateAndNormaliseFields(fields) {
        if (!Array.isArray(fields)) return [];
        if (fields.length > 100) {
            const err = new Error('A collection cannot contain more than 100 fields');
            err.statusCode = 400;
            throw err;
        }

        const seen           = new Set();
        const result         = [];

        for (const f of fields) {
            if (!f.label || typeof f.label !== 'string') continue;

            const label    = f.label.trim().slice(0, 100);
            const fieldKey = normaliseFieldKey(label);
            const type     = ['text', 'number', 'date', 'boolean'].includes(f.type) ? f.type : 'text';

            if (!fieldKey) continue;
            if (SYSTEM_FIELD_KEYS.has(fieldKey)) continue;
            if (seen.has(fieldKey)) continue;

            seen.add(fieldKey);
            result.push({ label, field: fieldKey, type });
        }

        return result;
    }
}

export default new CollectionService();
