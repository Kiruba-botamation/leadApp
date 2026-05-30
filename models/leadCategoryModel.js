import mongoose from 'mongoose';

/**
 * Column definition stored inside a category.
 * label  — display name shown in the grid header (e.g. "First Name")
 * field  — MongoDB key used in lead documents (e.g. "first_name")
 * type   — data type drives grid filter UI and query building
 */
const columnDefSchema = new mongoose.Schema(
    {
        label: { type: String, required: true },
        field: { type: String, required: true },
        type:  { type: String, enum: ['text', 'number', 'date', 'boolean'], default: 'text' }
    },
    { _id: false }
);

const leadCategorySchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        acctId: {
            type: String,
            required: true
        },
        categoryName: {
            type: String,
            required: true
        },
        default: {
            type: Boolean,
            default: false
        },
        /**
         * User-defined column definitions.
         * System fields (id, responsible) are NOT stored here —
         * they are injected at read-time by categoryService.
         */
        fields: {
            type: [columnDefSchema],
            default: []
        }
    },
    {
        timestamps: true
    }
);

leadCategorySchema.index({ acctId: 1 });
leadCategorySchema.index({ acctId: 1, categoryName: 1 }, { unique: true });

leadCategorySchema.set('collection', 'lead_categories');

const LeadCategory = mongoose.model('LeadCategory', leadCategorySchema);

export default LeadCategory;
