import express from 'express';
import { getAdmins, getAdminsFromDb, updateAccessLevel, updateContact, updateProfile } from '../controllers/adminController.js';

const router = express.Router();

/**
 * GET /list — fetch admins from local DB
 */
router.get('/list', getAdminsFromDb);

/**
 * POST /contact — sync the current user's own email/phone onto their admin record
 */
router.post('/contact', updateContact);

/**
 * PATCH /access-level — change an admin's access level (superadmin only)
 */
router.patch('/access-level', updateAccessLevel);

/**
 * PATCH /profile — update an admin's profile fields (name/email/phone/image).
 * Superadmins may edit anyone; others only their own record.
 */
router.patch('/profile', updateProfile);

/**
 * GET / — sync admins against Botamation platform, then return the list
 */
router.get('/', getAdmins);

export default router;
