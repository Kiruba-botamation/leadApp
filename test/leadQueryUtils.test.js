import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildKeysetCondition,
    decodeLeadCursor,
    encodeLeadCursor,
    escapeRegexLiteral,
    parseFieldFilters,
    parseLeadLimit
} from '../utils/leadQueryUtils.js';

test('cursor round-trips and is bound to its sort', () => {
    const encoded = encodeLeadCursor({ sortBy: 'updatedAt', sortOrder: -1, value: '2026-01-01T00:00:00.000Z', id: 'abc' });
    assert.deepEqual(decodeLeadCursor(encoded, { sortBy: 'updatedAt', sortOrder: -1 }), {
        v: 1, sortBy: 'updatedAt', sortOrder: -1, value: '2026-01-01T00:00:00.000Z', id: 'abc'
    });
    assert.throws(() => decodeLeadCursor(encoded, { sortBy: 'createdAt', sortOrder: -1 }), /does not match/);
    assert.throws(() => decodeLeadCursor(`${encoded}x`, { sortBy: 'updatedAt', sortOrder: -1 }), /Invalid cursor/);
    const invalidValue = encodeLeadCursor({ sortBy: 'updatedAt', sortOrder: -1, value: { $gt: '' }, id: 'abc' });
    assert.throws(() => decodeLeadCursor(invalidValue, { sortBy: 'updatedAt', sortOrder: -1 }), /does not match/);
});

test('keyset condition uses sort value and id tie-breaker', () => {
    assert.deepEqual(buildKeysetCondition('name', 1, { value: 'A', id: '2' }), {
        $or: [{ name: { $gt: 'A' } }, { name: 'A', _id: { $gt: '2' } }]
    });
});

test('limits and text are bounded and regex-literal safe', () => {
    assert.equal(parseLeadLimit('100'), 100);
    assert.throws(() => parseLeadLimit('101'), /between 1 and 100/);
    assert.equal(escapeRegexLiteral('a.*(b)'), 'a\\.\\*\\(b\\)');
    assert.throws(() => escapeRegexLiteral('x'.repeat(201)), /at most 200/);
});

test('field filters reject malformed JSON, unsafe keys, and unknown operators', () => {
    const allowed = new Set(['name', 'score']);
    const types = new Map([['name', 'text'], ['score', 'number']]);
    assert.deepEqual(parseFieldFilters('{"name":{"type":"text","value":"a.*"}}', allowed, types), {
        name: { $regex: 'a\\.\\*', $options: 'i' }
    });
    assert.throws(() => parseFieldFilters('{', allowed, types), /valid JSON/);
    assert.throws(() => parseFieldFilters('{"$where":{"type":"text","value":"x"}}', allowed, types), /Invalid filter key/);
    assert.throws(() => parseFieldFilters('{"score":{"type":"number","op":"wat","value":1}}', allowed, types), /Unsupported number operator/);
});

test('alphanumeric stage filters use exact matching', () => {
    const filter = parseFieldFilters(
        '{"stage":{"type":"text","value":"QUALIFIED2"}}',
        new Set(['stage']),
        new Map([['stage', 'text']])
    );
    assert.deepEqual(filter, { stage: { $eq: 'QUALIFIED2' } });
});
