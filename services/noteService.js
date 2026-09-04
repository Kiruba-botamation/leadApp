/**
 * Note Service
 *
 * CRUD operations for lead_notes.
 * Notes are returned latest-first with admin profile info joined.
 */
import LeadNote     from '../models/leadNoteModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import Lead          from '../models/leadModel.js';
import logger from '../utils/logger.js';

export const NOTE_MAX_LENGTH = 10000;
export const ACTIVITY_BATCH_MAX = 200;
const NOTE_LIST_DEFAULT = 50;
const NOTE_LIST_MAX = 100;

const serviceError = (message, status = 400) => Object.assign(new Error(message), { status });

const encodeCursor = (note) => Buffer.from(JSON.stringify({
    createdAt: note.createdAt,
    id: note._id,
})).toString('base64url');

const decodeCursor = (cursor) => {
    if (!cursor) return null;
    if (typeof cursor !== 'string' || cursor.length > 1024) throw serviceError('Invalid notes cursor');
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        const createdAt = new Date(parsed.createdAt);
        if (!parsed.id || Number.isNaN(createdAt.getTime())) throw new Error('invalid');
        return { createdAt, id: String(parsed.id) };
    } catch {
        throw serviceError('Invalid notes cursor');
    }
};

const normalizeBatchIds = (leadIds) => {
    if (leadIds.length > ACTIVITY_BATCH_MAX) throw serviceError(`leadIds is limited to ${ACTIVITY_BATCH_MAX}`);
    if (leadIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) {
        throw serviceError('leadIds must contain non-empty strings of at most 128 characters');
    }
    return [...new Set(leadIds)];
};

const assertTenantLead = async (acctId, leadId) => {
    const exists = await Lead.exists({ _id: leadId, acctId });
    if (!exists) throw serviceError('Lead not found', 404);
};

class NoteService {
    /**
     * List all notes for a lead, latest-first, with admin info attached.
     *
     * @param {string} acctId
     * @param {string} leadId
     * @returns {Promise<object[]>}
     */
    async getNotes(acctId, leadId, { cursor = null, limit = NOTE_LIST_DEFAULT } = {}) {
        await assertTenantLead(acctId, leadId);
        const boundedLimit = Math.min(NOTE_LIST_MAX, Math.max(1, Number(limit) || NOTE_LIST_DEFAULT));
        const decoded = decodeCursor(cursor);
        const filter = { acctId, leadId };
        if (decoded) {
            filter.$or = [
                { createdAt: { $lt: decoded.createdAt } },
                { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
            ];
        }

        const notes = await LeadNote.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .limit(boundedLimit + 1)
            .lean();

        const hasMore = notes.length > boundedLimit;
        const page = hasMore ? notes.slice(0, boundedLimit) : notes;
        if (!page.length) return { items: [], nextCursor: null, hasMore: false, limit: boundedLimit };

        // Batch-fetch live admin profiles by userId (scoped to the account)
        const userIds = [...new Set(page.map(n => n.userId))];
        const admins  = await AccountAdmin.find({ acctId, userId: { $in: userIds } }, {
            userId: 1, firstName: 1, lastName: 1, profileImage: 1
        }).lean();

        const adminMap = Object.fromEntries(admins.map(a => [a.userId, a]));

        const items = page.map(note => {
            const admin = adminMap[note.userId];
            // Prefer the live admin name; fall back to the snapshot, then 'Unknown'
            const liveName = admin ? [admin.firstName, admin.lastName].filter(Boolean).join(' ') : '';
            return {
                ...note,
                adminName: liveName || note.userName || 'Unknown',
                adminProfileImage: admin?.profileImage || null
            };
        });
        return {
            items,
            nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
            hasMore,
            limit: boundedLimit,
        };
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
        const uniqueIds = normalizeBatchIds(leadIds);
        const results = await LeadNote.aggregate([
            { $match: { acctId, leadId: { $in: uniqueIds } } },
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
        await assertTenantLead(acctId, leadId);
        if (description.length > NOTE_MAX_LENGTH) throw serviceError(`description is limited to ${NOTE_MAX_LENGTH} characters`);
        const admin = await AccountAdmin.findOne({ acctId, userId }, { firstName: 1, lastName: 1 }).lean();
        const userName = (admin ? [admin.firstName, admin.lastName].filter(Boolean).join(' ') : '') || fallbackName || null;
        const note = await LeadNote.create({ acctId, userId, userName, leadId, description });
        logger.info(`[NoteService] Note created | noteId=${note._id} | leadId=${leadId} | userId=${userId}`);
        return note;
    }

    /**
     * Update a note. By default only the creator may edit; superadmins may edit
     * any note within their own account.
     *
     * @param {string} noteId
     * @param {string} userId   — the requesting user (matched unless superadmin)
     * @param {string} description
     * @param {{ isSuperadmin?: boolean, acctId?: string|null }} [opts]
     * @returns {Promise<object|null>}
     */
    async updateNote(acctId, leadId, noteId, userId, description, { isSuperadmin = false } = {}) {
        if (description.length > NOTE_MAX_LENGTH) throw serviceError(`description is limited to ${NOTE_MAX_LENGTH} characters`);
        const filter = { _id: noteId, acctId, leadId };
        if (isSuperadmin) {
            // Account and lead scope above still apply.
        } else {
            filter.userId = userId;             // others may edit only their own note
        }

        const updated = await LeadNote.findOneAndUpdate(filter, { description }, { new: true }).lean();

        if (!updated) return null; // Not found or forbidden
        logger.info(`[NoteService] Note updated | noteId=${noteId} | by=${userId}${isSuperadmin ? ' (superadmin)' : ''}`);
        return updated;
    }

    /**
     * Delete a note. By default only the creator may delete; superadmins may delete
     * any note within their own account.
     *
     * @param {string} noteId
     * @param {string} userId   — the requesting user (matched unless superadmin)
     * @param {{ isSuperadmin?: boolean, acctId?: string|null }} [opts]
     * @returns {Promise<boolean>} true if deleted, false if not found/forbidden
     */
    async deleteNote(acctId, leadId, noteId, userId, { isSuperadmin = false } = {}) {
        const filter = { _id: noteId, acctId, leadId };
        if (isSuperadmin) {
            // Account and lead scope above still apply.
        } else {
            filter.userId = userId;
        }

        const result = await LeadNote.findOneAndDelete(filter);
        if (!result) return false;
        logger.info(`[NoteService] Note deleted | noteId=${noteId} | by=${userId}${isSuperadmin ? ' (superadmin)' : ''}`);
        return true;
    }
}

export default new NoteService();
