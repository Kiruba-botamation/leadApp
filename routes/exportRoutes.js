import express from 'express';
import exportController from '../controllers/exportController.js';

const router = express.Router();
router.post('/', exportController.create);
router.get('/:id', exportController.status);
router.delete('/:id', exportController.cancel);
router.get('/:id/download', exportController.download);

export default router;
