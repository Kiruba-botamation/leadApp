/**
 * Note Controller
 *
 * Handles HTTP requests for lead notes.
 * Auth is enforced by ssoAuthMiddleware (mounted in server.js).
 * Admin identity is resolved from req.user.accountAdminId (account_admins._id,
 * enriched by ssoAuthMiddleware via email match against account_admins collection).
 */
import noteService from '../services/noteService.js';

class NoteController {
    /**
     * GET /api/ui/leads/:leadId/notes
     * List all notes for a lead, latest-first with admin info.
     */
    async getNotes(req, res) {
        try {
            const { leadId }   = req.params;
            const acctId       = req.query.acctId || req.headers['x-acctno'];

            if (!acctId) return res.status(400).json({ success: false, message: 'Account context required' });

            const notes = await noteService.getNotes(acctId, leadId);
            return res.status(200).json({ success: true, data: notes });
        } catch (err) {
            console.error('[NoteController] getNotes:', err);
            return res.status(500).json({ success: false, message: err.message });
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
            const acctId        = req.query.acctId || req.headers['x-acctno'];
            // Prefer adminId sent explicitly by the frontend (account-specific _id from localStorage).
            // Fall back to middleware-resolved accountAdminId (requires acctId to be accurate).
            const adminId       = req.body.adminId || req.user?.accountAdminId;
            const { description } = req.body;

            if (!acctId)      return res.status(400).json({ success: false, message: 'Account context required' });
            if (!adminId)     return res.status(400).json({ success: false, message: 'Admin identity required' });
            if (!description?.trim()) {
                return res.status(400).json({ success: false, message: 'description is required' });
            }

            const note = await noteService.createNote(acctId, adminId, leadId, description.trim());
            return res.status(201).json({ success: true, message: 'Note created', data: note });
        } catch (err) {
            console.error('[NoteController] createNote:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * PUT /api/ui/leads/:leadId/notes/:noteId
     * Update a note (creator only).
     * Body: { description }
     */
    async updateNote(req, res) {
        try {
            const { noteId }    = req.params;
            const adminId       = req.user?.accountAdminId;
            const { description } = req.body;

            if (!adminId) return res.status(400).json({ success: false, message: 'Admin identity required' });
            if (!description?.trim()) {
                return res.status(400).json({ success: false, message: 'description is required' });
            }

            const updated = await noteService.updateNote(noteId, adminId, description.trim());
            if (!updated) {
                return res.status(404).json({ success: false, message: 'Note not found or you do not have permission to edit it' });
            }

            return res.status(200).json({ success: true, message: 'Note updated', data: updated });
        } catch (err) {
            console.error('[NoteController] updateNote:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * DELETE /api/ui/leads/:leadId/notes/:noteId
     * Delete a note (creator only).
     */
    async deleteNote(req, res) {
        try {
            const { noteId } = req.params;
            const adminId    = req.user?.accountAdminId;

            if (!adminId) return res.status(400).json({ success: false, message: 'Admin identity required' });

            const deleted = await noteService.deleteNote(noteId, adminId);
            if (!deleted) {
                return res.status(404).json({ success: false, message: 'Note not found or you do not have permission to delete it' });
            }

            return res.status(200).json({ success: true, message: 'Note deleted' });
        } catch (err) {
            console.error('[NoteController] deleteNote:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * POST /api/ui/leads/notes/batch-counts
     * Get note counts for multiple leads (used to populate grid badges).
     * Body: { leadIds: string[] }
     */
    async getBatchCounts(req, res) {
        try {
            const acctId     = req.query.acctId || req.headers['x-acctno'];
            const { leadIds } = req.body;

            if (!acctId)            return res.status(400).json({ success: false, message: 'Account context required' });
            if (!Array.isArray(leadIds) || !leadIds.length) {
                return res.status(400).json({ success: false, message: 'leadIds array is required' });
            }

            const counts = await noteService.getBatchNoteCounts(acctId, leadIds);
            return res.status(200).json({ success: true, data: counts });
        } catch (err) {
            console.error('[NoteController] getBatchCounts:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }
}

export default new NoteController();
