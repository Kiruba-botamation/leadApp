import express from 'express';
import { getRoles } from '../controllers/roleController.js';

const router = express.Router();

/**
 * GET / — list all access-level roles
 */
router.get('/', getRoles);

export default router;
