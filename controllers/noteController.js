/**
 * Note Controller
 *
 * Handles HTTP requests for lead notes.
 * Auth is enforced by ssoAuthMiddleware (mounted in server.js).
 * The note author is the lead-app userId from the authenticated session (req.user.userId).
 */
import noteService     from '../services/noteService.js';
import reminderService from '../services/reminderService.js';

class NoteController {
    /**
     * GET /api/ui/leads/:leadId/notes
     * List all notes for a lead, latest-first with admin info.
     */
    async getNotes(req, res) {
        try {
            const { leadId }   = req.params;
            const acctId = req.tenant.acctId;

            if (!acctId) return res.status(400).json({ success: false, message: 'Account context required' });

            const result = await noteService.getNotes(acctId, leadId, {
                cursor: req.query.cursor,
                limit: req.query.limit,
            });
            return res.status(200).json({
                success: true,
                data: result.items,
                pageInfo: { nextCursor: result.nextCursor, hasNextPage: result.hasMore },
                total: null,
            });
        } catch (err) {
            console.error('[NoteController] getNotes:', err);
            return res.status(err.status || 500).json({ success: false, message: err.message });
        }
    }

    /**
     * POST /api/ui/leads/:leadId/notes
     * Create a new note.
     * Body: { description }
     */
    async createNote(req, res) {
        try {
            const { leadId }    = req.params;
            const acctId = req.tenant.acctId;
            const userId        = req.user?.userId;
            const { description } = req.body;

            if (!acctId)      return res.status(400).json({ success: false, message: 'Account context required' });
            if (!userId)      return res.status(400).json({ success: false, message: 'User identity required' });
            if (typeof description !== 'string' || !description.trim()) {
                return res.status(400).json({ success: false, message: 'description is required' });
            }

            const note = await noteService.createNote(acctId, userId, leadId, description.trim(), req.user?.email || null);
            return res.status(201).json({ success: true, message: 'Note created', data: note });
        } catch (err) {
            console.error('[NoteController] createNote:', err);
            return res.status(err.status || 500).json({ success: false, message: err.message });
        }
    }

    /**
     * PUT /api/ui/leads/:leadId/notes/:noteId
     * Update a note (creator only).
     * Body: { description }
     */
    async updateNote(req, res) {
        try {
            const { leadId, noteId } = req.params;
            const userId        = req.user?.userId;
            const acctId = req.tenant.acctId;
            const isSuperadmin  = req.user?.accessLevel === 'superadmin';
            const { description } = req.body;

            if (!acctId) return res.status(400).json({ success: false, message: 'Account context required' });
            if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });
            if (typeof description !== 'string' || !description.trim()) {
                return res.status(400).json({ success: false, message: 'description is required' });
            }

            const updated = await noteService.updateNote(acctId, leadId, noteId, userId, description.trim(), { isSuperadmin });
            if (!updated) {
                return res.status(404).json({ success: false, message: 'Note not found or you do not have permission to edit it' });
            }

            return res.status(200).json({ success: true, message: 'Note updated', data: updated });
        } catch (err) {
            console.error('[NoteController] updateNote:', err);
            return res.status(err.status || 500).json({ success: false, message: err.message });
        }
    }

    /**
     * DELETE /api/ui/leads/:leadId/notes/:noteId
     * Delete a note (creator only).
     */
    async deleteNote(req, res) {
        try {
            const { leadId, noteId } = req.params;
            const userId     = req.user?.userId;
            const acctId = req.tenant.acctId;
            const isSuperadmin = req.user?.accessLevel === 'superadmin';

            if (!acctId) return res.status(400).json({ success: false, message: 'Account context required' });
            if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });

            const deleted = await noteService.deleteNote(acctId, leadId, noteId, userId, { isSuperadmin });
            if (!deleted) {
                return res.status(404).json({ success: false, message: 'Note not found or you do not have permission to delete it' });
            }

            return res.status(200).json({ success: true, message: 'Note deleted' });
        } catch (err) {
            console.error('[NoteController] deleteNote:', err);
            return res.status(err.status || 500).json({ success: false, message: err.message });
        }
    }

    /**
     * POST /api/ui/leads/notes/batch-counts
     * Get note counts for multiple leads (used to populate grid badges).
     * Body: { leadIds: string[] }
     */
    async getBatchCounts(req, res) {
        try {
            const acctId = req.tenant.acctId;
            const { leadIds } = req.body;

            if (!acctId)            return res.status(400).json({ success: false, message: 'Account context required' });
            if (!Array.isArray(leadIds) || !leadIds.length) {
                return res.status(400).json({ success: false, message: 'leadIds array is required' });
            }

            const counts = await noteService.getBatchNoteCounts(acctId, leadIds);
            return res.status(200).json({ success: true, data: counts });
        } catch (err) {
            console.error('[NoteController] getBatchCounts:', err);
            return res.status(err.status || 500).json({ success: false, message: err.message });
        }
    }

    /**
     * POST /api/ui/activity/batch-counts
     * Combined notes + reminders counts in a single round-trip.
     * Replaces the separate notes/batch-counts + reminders/batch-counts calls.
     * Body: { leadIds: string[] }
     */
    async getCombinedBatchCounts(req, res) {
        try {
            const acctId = req.tenant.acctId;
            const { leadIds } = req.body;

            if (!acctId) return res.status(400).json({ success: false, message: 'Account context required' });
            if (!Array.isArray(leadIds) || !leadIds.length) {
                return res.status(400).json({ success: false, message: 'leadIds array is required' });
            }

            const [notes, reminders] = await Promise.all([
                noteService.getBatchNoteCounts(acctId, leadIds),
                reminderService.getBatchReminderCounts(acctId, leadIds),
            ]);
            return res.status(200).json({ success: true, data: { notes, reminders } });
        } catch (err) {
            console.error('[NoteController] getCombinedBatchCounts:', err);
            return res.status(err.status || 500).json({ success: false, message: err.message });
        }
    }
}

export default new NoteController();
