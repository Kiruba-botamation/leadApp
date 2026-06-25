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
import { invalidateAdminCache } from '../middleware/ssoAuthMiddleware.js';
import logger from '../utils/logger.js';

const router = express.Router();

const PROTOCOL_VERSION = '2024-11-05';

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
    }
];

// ── Tool handlers ──────────────────────────────────────────────────────────────

/** Resolve the caller's access level for an account (single source of truth for the superadmin gate). */
const callerAccessLevel = async (userId, acctId) => {
    const rec = await AccountAdmin.findOne({ acctId, userId }, { accessLevel: 1 }).lean();
    return rec?.accessLevel ?? null;
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
