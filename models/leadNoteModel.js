import mongoose from 'mongoose';

/**
 * Lead Notes — `lead_notes` collection
 *
 * Stores internal notes written by admins for a specific lead.
 * Any number of notes can exist per lead.
 * Only the creator (userId) may edit or delete their own note.
 * Notes are listed latest-first via the createdAt index.
 */
const leadNoteSchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        /** Owning account */
        acctId: {
            type: String,
            required: true,
            index: true
        },
        /** The lead-app user who created this note (account_admins.userId) */
        userId: {
            type: String,
            required: true
        },
        /** Author display name snapshot — shown when the admin record is later removed */
        userName: {
            type: String,
            default: null
        },
        /** The lead this note belongs to (leads._id) */
        leadId: {
            type: String,
            required: true
        },
        /** Note content — required */
        description: {
            type: String,
            required: true,
            trim: true
        }
    },
    {
        timestamps: true,
        collection: 'lead_notes'
    }
);

// Primary query: list notes for a lead, latest first
leadNoteSchema.index({ acctId: 1, leadId: 1, createdAt: -1 });

// User-scoped queries (e.g. "show all notes by this user")
leadNoteSchema.index({ acctId: 1, userId: 1 });

const LeadNote = mongoose.model('LeadNote', leadNoteSchema);

export default LeadNote;
