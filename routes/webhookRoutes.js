import express from 'express';
import {
    listWebhooks,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    listDeliveries
} from '../controllers/webhookController.js';

const router = express.Router();

/** GET /deliveries — recent delivery log (declare before /:id routes) */
router.get('/deliveries', listDeliveries);

/** GET / — list configs + available events */
router.get('/', listWebhooks);

/** POST / — create a webhook config */
router.post('/', createWebhook);

/** PUT /:id — update a webhook config */
router.put('/:id', updateWebhook);

/** DELETE /:id — delete a webhook config */
router.delete('/:id', deleteWebhook);

export default router;
