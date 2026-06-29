/**
 * Webhook Controller
 *
 * CRUD for per-account outbound webhook configs + recent delivery log.
 * Auth enforced by ssoAuthMiddleware. Only superadmins may manage webhooks.
 */
import * as webhookService from '../services/webhookService.js';
import logger from '../utils/logger.js';

const requireSuperadmin = (req, res) => {
    if (req.user?.accessLevel !== 'superadmin') {
        res.status(403).json({ success: false, message: 'Only superadmins can manage webhooks' });
        return false;
    }
    return true;
};

const resolveAcctId = (req) => req.query.acctId || req.body.acctId || req.headers['x-acctno'];

/** GET /api/ui/webhooks — list configs + available events */
export const listWebhooks = async (req, res) => {
    try {
        const acctId = resolveAcctId(req);
        if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

        const configs = await webhookService.listConfigs(acctId);
        return res.status(200).json({
            success: true,
            events: webhookService.AVAILABLE_EVENTS,
            currentUserAccessLevel: req.user?.accessLevel ?? null,
            configs
        });
    } catch (err) {
        logger.error('[WebhookController] listWebhooks:', { error: err.message });
        return res.status(500).json({ success: false, message: err.message });
    }
};

/** POST /api/ui/webhooks — create a config (secret returned once) */
export const createWebhook = async (req, res) => {
    try {
        if (!requireSuperadmin(req, res)) return;
        const acctId = resolveAcctId(req);
        const { url, events, collectionId, headers, payloadTemplate } = req.body;

        if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });
        if (!collectionId) return res.status(400).json({ success: false, message: 'collectionId is required' });
        if (!url || !/^https?:\/\//i.test(url)) {
            return res.status(400).json({ success: false, message: 'A valid http(s) url is required' });
        }

        const config = await webhookService.createConfig(acctId, { url, events, collectionId, headers, payloadTemplate });
        return res.status(201).json({ success: true, config });
    } catch (err) {
        logger.error('[WebhookController] createWebhook:', { error: err.message });
        // Template / collection validation errors are client errors, not server faults
        const status = /invalid json template|collection (not found|is required)/i.test(err.message) ? 400 : 500;
        return res.status(status).json({ success: false, message: err.message });
    }
};

/** PUT /api/ui/webhooks/:id — update url/events/active */
export const updateWebhook = async (req, res) => {
    try {
        if (!requireSuperadmin(req, res)) return;
        const acctId = resolveAcctId(req);
        const { id } = req.params;
        if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

        const config = await webhookService.updateConfig(acctId, id, req.body);
        if (!config) return res.status(404).json({ success: false, message: 'Webhook not found' });
        return res.status(200).json({ success: true, config });
    } catch (err) {
        logger.error('[WebhookController] updateWebhook:', { error: err.message });
        const status = /invalid json template|collection (not found|is required)/i.test(err.message) ? 400 : 500;
        return res.status(status).json({ success: false, message: err.message });
    }
};

/** GET /api/ui/webhooks/variables?collectionId=… — variable catalog for the payload-template picker */
export const listVariables = async (req, res) => {
    try {
        const acctId = resolveAcctId(req);
        if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });
        const collectionId = req.query.collectionId;
        if (!collectionId) return res.status(400).json({ success: false, message: 'collectionId is required' });

        const catalog = await webhookService.listVariables(acctId, collectionId);
        return res.status(200).json({ success: true, ...catalog });
    } catch (err) {
        logger.error('[WebhookController] listVariables:', { error: err.message });
        return res.status(500).json({ success: false, message: err.message });
    }
};

/** DELETE /api/ui/webhooks/:id */
export const deleteWebhook = async (req, res) => {
    try {
        if (!requireSuperadmin(req, res)) return;
        const acctId = resolveAcctId(req);
        const { id } = req.params;
        if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

        const deleted = await webhookService.deleteConfig(acctId, id);
        if (!deleted) return res.status(404).json({ success: false, message: 'Webhook not found' });
        return res.status(200).json({ success: true, message: 'Webhook deleted' });
    } catch (err) {
        logger.error('[WebhookController] deleteWebhook:', { error: err.message });
        return res.status(500).json({ success: false, message: err.message });
    }
};

/** GET /api/ui/webhooks/deliveries — recent delivery log */
export const listDeliveries = async (req, res) => {
    try {
        const acctId = resolveAcctId(req);
        if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });

        const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
        const deliveries = await webhookService.listDeliveries(acctId, { limit });
        return res.status(200).json({ success: true, deliveries });
    } catch (err) {
        logger.error('[WebhookController] listDeliveries:', { error: err.message });
        return res.status(500).json({ success: false, message: err.message });
    }
};
