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

        // Batch-fetch admin profiles for all unique adminIds
        const adminIds  = [...new Set(notes.map(n => n.adminId))];
        const admins    = await AccountAdmin.find({ _id: { $in: adminIds } }, {
            firstName: 1, lastName: 1, profileImage: 1
        }).lean();

        const adminMap  = Object.fromEntries(admins.map(a => [a._id, a]));

        return notes.map(note => {
            const admin = adminMap[note.adminId] || {};
            return {
                ...note,
                adminName: [admin.firstName, admin.lastName].filter(Boolean).join(' ') || 'Unknown',
                adminProfileImage: admin.profileImage || null
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
     * Create a new note.
     *
     * @param {string} acctId
     * @param {string} adminId
     * @param {string} leadId
     * @param {string} description
     * @returns {Promise<object>}
     */
    async createNote(acctId, adminId, leadId, description) {
        const note = await LeadNote.create({ acctId, adminId, leadId, description });
        logger.info(`[NoteService] Note created | noteId=${note._id} | leadId=${leadId} | adminId=${adminId}`);
        return note;
    }

    /**
     * Update a note — only the creator may edit.
     *
     * @param {string} noteId
     * @param {string} adminId   — must match the note's adminId
     * @param {string} description
     * @returns {Promise<object|null>}
     */
    async updateNote(noteId, adminId, description) {
        const updated = await LeadNote.findOneAndUpdate(
            { _id: noteId, adminId },
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
     * @param {string} adminId   — must match the note's adminId
     * @returns {Promise<boolean>} true if deleted, false if not found/forbidden
     */
    async deleteNote(noteId, adminId) {
        const result = await LeadNote.findOneAndDelete({ _id: noteId, adminId });
        if (!result) return false;
        logger.info(`[NoteService] Note deleted | noteId=${noteId}`);
        return true;
    }
}

export default new NoteService();
