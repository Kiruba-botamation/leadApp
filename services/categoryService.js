import LeadCategory from '../models/leadCategoryModel.js';
import Lead from '../models/leadModel.js';
import { performGet, perfomDataExistanceCheck, performCount } from '../config/mongoConnector.js';

/**
 * System fields that every category implicitly has.
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
 * and a selectable analytics axis. Stage values reference a per-category stage id.
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

/** Normalise a category name: lowercase, spaces → underscore, strip non-alphanumeric-underscore */
export function normaliseCategoryName(name) {
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

class CategoryService {
    /**
     * Get all categories for an account (lightweight list, no field details).
     */
    async getCategories(acctId) {
        const result = await performGet(LeadCategory, { acctId }, [], { sort: { createdAt: 1 } });
        return (result.data || []).map(c => ({
            _id:          c._id,
            categoryName: c.categoryName,
            default:      c.default,
            stages:       sortStages(c.stages)
        }));
    }

    /**
     * Get column definitions for a single category.
     * System fields are stored in the DB array (with system:true) so their position is persisted.
     * For legacy categories that pre-date this, system fields are prepended on the fly.
     */
    async getCategoryFields(acctId, categoryId) {
        const category = await LeadCategory.findOne({ _id: categoryId, acctId }).lean();
        if (!category) {
            const err = new Error('Category not found');
            err.statusCode = 404;
            throw err;
        }

        const storedFields   = category.fields || [];
        const systemFieldKeys = new Set(SYSTEM_FIELDS.map(f => f.field));

        // If system fields are already stored (new behaviour) use as-is.
        // Otherwise prepend them for backward compat with legacy documents.
        const hasStoredSystem = storedFields.some(f => systemFieldKeys.has(f.field));
        const fields = hasStoredSystem
            ? storedFields
            : [...SYSTEM_FIELDS, ...storedFields];

        return {
            _id:          category._id,
            categoryName: category.categoryName,
            default:      category.default,
            fields,
            stages:       sortStages(category.stages),
        };
    }

    /**
     * Create a brand-new category with an optional initial field list.
     */
    async createCategory(acctId, categoryName, fields = []) {
        const normalisedName = normaliseCategoryName(categoryName);
        if (!normalisedName) {
            const err = new Error('Category name must contain at least one alphanumeric character');
            err.statusCode = 400;
            throw err;
        }

        const existing = await perfomDataExistanceCheck(LeadCategory, { acctId, categoryName: normalisedName });
        if (existing) {
            const err = new Error(`Category "${normalisedName}" already exists`);
            err.statusCode = 409;
            throw err;
        }

        const count     = await performCount(LeadCategory, { acctId });
        const isDefault = count === 0;

        const validatedFields = this._validateAndNormaliseFields(fields);

        const category = await LeadCategory.create({
            acctId,
            categoryName: normalisedName,
            default:      isDefault,
            fields:       validatedFields,
            // Every category starts with one mandatory default stage.
            stages:       [{ id: 1, name: 'New', color: DEFAULT_STAGE_COLOR, order: 0 }],
            nextStageId:  2
        });

        // Re-read to apply same logic as getCategoryFields
        const storedFields    = category.fields || [];
        const systemFieldKeys = new Set(SYSTEM_FIELDS.map(f => f.field));
        const hasStoredSystem = storedFields.some(f => systemFieldKeys.has(f.field));
        const allFields = hasStoredSystem ? storedFields : [...SYSTEM_FIELDS, ...storedFields];

        return {
            _id:          category._id,
            categoryName: category.categoryName,
            default:      category.default,
            fields:       allFields,
            stages:       sortStages(category.stages)
        };
    }

    /**
     * Update category name and/or column definitions.
     */
    async updateCategory(acctId, categoryId, { categoryName, fields }) {
        const category = await LeadCategory.findOne({ _id: categoryId, acctId });
        if (!category) {
            const err = new Error('Category not found');
            err.statusCode = 404;
            throw err;
        }

        if (categoryName !== undefined) {
            const normalisedName = normaliseCategoryName(categoryName);
            if (!normalisedName) {
                const err = new Error('Category name must contain at least one alphanumeric character');
                err.statusCode = 400;
                throw err;
            }

            // Check uniqueness if name actually changes
            if (normalisedName !== category.categoryName) {
                const duplicate = await perfomDataExistanceCheck(LeadCategory, {
                    acctId,
                    categoryName: normalisedName,
                    _id: { $ne: categoryId }
                });
                if (duplicate) {
                    const err = new Error(`Category "${normalisedName}" already exists`);
                    err.statusCode = 409;
                    throw err;
                }
            }
            category.categoryName = normalisedName;
        }

        if (fields !== undefined) {
            category.fields = this._validateAndNormaliseFields(fields);
        }

        await category.save();

        const storedFields    = category.fields || [];
        const systemFieldKeys = new Set(SYSTEM_FIELDS.map(f => f.field));
        const hasStoredSystem = storedFields.some(f => systemFieldKeys.has(f.field));
        const allFields = hasStoredSystem ? storedFields : [...SYSTEM_FIELDS, ...storedFields];

        return {
            _id:          category._id,
            categoryName: category.categoryName,
            default:      category.default,
            fields:       allFields,
            stages:       sortStages(category.stages)
        };
    }

    /**
     * Set a category as the account default.
     */
    async setDefaultCategory(acctId, categoryId) {
        const category = await perfomDataExistanceCheck(LeadCategory, { _id: categoryId, acctId });
        if (!category) {
            const err = new Error('Category not found');
            err.statusCode = 404;
            throw err;
        }

        await LeadCategory.updateMany({ acctId }, { $set: { default: false } });
        const updated = await LeadCategory.findByIdAndUpdate(
            categoryId,
            { $set: { default: true } },
            { new: true }
        );
        return updated;
    }

    /**
     * Delete a category and all its leads.
     */
    async deleteCategory(acctId, categoryId) {
        const category = await LeadCategory.findOne({ _id: categoryId, acctId }).lean();
        if (!category) {
            const err = new Error('Category not found');
            err.statusCode = 404;
            throw err;
        }

        const leadsResult = await Lead.deleteMany({ acctId, categoryId });
        await LeadCategory.deleteOne({ _id: categoryId, acctId });

        return {
            deletedLeads:    leadsResult.deletedCount,
            deletedCategory: true,
            categoryName:    category.categoryName
        };
    }

    /**
     * Return the set of allowed field keys for a category (system + user-defined).
     * Used by leadService to validate incoming payloads.
     */
    async getAllowedFields(acctId, categoryName) {
        const category = await LeadCategory.findOne({ acctId, categoryName }).lean();
        if (!category) return null; // caller handles 404

        const userFields   = (category.fields || []).map(f => f.field);
        const systemFields = SYSTEM_FIELDS.map(f => f.field);
        return new Set([...systemFields, STAGE_FIELD.field, ...userFields]);
    }

    /**
     * Retrieve a category document by name (for createLead lookup).
     */
    async findByName(acctId, categoryName) {
        return LeadCategory.findOne({ acctId, categoryName }).lean();
    }

    // ── Stage lifecycle ──────────────────────────────────────────────────────

    /**
     * The id of a category's "first" stage (lowest order, tiebreak lowest id).
     * Used as the default stage when a lead is created without one, and as the
     * reassignment target when a stage is deleted. Returns null if no stages.
     * Accepts a plain category doc (lean) or a Mongoose document.
     */
    getFirstStageId(categoryDoc) {
        const sorted = sortStages(categoryDoc?.stages);
        return sorted.length ? sorted[0].id : null;
    }

    /** Build an { [stageId]: name } map for a category (analytics / MCP / webhooks). */
    async resolveStageMap(acctId, categoryId) {
        const category = await LeadCategory.findOne({ _id: categoryId, acctId }, { stages: 1 }).lean();
        const map = {};
        for (const s of category?.stages || []) map[s.id] = s.name;
        return map;
    }

    /** Add a stage to a category. Returns the updated, sorted stage list. */
    async addStage(acctId, categoryId, { name, color } = {}) {
        const category = await this._loadCategoryForStageEdit(acctId, categoryId);

        const trimmed = (name || '').trim();
        if (!trimmed) {
            const err = new Error('Stage name is required');
            err.statusCode = 400;
            throw err;
        }
        this._assertStageNameUnique(category.stages, trimmed);

        const id    = category.nextStageId || ((Math.max(0, ...category.stages.map(s => s.id)) ) + 1);
        const order = category.stages.length
            ? Math.max(...category.stages.map(s => s.order)) + 1
            : 0;

        category.stages.push({ id, name: trimmed, color: normaliseColor(color), order });
        category.nextStageId = id + 1;
        await category.save();

        return sortStages(category.stages);
    }

    /** Update a stage's name / colour / order. Returns the updated, sorted stage list. */
    async updateStage(acctId, categoryId, stageId, { name, color, order } = {}) {
        const category = await this._loadCategoryForStageEdit(acctId, categoryId);

        const stage = category.stages.find(s => s.id === Number(stageId));
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
            this._assertStageNameUnique(category.stages, trimmed, stage.id);
            stage.name = trimmed;
        }
        if (color !== undefined) stage.color = normaliseColor(color);
        if (order !== undefined && !Number.isNaN(Number(order))) stage.order = Number(order);

        await category.save();
        return sortStages(category.stages);
    }

    /** Reorder stages to match the given array of stage ids. Returns the sorted list. */
    async reorderStages(acctId, categoryId, orderedIds = []) {
        const category = await this._loadCategoryForStageEdit(acctId, categoryId);

        const position = new Map(orderedIds.map((id, idx) => [Number(id), idx]));
        category.stages.forEach(s => {
            if (position.has(s.id)) s.order = position.get(s.id);
        });

        await category.save();
        return sortStages(category.stages);
    }

    /**
     * Delete a stage. Leads in that stage are reassigned to the (remaining) first
     * stage. At least one stage must always remain. No per-lead webhook is fired
     * for the bulk reassignment.
     *
     * Returns { stages, reassignedCount, reassignedToStageId }.
     */
    async deleteStage(acctId, categoryId, stageId) {
        const category = await this._loadCategoryForStageEdit(acctId, categoryId);

        const id = Number(stageId);
        if (!category.stages.some(s => s.id === id)) {
            const err = new Error('Stage not found');
            err.statusCode = 404;
            throw err;
        }
        if (category.stages.length <= 1) {
            const err = new Error('At least one stage is required per category');
            err.statusCode = 400;
            throw err;
        }

        // First stage among the ones that will remain.
        const remaining   = sortStages(category.stages.filter(s => s.id !== id));
        const targetId    = remaining[0].id;

        const reassign = await Lead.updateMany(
            { acctId, categoryId, stage: id },
            { $set: { stage: targetId } }
        );

        category.stages = remaining;
        await category.save();

        return {
            stages:              sortStages(category.stages),
            reassignedCount:     reassign.modifiedCount ?? 0,
            reassignedToStageId: targetId
        };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /** Load a category as a Mongoose doc for stage mutation, or throw 404. */
    async _loadCategoryForStageEdit(acctId, categoryId) {
        const category = await LeadCategory.findOne({ _id: categoryId, acctId });
        if (!category) {
            const err = new Error('Category not found');
            err.statusCode = 404;
            throw err;
        }
        if (!Array.isArray(category.stages)) category.stages = [];
        return category;
    }

    /** Throw 409 if `name` collides (case-insensitive) with another stage. */
    _assertStageNameUnique(stages, name, exceptId = null) {
        const lower = name.toLowerCase();
        const clash = stages.some(s => s.id !== exceptId && s.name.toLowerCase() === lower);
        if (clash) {
            const err = new Error(`A stage named "${name}" already exists in this category`);
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

export default new CategoryService();
