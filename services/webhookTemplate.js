/**
 * Webhook Payload Templating
 *
 * Lets an admin shape the exact JSON body a webhook delivers using `{{path}}`
 * placeholders that resolve against the event context at delivery time.
 *
 * The context for every delivery is the default envelope:
 *   { event, acctId, timestamp, data: { ...event-specific... } }
 *
 * so a template like
 *   { "name": "{{data.lead.name}}", "stage": "{{data.stage.id}}", "src": "crm" }
 * renders to a trimmed, receiver-specific payload.
 *
 * Rendering is type-safe: a value that is *exactly* one token (`"{{path}}"`)
 * is replaced with the resolved value preserving its JSON type (number, object,
 * array, null); a token embedded in surrounding text is string-interpolated.
 */
import LeadCollection from '../models/leadCollectionModel.js';
import { SYSTEM_FIELDS, STAGE_FIELD } from './collectionService.js';
import logger from '../utils/logger.js';

const TOKEN_RE = /\{\{\s*([\w.$]+)\s*\}\}/g;
const EXACT_TOKEN_RE = /^\{\{\s*([\w.$]+)\s*\}\}$/;

/** Resolve a dotted path (e.g. `data.lead.name`) against a context object. */
export const resolvePath = (obj, path) => {
    if (!path) return undefined;
    return path.split('.').reduce((acc, key) => {
        if (acc === null || acc === undefined) return undefined;
        return acc[key];
    }, obj);
};

/** Build the variable context for an event payload. */
export const buildContext = ({ event, acctId, data, timestamp }) => ({
    event,
    acctId,
    timestamp: timestamp || new Date().toISOString(),
    data: data || {}
});

/** Stringify a resolved value for embedding inside a larger string. */
const stringifyForInterpolation = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

/**
 * Recursively render a parsed-template node against the context.
 * Strings: exact token → typed value; embedded tokens → interpolated string.
 */
const renderNode = (node, context) => {
    if (typeof node === 'string') {
        const exact = node.match(EXACT_TOKEN_RE);
        if (exact) {
            const value = resolvePath(context, exact[1]);
            return value === undefined ? null : value;
        }
        return node.replace(TOKEN_RE, (_, path) => stringifyForInterpolation(resolvePath(context, path)));
    }
    if (Array.isArray(node)) return node.map(item => renderNode(item, context));
    if (node && typeof node === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(node)) out[key] = renderNode(val, context);
        return out;
    }
    return node;
};

/**
 * Validate that a template string is parseable JSON.
 * @returns {{ valid: boolean, error?: string }}
 */
export const validateTemplate = (templateString) => {
    if (templateString === null || templateString === undefined || String(templateString).trim() === '') {
        return { valid: true };
    }
    try {
        JSON.parse(templateString);
        return { valid: true };
    } catch (err) {
        return { valid: false, error: `Invalid JSON template: ${err.message}` };
    }
};

/**
 * Render a custom payload template against an event context.
 * Falls back to the default envelope when no template is set or rendering fails.
 *
 * @returns {object} the body object to deliver
 */
export const renderPayload = (templateString, context) => {
    const fallback = {
        event: context.event,
        acctId: context.acctId,
        data: context.data,
        timestamp: context.timestamp
    };
    if (!templateString || String(templateString).trim() === '') return fallback;
    try {
        const parsed = JSON.parse(templateString);
        return renderNode(parsed, context);
    } catch (err) {
        logger.error(`[WebhookTemplate] Failed to render template, falling back to default: ${err.message}`);
        return fallback;
    }
};

// ── Variable catalog ─────────────────────────────────────────────────────────

/**
 * Build the catalog of `{{path}}` variables an admin can use in a template,
 * grouped by scope. Custom-field variables are limited to the given collection's
 * fields — a webhook is collection-scoped, so it only ever sees that collection's
 * leads.
 *
 * @returns {Promise<{ collectionId: string, collectionName: string|null, groups: Array<{ key: string, label: string, variables: Array<{ path: string, label: string }> }> }>}
 */
export const getAvailableVariables = async (acctId, collectionId) => {
    // Custom (user-defined) lead fields for this collection only
    const customFields = new Map(); // field → label
    let collectionName = null;
    try {
        if (collectionId) {
            const col = await LeadCollection.findOne({ _id: collectionId, acctId }, { fields: 1, collectionName: 1 }).lean();
            if (col) {
                collectionName = col.collectionName ?? null;
                for (const f of (col.fields || [])) {
                    if (f?.field && !customFields.has(f.field)) customFields.set(f.field, f.label || f.field);
                }
            }
        }
    } catch (err) {
        logger.error(`[WebhookTemplate] getAvailableVariables: failed to load collection ${collectionId}: ${err.message}`);
    }

    // System keys are framework-managed (injected on every collection). Reference
    // fields (responsible, stage) are exposed as BOTH id and resolved name.
    //
    // Naming convention used throughout the catalog:
    //   "<Qualifier> <Entity> <Attribute>" in Title Case — e.g. "Responsible ID",
    //   "Previous Stage Name". IDs are suffixed "ID", display names "Name".
    const SYSTEM_KEYS = new Set([...SYSTEM_FIELDS.map(f => f.field), STAGE_FIELD.field]); // name, phone, email, responsible, stage

    // ── Common: present on EVERY event ───────────────────────────────────────
    const commonVariables = [
        { path: 'event',        label: 'Event Name' },
        { path: 'acctId',       label: 'Account ID' },
        { path: 'timestamp',    label: 'Timestamp' },
        { path: 'data.leadId',  label: 'Lead ID' },
        { path: 'data.lead',    label: 'Full Lead Object' }
    ];

    // The lead's own fields — also present on every event that carries the lead.
    const systemLeadVariables = [
        ...SYSTEM_FIELDS
            .filter(f => f.field !== 'responsible')
            .map(f => ({ path: `data.lead.${f.field}`, label: f.label })), // Name, Phone, Email
        { path: 'data.lead.responsible',     label: 'Responsible ID' },
        { path: 'data.lead.responsibleName', label: 'Responsible Name' },
        { path: 'data.lead.stage',           label: 'Stage ID' }
    ];

    const customLeadVariables = Array.from(customFields)
        .filter(([field]) => !SYSTEM_KEYS.has(field))
        .map(([field, label]) => ({ path: `data.lead.${field}`, label }));

    const groups = [
        { key: 'common',      scope: 'common', label: 'Common Fields',         variables: commonVariables },
        { key: 'lead.system', scope: 'common', label: 'Lead Fields — System',  variables: systemLeadVariables }
    ];
    // Only surface the custom group when the collection actually has custom fields.
    if (customLeadVariables.length) {
        groups.push({ key: 'lead.custom', scope: 'common', label: 'Lead Fields — Custom', variables: customLeadVariables });
    }

    // ── Event-specific: only present on the matching event ───────────────────
    groups.push(
        {
            key: 'lead.created', scope: 'event', label: 'New Lead',
            variables: [
                { path: 'data.stage.id',   label: 'Stage ID' },
                { path: 'data.stage.name', label: 'Stage Name' }
            ]
        },
        {
            key: 'lead.assigned', scope: 'event', label: 'Lead Assigned',
            variables: [
                { path: 'data.responsible', label: 'Responsible ID' },
                { path: 'data.previous',    label: 'Previous Responsible ID' }
            ]
        },
        {
            key: 'lead.unassigned', scope: 'event', label: 'Lead Unassigned',
            variables: [
                { path: 'data.previous', label: 'Previous Responsible ID' }
            ]
        },
        {
            key: 'lead.stage_changed', scope: 'event', label: 'Stage Changed',
            variables: [
                { path: 'data.previous.id',   label: 'Previous Stage ID' },
                { path: 'data.previous.name', label: 'Previous Stage Name' },
                { path: 'data.current.id',    label: 'Current Stage ID' },
                { path: 'data.current.name',  label: 'Current Stage Name' }
            ]
        }
    );

    return { collectionId: collectionId ?? null, collectionName, groups };
};
