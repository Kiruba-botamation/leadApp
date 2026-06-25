/**
 * Note Service
 *
 * CRUD operations for lead_notes.
 * Notes are returned latest-first with admin profile info joined.
 */
import LeadNote     from '../models/leadNoteModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import logger from '../utils/logger.js';

class NoteService {
    /**
     * List all notes for a lead, latest-first, with admin info attached.
     *
     * @param {string} acctId
     * @param {string} leadId
     * @returns {Promise<object[]>}
     */
    async getNotes(acctId, leadId) {
        const notes = await LeadNote.find({ acctId, leadId })
            .sort({ createdAt: -1 })
            .lean();

        if (!notes.length) return [];

        // Batch-fetch live admin profiles by userId (scoped to the account)
        const userIds = [...new Set(notes.map(n => n.userId))];
        const admins  = await AccountAdmin.find({ acctId, userId: { $in: userIds } }, {
            userId: 1, firstName: 1, lastName: 1, profileImage: 1
        }).lean();

        const adminMap = Object.fromEntries(admins.map(a => [a.userId, a]));

        return notes.map(note => {
            const admin = adminMap[note.userId];
            // Prefer the live admin name; fall back to the snapshot, then 'Unknown'
            const liveName = admin ? [admin.firstName, admin.lastName].filter(Boolean).join(' ') : '';
            return {
                ...note,
                adminName: liveName || note.userName || 'Unknown',
                adminProfileImage: admin?.profileImage || null
            };
        });
    }

    /**
     * Count notes for a lead (used for the badge in the grid).
     *
     * @param {string} acctId
     * @param {string} leadId
     * @returns {Promise<number>}
     */
    async getNoteCount(acctId, leadId) {
        return LeadNote.countDocuments({ acctId, leadId });
    }

    /**
     * Get note counts for multiple leads in one query (batch for grid rendering).
     *
     * @param {string}   acctId
     * @param {string[]} leadIds
     * @returns {Promise<Record<string, number>>}  leadId → count
     */
    async getBatchNoteCounts(acctId, leadIds) {
        if (!leadIds?.length) return {};
        const results = await LeadNote.aggregate([
            { $match: { acctId, leadId: { $in: leadIds } } },
            { $group: { _id: '$leadId', count: { $sum: 1 } } }
        ]);
        return Object.fromEntries(results.map(r => [r._id, r.count]));
    }

    /**
     * Create a new note. Snapshots the author's display name so it survives
     * the admin later being removed from the account.
     *
     * @param {string} acctId
     * @param {string} userId
     * @param {string} leadId
     * @param {string} description
     * @param {string} [fallbackName]  used when no admin record is found (e.g. email)
     * @returns {Promise<object>}
     */
    async createNote(acctId, userId, leadId, description, fallbackName = null) {
        const admin = await AccountAdmin.findOne({ acctId, userId }, { firstName: 1, lastName: 1 }).lean();
        const userName = (admin ? [admin.firstName, admin.lastName].filter(Boolean).join(' ') : '') || fallbackName || null;
        const note = await LeadNote.create({ acctId, userId, userName, leadId, description });
        logger.info(`[NoteService] Note created | noteId=${note._id} | leadId=${leadId} | userId=${userId}`);
        return note;
    }

    /**
     * Update a note — only the creator may edit.
     *
     * @param {string} noteId
     * @param {string} userId   — must match the note's userId
     * @param {string} description
     * @returns {Promise<object|null>}
     */
    async updateNote(noteId, userId, description) {
        const updated = await LeadNote.findOneAndUpdate(
            { _id: noteId, userId },
            { description },
            { new: true }
        ).lean();

        if (!updated) return null; // Not found or forbidden
        logger.info(`[NoteService] Note updated | noteId=${noteId}`);
        return updated;
    }

    /**
     * Delete a note — only the creator may delete.
     *
     * @param {string} noteId
     * @param {string} userId   — must match the note's userId
     * @returns {Promise<boolean>} true if deleted, false if not found/forbidden
     */
    async deleteNote(noteId, userId) {
        const result = await LeadNote.findOneAndDelete({ _id: noteId, userId });
        if (!result) return false;
        logger.info(`[NoteService] Note deleted | noteId=${noteId}`);
        return true;
    }
}

export default new NoteService();
