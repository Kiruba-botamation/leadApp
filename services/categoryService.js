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
            default:      c.default
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
            fields:       validatedFields
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
            fields:       allFields
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
            fields:       allFields
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
        return new Set([...systemFields, ...userFields]);
    }

    /**
     * Retrieve a category document by name (for createLead lookup).
     */
    async findByName(acctId, categoryName) {
        return LeadCategory.findOne({ acctId, categoryName }).lean();
    }

    // ── Private helpers ──────────────────────────────────────────────────────

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
