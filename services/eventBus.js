import { EventEmitter } from 'events';

/**
 * Application event bus.
 *
 * A lightweight in-process pub/sub used to decouple domain actions (lead created,
 * lead assigned, lead unassigned) from side-effects like outbound webhooks. The
 * webhook dispatcher subscribes here; emitters never block on delivery.
 *
 * Event names are namespaced strings, e.g. 'lead.created'. Payloads are plain
 * objects: { acctId, collectionId, event, data }. `collectionId` scopes webhook
 * delivery so only webhooks subscribed to that collection fire.
 */
export const EVENTS = {
    LEAD_CREATED: 'lead.created',
    LEAD_ASSIGNED: 'lead.assigned',
    LEAD_UNASSIGNED: 'lead.unassigned',
    LEAD_STAGE_CHANGED: 'lead.stage_changed',
};

const bus = new EventEmitter();
// Webhook fan-out plus any future listeners — keep the ceiling generous
bus.setMaxListeners(50);

/** Emit a domain event. Never throws — listener errors are isolated. */
export const emitEvent = (event, payload) => {
    try {
        bus.emit(event, { event, ...payload });
    } catch (err) {
        console.error(`[eventBus] emit ${event} failed:`, err.message);
    }
};

export default bus;
