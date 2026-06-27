import mongoose from 'mongoose';

/**
 * Column definition stored inside a collection.
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

/**
 * Lead stage (pipeline step) embedded in a collection.
 * id    — stable integer id, assigned from the collection's nextStageId counter and NEVER reused.
 *         Leads reference this id; reordering changes `order`, never `id`.
 * name  — display name (e.g. "New", "In Progress"). Unique (case-insensitive) within a collection.
 * color — hex colour chosen by the admin, used for the grid pill.
 * order — display position; the "first stage" is the one with the lowest order.
 */
const stageSchema = new mongoose.Schema(
    {
        id:    { type: Number, required: true },
        name:  { type: String, required: true },
        color: { type: String, default: '#4f46e5' },
        order: { type: Number, required: true }
    },
    { _id: false }
);

const leadCollectionSchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        acctId: {
            type: String,
            required: true
        },
        collectionName: {
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
         * they are injected at read-time by collectionService.
         */
        fields: {
            type: [columnDefSchema],
            default: []
        },
        /**
         * Pipeline stages for this collection. Every collection has at least one
         * (a default "New" stage is seeded on creation). Embedded so they are
         * loaded atomically with the collection and cascade-deleted with it.
         */
        stages: {
            type: [stageSchema],
            default: []
        },
        /** Monotonic counter for assigning new stage ids (never reused) */
        nextStageId: {
            type: Number,
            default: 1
        }
    },
    {
        timestamps: true
    }
);

leadCollectionSchema.index({ acctId: 1 });
leadCollectionSchema.index({ acctId: 1, collectionName: 1 }, { unique: true });

leadCollectionSchema.set('collection', 'lead_collections');

const LeadCollection = mongoose.model('LeadCollection', leadCollectionSchema);

export default LeadCollection;
