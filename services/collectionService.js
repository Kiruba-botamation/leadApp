import LeadCollection from '../models/leadCollectionModel.js';
import Lead from '../models/leadModel.js';
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

/**
 * The `stage` system field. Kept OUT of SYSTEM_FIELDS (so the legacy field-position
 * logic for name/phone/email/responsible is untouched) but still an allowed lead field
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

/** Coerce a colour to a valid 6-digit hex, falling back to the default. */
function normaliseColor(color) {
    return typeof color === 'string' && HEX_COLOR_RE.test(color.trim())
        ? color.trim().toLowerCase()
        : DEFAULT_STAGE_COLOR;
}

/** Stages sorted by display order (tiebreak: lowest id). */
function sortStages(stages = []) {
    return [...stages].sort((a, b) => (a.order - b.order) || (a.id - b.id));
}

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
     * System fields are stored in the DB array (with system:true) so their position is persisted.
     * For legacy collections that pre-date this, system fields are prepended on the fly.
     */
    async getCollectionFields(acctId, collectionId) {
        const collection = await LeadCollection.findOne({ _id: collectionId, acctId }).lean();
        if (!collection) {
            const err = new Error('Collection not found');
            err.statusCode = 404;
            throw err;
        }

        const storedFields   = collection.fields || [];
        const systemFieldKeys = new Set(SYSTEM_FIELDS.map(f => f.field));

        // If system fields are already stored (new behaviour) use as-is.
        // Otherwise prepend them for backward compat with legacy documents.
        const hasStoredSystem = storedFields.some(f => systemFieldKeys.has(f.field));
        const fields = hasStoredSystem
            ? storedFields
            : [...SYSTEM_FIELDS, ...storedFields];

        return {
            _id:            collection._id,
            collectionName: collection.collectionName,
            default:        collection.default,
            fields,
            stages:         sortStages(collection.stages),
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

        // Re-read to apply same logic as getCollectionFields
        const storedFields    = collection.fields || [];
        const systemFieldKeys = new Set(SYSTEM_FIELDS.map(f => f.field));
        const hasStoredSystem = storedFields.some(f => systemFieldKeys.has(f.field));
        const allFields = hasStoredSystem ? storedFields : [...SYSTEM_FIELDS, ...storedFields];

        return {
            _id:            collection._id,
            collectionName: collection.collectionName,
            default:        collection.default,
            fields:         allFields,
            stages:         sortStages(collection.stages)
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

        const storedFields    = collection.fields || [];
        const systemFieldKeys = new Set(SYSTEM_FIELDS.map(f => f.field));
        const hasStoredSystem = storedFields.some(f => systemFieldKeys.has(f.field));
        const allFields = hasStoredSystem ? storedFields : [...SYSTEM_FIELDS, ...storedFields];

        return {
            _id:            collection._id,
            collectionName: collection.collectionName,
            default:        collection.default,
            fields:         allFields,
            stages:         sortStages(collection.stages)
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

        const leadsResult = await Lead.deleteMany({ acctId, collectionId });
        await LeadCollection.deleteOne({ _id: collectionId, acctId });

        return {
            deletedLeads:      leadsResult.deletedCount,
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
    async addStage(acctId, collectionId, { name, color } = {}) {
        const collection = await this._loadCollectionForStageEdit(acctId, collectionId);

        const trimmed = (name || '').trim();
        if (!trimmed) {
            const err = new Error('Stage name is required');
            err.statusCode = 400;
            throw err;
        }
        this._assertStageNameUnique(collection.stages, trimmed);

        const id    = collection.nextStageId || ((Math.max(0, ...collection.stages.map(s => s.id)) ) + 1);
        const order = collection.stages.length
            ? Math.max(...collection.stages.map(s => s.order)) + 1
            : 0;

        collection.stages.push({ id, name: trimmed, color: normaliseColor(color), order });
        collection.nextStageId = id + 1;
        await collection.save();

        return sortStages(collection.stages);
    }

    /** Update a stage's name / colour / order. Returns the updated, sorted stage list. */
    async updateStage(acctId, collectionId, stageId, { name, color, order } = {}) {
        const collection = await this._loadCollectionForStageEdit(acctId, collectionId);

        const stage = collection.stages.find(s => s.id === Number(stageId));
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

        await collection.save();
        return sortStages(collection.stages);
    }

    /** Reorder stages to match the given array of stage ids. Returns the sorted list. */
    async reorderStages(acctId, collectionId, orderedIds = []) {
        const collection = await this._loadCollectionForStageEdit(acctId, collectionId);

        const position = new Map(orderedIds.map((id, idx) => [Number(id), idx]));
        collection.stages.forEach(s => {
            if (position.has(s.id)) s.order = position.get(s.id);
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

        const id = Number(stageId);
        if (!collection.stages.some(s => s.id === id)) {
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

    /**
     * Validate and normalise an array of user-supplied column definitions.
     * Input fields come from the UI in the form { label, field?, type }.
     */
    _validateAndNormaliseFields(fields) {
        if (!Array.isArray(fields)) return [];

        const systemFieldMap = new Map(SYSTEM_FIELDS.map(f => [f.field, f]));
        const seen           = new Set();
        const result         = [];

        for (const f of fields) {
            // System fields — pass through as-is preserving position
            if (f.system && systemFieldMap.has(f.field)) {
                if (!seen.has(f.field)) {
                    seen.add(f.field);
                    result.push({ ...systemFieldMap.get(f.field) });
                }
                continue;
            }

            if (!f.label || typeof f.label !== 'string') continue;

            const label    = f.label.trim();
            const fieldKey = normaliseFieldKey(label);
            const type     = ['text', 'number', 'date', 'boolean'].includes(f.type) ? f.type : 'text';

            if (!fieldKey) continue;
            if (systemFieldMap.has(fieldKey)) continue; // ignore collision with system keys
            if (seen.has(fieldKey)) continue;

            seen.add(fieldKey);
            result.push({ label, field: fieldKey, type });
        }

        return result;
    }
}

export default new CollectionService();
