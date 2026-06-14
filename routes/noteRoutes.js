import express from 'express';
import noteController from '../controllers/noteController.js';

const router = express.Router({ mergeParams: true });

// ── Notes for a specific lead ─────────────────────────────────────────────────
// All routes are mounted at /api/ui/leads/:leadId/notes

/** List notes (latest first, with admin info) */
router.get('/', noteController.getNotes.bind(noteController));

/** Create a new note */
router.post('/', noteController.createNote.bind(noteController));

/** Update a note (creator only) */
router.put('/:noteId', noteController.updateNote.bind(noteController));

/** Delete a note (creator only) */
router.delete('/:noteId', noteController.deleteNote.bind(noteController));

export default router;
