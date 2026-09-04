const MAX_AUDIT_LIMIT = 101;
const FORBIDDEN_KEYS = new Set([
    '$out', '$merge', '$where', 'insert', 'update', 'delete', 'findAndModify',
    'drop', 'createIndexes', 'collMod'
]);

function containsForbiddenKey(value) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsForbiddenKey);
    return Object.entries(value).some(([key, child]) => FORBIDDEN_KEYS.has(key) || containsForbiddenKey(child));
}

export function buildQueryPlanCases({ acctId, leadId, userId, collectionId }) {
    const leadScope = collectionId ? { acctId, collectionId } : { acctId };

    return [
        {
            name: 'lead-list-recent',
            collection: 'leads',
            command: {
                find: 'leads',
                filter: leadScope,
                projection: { _id: 1, acctId: 1, collectionId: 1, updatedAt: 1, responsible: 1 },
                sort: { updatedAt: -1, _id: -1 },
                limit: MAX_AUDIT_LIMIT
            }
        },
        {
            name: 'lead-list-by-responsible',
            collection: 'leads',
            command: {
                find: 'leads',
                filter: { ...leadScope, responsible: userId },
                projection: { _id: 1, acctId: 1, collectionId: 1, updatedAt: 1, responsible: 1 },
                sort: { updatedAt: -1, _id: -1 },
                limit: MAX_AUDIT_LIMIT
            }
        },
        {
            name: 'lead-by-id',
            collection: 'leads',
            command: {
                find: 'leads',
                filter: { _id: leadId, acctId },
                projection: { _id: 1, acctId: 1, collectionId: 1 },
                limit: 1
            }
        },
        {
            name: 'admin-membership',
            collection: 'account_admins',
            command: {
                find: 'account_admins',
                filter: { acctId, userId },
                projection: { _id: 1, accessLevel: 1 },
                limit: 1
            }
        },
        {
            name: 'notes-for-lead',
            collection: 'lead_notes',
            command: {
                find: 'lead_notes',
                filter: { acctId, leadId },
                sort: { createdAt: -1, _id: -1 },
                limit: 51
            }
        },
        {
            name: 'reminders-for-lead',
            collection: 'lead_reminders',
            command: {
                find: 'lead_reminders',
                filter: { acctId, leadId },
                sort: { scheduledAt: -1, _id: -1 },
                limit: 51
            }
        },
        {
            name: 'reminder-bell',
            collection: 'lead_reminders',
            command: {
                find: 'lead_reminders',
                filter: { acctId, notifiedUserId: userId, mainSent: true, bellDismissed: false },
                sort: { scheduledAt: -1, _id: -1 },
                limit: 11
            }
        }
    ];
}

export function assertReadOnlyQueryPlanCases(cases) {
    if (!Array.isArray(cases) || cases.length === 0) throw new Error('At least one audit case is required');

    const names = new Set();
    for (const item of cases) {
        if (!item?.name || names.has(item.name)) throw new Error('Audit case names must be present and unique');
        names.add(item.name);
        if (!item.collection || item.command?.find !== item.collection) {
            throw new Error(`Audit case ${item.name} must be a find on its declared collection`);
        }
        if (item.command.filter?.acctId === undefined) {
            throw new Error(`Audit case ${item.name} must be tenant-scoped by acctId`);
        }
        if (!Number.isInteger(item.command.limit) || item.command.limit < 1 || item.command.limit > MAX_AUDIT_LIMIT) {
            throw new Error(`Audit case ${item.name} has an unsafe limit`);
        }

        if (containsForbiddenKey(item.command)) {
            throw new Error(`Audit case ${item.name} contains a write operation`);
        }
    }
    return cases;
}
