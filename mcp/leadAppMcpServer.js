/**
 * Lead-App MCP endpoint (Streamable HTTP, JSON-RPC 2.0)
 *
 * Exposes admin-management tools to MCP clients so an assistant can, e.g.,
 * "lower admin access for Dinesh": call get_admins to find Dinesh's
 * chatbotAdminId, get_roles to see available levels, then set_admin_access_level.
 *
 * Mounted behind ssoAuthMiddleware at /api/ui/mcp, so req.user is the
 * authenticated caller. acctId is supplied as a tool argument.
 *
 * Implemented directly over JSON-RPC (no SDK dependency). Responds with
 * application/json, which MCP's Streamable HTTP transport permits for
 * non-streaming results. Handles: initialize, tools/list, tools/call, and
 * notifications/*.
 */
import express from 'express';
import { getAdminsFromDb, setAdminAccessLevel } from '../services/adminService.js';
import AccountAdmin from '../models/accountAdminModel.js';
import Role from '../models/roleModel.js';
import Lead from '../models/leadModel.js';
import LeadCollection from '../models/leadCollectionModel.js';
import { normaliseCollectionName } from '../services/collectionService.js';
import { invalidateAdminCache } from '../middleware/ssoAuthMiddleware.js';
import { checkRateLimit } from '../utils/rateLimit.js';
import logger from '../utils/logger.js';

const router = express.Router();

const PROTOCOL_VERSION = '2024-11-05';

// ── Per-account MCP rate limiter (configurable via env) ─────────────────────────
const MCP_RATE_LIMIT_MAX       = parseInt(process.env.LEAD_MCP_RATE_LIMIT_MAX ?? '100', 10);
const MCP_RATE_LIMIT_WINDOW_S  = parseInt(process.env.LEAD_MCP_RATE_LIMIT_WINDOW_S ?? '60', 10);
const MCP_RATE_LIMIT_FAIL_OPEN = (process.env.LEAD_MCP_RATE_LIMIT_FAIL_OPEN ?? 'true') !== 'false';
const MCP_RATE_LIMIT_PREFIX    = 'ratelimit:mcp:acct:';

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
    {
        name: 'get_admins',
        description: 'List the admins of an account (name, chatbotAdminId, accessLevel). Use this to look up an admin\'s chatbotAdminId by name.',
        inputSchema: {
            type: 'object',
            properties: { acctId: { type: 'string', description: 'The account id' } },
            required: ['acctId']
        }
    },
    {
        name: 'get_roles',
        description: 'List the available access-level roles (e.g. superadmin, admin) with their privilege levels.',
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'set_admin_access_level',
        description: 'Change an admin\'s access level. Identify the admin by chatbotAdminId (from get_admins) and pass a role key from get_roles. Superadmin only.',
        inputSchema: {
            type: 'object',
            properties: {
                acctId: { type: 'string', description: 'The account id' },
                chatbotAdminId: { type: 'string', description: 'The external admin id of the target admin' },
                accessLevel: { type: 'string', description: 'Role key, e.g. "admin" or "superadmin"' }
            },
            required: ['acctId', 'chatbotAdminId', 'accessLevel']
        }
    },
    {
        name: 'get_stages',
        description: 'List the lead stages of a collection (id, name, colour). Use this to resolve a stage name like "hot" or "new" to its numeric stage id before calling get_lead_stats. Omit "collection" to use the account default collection.',
        inputSchema: {
            type: 'object',
            properties: {
                acctId: { type: 'string', description: 'The account id' },
                collection: { type: 'string', description: 'Optional collection name; defaults to the account default collection' }
            },
            required: ['acctId']
        }
    },
    {
        name: 'get_lead_stats',
        description: 'Count leads, optionally filtered by stage and/or responsible admin and/or a created-date range. Resolve names to ids first (get_stages for stages, get_admins for admins) OR pass stageName/adminName and they will be resolved. With no stage filter, a per-stage breakdown is also returned. Examples: "how many hot leads today" (stageName="hot", dateFrom=today); "how many leads handled by Dinesh" (adminName="Dinesh").',
        inputSchema: {
            type: 'object',
            properties: {
                acctId:      { type: 'string', description: 'The account id' },
                collection:  { type: 'string', description: 'Optional collection name; defaults to the account default collection' },
                stage:       { type: 'number', description: 'Optional numeric stage id' },
                stageName:   { type: 'string', description: 'Optional stage name (resolved to an id within the collection)' },
                responsible: { type: 'string', description: 'Optional responsible admin userId' },
                adminName:   { type: 'string', description: 'Optional admin name (resolved to a userId)' },
                dateFrom:    { type: 'string', description: 'Optional ISO date — count leads created on/after this' },
                dateTo:      { type: 'string', description: 'Optional ISO date — count leads created on/before this (inclusive of the whole day)' }
            },
            required: ['acctId']
        }
    }
];

// ── Tool handlers ──────────────────────────────────────────────────────────────

/** Resolve the caller's access level for an account (single source of truth for the superadmin gate). */
const callerAccessLevel = async (userId, acctId) => {
    const rec = await AccountAdmin.findOne({ acctId, userId }, { accessLevel: 1 }).lean();
    return rec?.accessLevel ?? null;
};

/** Resolve a collection by name (normalised) or fall back to the account default. Throws if none. */
const resolveCollection = async (acctId, collectionName) => {
    let collection;
    if (collectionName) {
        collection = await LeadCollection.findOne({ acctId, collectionName: normaliseCollectionName(collectionName) }).lean();
        if (!collection) throw new Error(`Collection "${collectionName}" not found`);
    } else {
        collection = await LeadCollection.findOne({ acctId, default: true }).lean()
            || await LeadCollection.findOne({ acctId }).lean();
        if (!collection) throw new Error('No collections exist for this account');
    }
    return collection;
};

const toolHandlers = {
    async get_admins(args) {
        if (!args?.acctId) throw new Error('acctId is required');
        const { admins } = await getAdminsFromDb(args.acctId, { limit: 200 });
        return admins.map(a => ({
            name: [a.firstName, a.lastName].filter(Boolean).join(' ') || 'Unknown',
            chatbotAdminId: a.chatbotAdminId,
            accessLevel: a.accessLevel
        }));
    },

    async get_roles() {
        const roles = await Role.find({}, { _id: 0, key: 1, label: 1, level: 1 }).sort({ level: -1 }).lean();
        return roles;
    },

    async set_admin_access_level(args, user) {
        const { acctId, chatbotAdminId, accessLevel } = args || {};
        if (!acctId || !chatbotAdminId || !accessLevel) {
            throw new Error('acctId, chatbotAdminId and accessLevel are required');
        }
        if (await callerAccessLevel(user.userId, acctId) !== 'superadmin') {
            throw new Error('Only superadmins can change access levels');
        }
        const role = await Role.findOne({ key: accessLevel }).lean();
        if (!role) throw new Error(`Unknown access level "${accessLevel}"`);

        const updated = await setAdminAccessLevel(acctId, chatbotAdminId, accessLevel);
        if (!updated) throw new Error('Admin not found for this account');

        invalidateAdminCache(updated.userId, acctId);
        return { ok: true, chatbotAdminId, accessLevel, name: [updated.firstName, updated.lastName].filter(Boolean).join(' ') };
    },

    async get_stages(args) {
        if (!args?.acctId) throw new Error('acctId is required');
        const collection = await resolveCollection(args.acctId, args.collection);
        const stages = [...(collection.stages || [])].sort((a, b) => (a.order - b.order) || (a.id - b.id));
        return {
            collection: collection.collectionName,
            stages: stages.map(s => ({ id: s.id, name: s.name, color: s.color }))
        };
    },

    async get_lead_stats(args) {
        if (!args?.acctId) throw new Error('acctId is required');
        const collection = await resolveCollection(args.acctId, args.collection);

        const match = { acctId: args.acctId, collectionId: collection._id };

        // ── Resolve stage (id directly, or by name within the collection) ──
        let stageId = null;
        if (args.stage !== undefined && args.stage !== null && args.stage !== '') {
            stageId = Number(args.stage);
        } else if (args.stageName) {
            const lower = String(args.stageName).toLowerCase();
            const found = (collection.stages || []).find(s => s.name.toLowerCase() === lower);
            if (!found) throw new Error(`Stage "${args.stageName}" not found in collection "${collection.collectionName}"`);
            stageId = found.id;
        }
        if (stageId !== null) match.stage = stageId;

        // ── Resolve responsible (userId directly, or by admin name) ──
        let responsibleId = null;
        if (args.responsible) {
            responsibleId = String(args.responsible);
        } else if (args.adminName) {
            const { admins } = await getAdminsFromDb(args.acctId, { limit: 200 });
            const lower = String(args.adminName).toLowerCase();
            const found = admins.find(a => [a.firstName, a.lastName].filter(Boolean).join(' ').toLowerCase().includes(lower));
            if (!found) throw new Error(`Admin matching "${args.adminName}" not found`);
            responsibleId = String(found.userId);
        }
        if (responsibleId !== null) match.responsible = responsibleId;

        // ── Optional created-date range (inclusive whole day for "to") ──
        if (args.dateFrom || args.dateTo) {
            const range = {};
            if (args.dateFrom) range.$gte = new Date(args.dateFrom);
            if (args.dateTo) {
                const to = new Date(args.dateTo);
                to.setHours(23, 59, 59, 999);
                range.$lte = to;
            }
            match.createdAt = range;
        }

        const count = await Lead.countDocuments(match);

        const result = { collection: collection.collectionName, count };
        if (stageId !== null) result.stage = { id: stageId, name: (collection.stages || []).find(s => s.id === stageId)?.name ?? null };
        if (responsibleId !== null) result.responsible = responsibleId;

        // When not filtered by a single stage, also return a per-stage breakdown.
        if (stageId === null) {
            const grouped = await Lead.aggregate([
                { $match: match },
                { $group: { _id: '$stage', count: { $sum: 1 } } }
            ]);
            const nameById = new Map((collection.stages || []).map(s => [s.id, s.name]));
            result.breakdown = grouped
                .map(g => ({ stage: g._id ?? null, name: nameById.get(g._id) ?? (g._id == null ? 'No stage' : 'Unknown'), count: g.count }))
                .sort((a, b) => b.count - a.count);
        }

        return result;
    }
};

// ── JSON-RPC plumbing ──────────────────────────────────────────────────────────

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

const handleRpc = async (msg, req) => {
    const { id, method, params } = msg;

    switch (method) {
        case 'initialize':
            return rpcResult(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'lead-app-admin-mcp', version: '1.0.0' }
            });

        case 'tools/list':
            return rpcResult(id, { tools: TOOLS });

        case 'tools/call': {
            const toolName = params?.name;
            const args = params?.arguments || {};
            const handler = toolHandlers[toolName];
            if (!handler) return rpcError(id, -32601, `Unknown tool: ${toolName}`);

            if (args.acctId) {
                const acctId = String(args.acctId).trim();
                const tenantAcctId = req.query?.acctId ? String(req.query.acctId).trim() : '';
                if (!acctId || acctId !== tenantAcctId) {
                    return rpcResult(id, {
                        content: [{ type: 'text', text: 'Error: Conflicting or invalid acctId values were provided' }],
                        isError: true
                    });
                }
                try {
                    const membership = await AccountAdmin.exists({ acctId, userId: req.user?.userId });
                    if (!membership) {
                        return rpcResult(id, {
                            content: [{ type: 'text', text: 'Error: Access denied to this account' }],
                            isError: true
                        });
                    }
                } catch (error) {
                    return rpcResult(id, {
                        content: [{ type: 'text', text: 'Error: Unable to verify account access' }],
                        isError: true
                    });
                }
                args.acctId = acctId;
            }

            // Per-account rate limiting. acctId arrives in the tool args (not on the
            // HTTP request), so enforce here before invoking the handler.
            if (args.acctId) {
                const rl = await checkRateLimit(String(args.acctId), {
                    max: MCP_RATE_LIMIT_MAX,
                    windowS: MCP_RATE_LIMIT_WINDOW_S,
                    keyPrefix: MCP_RATE_LIMIT_PREFIX,
                    failOpen: MCP_RATE_LIMIT_FAIL_OPEN
                });
                if (!rl.allowed) {
                    logger.warn(`[MCP] rate limit exceeded acctId=${args.acctId} tool=${toolName} retryAfter=${rl.retryAfter}s`);
                    return rpcResult(id, {
                        content: [{ type: 'text', text: `Error: Rate limit exceeded — max ${MCP_RATE_LIMIT_MAX} MCP requests per ${MCP_RATE_LIMIT_WINDOW_S}s per account. Retry after ${rl.retryAfter}s.` }],
                        isError: true
                    });
                }
            }

            try {
                const data = await handler(args, req.user);
                return rpcResult(id, {
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
                });
            } catch (err) {
                // Tool errors are reported via isError so the model can react
                return rpcResult(id, {
                    content: [{ type: 'text', text: `Error: ${err.message}` }],
                    isError: true
                });
            }
        }

        default:
            // Notifications (no id) need no response
            if (id === undefined || id === null) return null;
            return rpcError(id, -32601, `Method not found: ${method}`);
    }
};

// Single Streamable-HTTP endpoint. Accepts a single JSON-RPC message or a batch.
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const messages = Array.isArray(body) ? body : [body];
        const responses = [];

        for (const msg of messages) {
            const out = await handleRpc(msg, req);
            if (out) responses.push(out);
        }

        if (responses.length === 0) return res.status(202).end();
        return res.status(200).json(Array.isArray(body) ? responses : responses[0]);
    } catch (err) {
        logger.error('[MCP] request failed:', { error: err.message });
        return res.status(500).json(rpcError(null, -32603, 'Internal error'));
    }
});

export default router;
