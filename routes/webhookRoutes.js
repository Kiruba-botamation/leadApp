import express from 'express';
import {
    listWebhooks,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    listDeliveries,
    listVariables
} from '../controllers/webhookController.js';
import { requireSuperadmin } from '../middleware/verifiedTenantMiddleware.js';

const router = express.Router();

router.use(requireSuperadmin);

/** GET /deliveries — recent delivery log (declare before /:id routes) */
router.get('/deliveries', listDeliveries);

/** GET /variables — payload-template variable catalog (declare before /:id routes) */
router.get('/variables', listVariables);

/** GET / — list configs + available events */
router.get('/', listWebhooks);

/** POST / — create a webhook config */
router.post('/', createWebhook);

/** PUT /:id — update a webhook config */
router.put('/:id', updateWebhook);

/** DELETE /:id — delete a webhook config */
router.delete('/:id', deleteWebhook);

export default router;
