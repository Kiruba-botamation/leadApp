import express from 'express';
import PushSubscription from '../models/pushSubscriptionModel.js';
import reminderController from '../controllers/reminderController.js';
import { registerSSEClient, removeSSEClient } from '../services/channels/inApp.js';
import verifiedTenantMiddleware from '../middleware/verifiedTenantMiddleware.js';

const router = express.Router();

// ── Bell inbox ────────────────────────────────────────────────────────────────

/** Get fired-but-unread reminders for the notification bell */
router.get('/fired', verifiedTenantMiddleware, reminderController.getFiredReminders.bind(reminderController));

/** Calendar view — all reminders for the current user within a date range */
router.get('/calendar', verifiedTenantMiddleware, reminderController.getCalendarReminders.bind(reminderController));

/** Mark reminders as read */
router.post('/mark-read', verifiedTenantMiddleware, reminderController.markRead.bind(reminderController));

/** Delete a single fired reminder from the bell inbox */
router.delete('/fired/:reminderId', verifiedTenantMiddleware, reminderController.dismissFired.bind(reminderController));

// ── Push subscription management ─────────────────────────────────────────────

/**
 * POST /api/ui/push/subscribe
 * Save a browser push subscription (upsert by endpoint).
 * Body: { endpoint, keys: { p256dh, auth } }
 */
router.post('/subscribe', async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });

        const { endpoint, keys } = req.body;
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return res.status(400).json({ success: false, message: 'endpoint and keys (p256dh, auth) are required' });
        }

        await PushSubscription.findOneAndUpdate(
            { endpoint },
            { userId, endpoint, keys },
            { upsert: true, new: true }
        );

        return res.status(200).json({ success: true, message: 'Push subscription saved' });
    } catch (err) {
        console.error('[PushRoutes] subscribe:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * DELETE /api/ui/push/unsubscribe
 * Remove a push subscription (on logout or permission revoke).
 * Body: { endpoint }
 */
router.delete('/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        if (!endpoint) return res.status(400).json({ success: false, message: 'endpoint is required' });
        await PushSubscription.findOneAndDelete({ endpoint });
        return res.status(200).json({ success: true, message: 'Push subscription removed' });
    } catch (err) {
        console.error('[PushRoutes] unsubscribe:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/ui/push/vapid-public-key
 * Return the VAPID public key for browser subscription setup.
 */
router.get('/vapid-public-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(503).json({ success: false, message: 'Browser push not configured' });
    return res.status(200).json({ success: true, key });
});

// ── SSE stream ────────────────────────────────────────────────────────────────

/**
 * GET /api/ui/push/stream
 * Long-lived SSE connection for real-time in-app reminder delivery.
 * The admin's browser opens this once and keeps it open.
 */
router.get('/stream', (req, res) => {
    // The SSE stream is keyed by the authenticated user's lead-app userId — the same
    // id the reminder processor publishes to on reminder:notify:{userId}.
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    // SSE headers
    res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no' // Disable Nginx buffering for SSE
    });

    // Send initial heartbeat so the browser knows the connection is alive
    res.write('data: {"type":"connected"}\n\n');

    // Register this connection
    registerSSEClient(userId, res);

    // Heartbeat every 30 seconds to prevent proxy timeouts
    const heartbeat = setInterval(() => {
        try { res.write('data: {"type":"ping"}\n\n'); } catch { /* connection closed */ }
    }, 30000);

    // Clean up on disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        removeSSEClient(userId, res);
    });
});

export default router;
