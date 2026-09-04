import crypto from 'node:crypto';

export const MAX_LEAD_LIMIT = 100;
export const MAX_FILTER_TEXT_LENGTH = 200;

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

export function assertSafeFieldKey(key, allowedFields, label = 'field') {
    if (typeof key !== 'string' || !key || key.includes('.') || key.includes('$')) {
        throw badRequest(`Invalid ${label} key`);
    }
    if (!allowedFields.has(key)) throw badRequest(`Unknown ${label} "${key}"`);
    return key;
}

export function parseLeadLimit(value, fallback = 10) {
    const limit = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEAD_LIMIT) {
        throw badRequest(`limit must be an integer between 1 and ${MAX_LEAD_LIMIT}`);
    }
    return limit;
}

export function escapeRegexLiteral(value, label = 'text filter') {
    const text = String(value);
    if (text.length > MAX_FILTER_TEXT_LENGTH) {
        throw badRequest(`${label} must be at most ${MAX_FILTER_TEXT_LENGTH} characters`);
    }
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cursorSecret() {
    return process.env.LEAD_CURSOR_SECRET || process.env.JWT_SECRET || 'lead-cursor-v1';
}

function sign(payload) {
    return crypto.createHmac('sha256', cursorSecret()).update(payload).digest('base64url');
}

export function encodeLeadCursor({ sortBy, sortOrder, value, id }) {
    const payload = Buffer.from(JSON.stringify({ v: 1, sortBy, sortOrder, value, id })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

export function decodeLeadCursor(cursor, { sortBy, sortOrder }) {
    if (typeof cursor !== 'string' || cursor.length > 2048) throw badRequest('Invalid cursor');
    const [payload, signature, extra] = cursor.split('.');
    if (!payload || !signature || extra) throw badRequest('Invalid cursor');
    const expected = sign(payload);
    const suppliedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
        throw badRequest('Invalid cursor');
    }

    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        throw badRequest('Invalid cursor');
    }
    const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
    const validValue = parsed?.value === null || ['string', 'number', 'boolean'].includes(typeof parsed?.value);
    if (keys.length !== 5 || parsed.v !== 1 || parsed.sortBy !== sortBy || parsed.sortOrder !== sortOrder ||
        typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 256 || !Object.hasOwn(parsed, 'value') || !validValue) {
        throw badRequest('Cursor does not match the requested sort');
    }
    return parsed;
}

export function buildKeysetCondition(sortBy, sortOrder, cursor) {
    const comparison = sortOrder === 1 ? '$gt' : '$lt';
    const sameValue = { [sortBy]: cursor.value, _id: { [comparison]: cursor.id } };
    if (cursor.value === null) {
        return sortOrder === 1
            ? { $or: [sameValue, { [sortBy]: { $ne: null } }] }
            : sameValue;
    }

    const conditions = [{ [sortBy]: { [comparison]: cursor.value } }, sameValue];
    // Null and missing values sort after non-null values in descending order.
    if (sortOrder === -1) conditions.push({ [sortBy]: null });
    return { $or: conditions };
}

export function parseFieldFilters(raw, allowedFields, fieldTypes) {
    if (!raw) return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw badRequest('fieldFilters must be valid JSON');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw badRequest('fieldFilters must be a JSON object');
    }

    const query = {};
    for (const [key, definition] of Object.entries(parsed)) {
        assertSafeFieldKey(key, allowedFields, 'filter');
        if (!definition || Array.isArray(definition) || typeof definition !== 'object') {
            throw badRequest(`Invalid filter for "${key}"`);
        }
        if (Object.keys(definition).some(name => name.includes('$') || name.includes('.'))) {
            throw badRequest(`Invalid filter property for "${key}"`);
        }
        const type = fieldTypes.get(key);
        if (definition.type !== type && !(key === 'stage' && definition.type === 'number')) {
            throw badRequest(`Filter type for "${key}" must be "${type}"`);
        }
        query[key] = buildFilterCondition(definition, key);
    }
    return query;
}

function buildFilterCondition(definition, key) {
    const allowedProperties = {
        text: new Set(['type', 'value']),
        number: new Set(['type', 'value', 'op', 'min', 'max']),
        date: new Set(['type', 'from', 'to']),
        boolean: new Set(['type', 'value'])
    }[definition.type];
    if (!allowedProperties || Object.keys(definition).some(name => !allowedProperties.has(name))) {
        throw badRequest(`Unsupported filter property for "${key}"`);
    }

    if (definition.type === 'text') {
        if (definition.value === undefined || definition.value === null || definition.value === '') throw badRequest(`Text filter for "${key}" requires value`);
        return { $regex: escapeRegexLiteral(definition.value), $options: 'i' };
    }
    if (definition.type === 'boolean') {
        if (![true, false, 'true', 'false'].includes(definition.value)) throw badRequest(`Invalid boolean filter for "${key}"`);
        return definition.value === true || definition.value === 'true';
    }
    if (definition.type === 'number') {
        const op = definition.op || 'eq';
        const opMap = { eq: '$eq', ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };
        if (op === 'between') {
            const min = Number(definition.min);
            const max = Number(definition.max);
            if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw badRequest(`Invalid number range for "${key}"`);
            return { $gte: min, $lte: max };
        }
        if (!opMap[op]) throw badRequest(`Unsupported number operator for "${key}"`);
        const value = Number(definition.value);
        if (!Number.isFinite(value)) throw badRequest(`Invalid number filter for "${key}"`);
        return { [opMap[op]]: value };
    }

    if (!definition.from && !definition.to) throw badRequest(`Date filter for "${key}" requires from or to`);
    const condition = {};
    if (definition.from) {
        const from = new Date(definition.from);
        if (Number.isNaN(from.getTime())) throw badRequest(`Invalid from date for "${key}"`);
        condition.$gte = from;
    }
    if (definition.to) {
        const to = new Date(definition.to);
        if (Number.isNaN(to.getTime())) throw badRequest(`Invalid to date for "${key}"`);
        to.setHours(23, 59, 59, 999);
        condition.$lte = to;
    }
    return condition;
}
