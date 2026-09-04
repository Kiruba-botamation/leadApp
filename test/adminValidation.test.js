import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ADMIN_FILTER_MAX,
    ADMIN_LIMIT_MAX,
    escapeRegexLiteral,
    normalizeAdminFilter,
    normalizeAdminListOptions
} from '../services/adminService.js';

test('admin list options bound limits and allowlist sorting', () => {
    assert.deepEqual(normalizeAdminListOptions({
        page: '-2', limit: '10000', sortBy: '$where', sortOrder: 'sideways'
    }), {
        page: 1,
        limit: ADMIN_LIMIT_MAX,
        sortBy: 'createdAt',
        sortOrder: -1,
        includeCount: true
    });
    assert.equal(normalizeAdminListOptions({ includeCount: 'false' }).includeCount, false);
});

test('admin filters are normalized escaped literals', () => {
    assert.equal(escapeRegexLiteral('a.*(b)'), 'a\\.\\*\\(b\\)');
    const filter = normalizeAdminFilter('  A.*(B)  ', 'firstName');
    assert.equal(filter.source, '^a\\.\\*\\(b\\)');
    assert.equal(filter.test('a.*(b)yy'), true);
    assert.equal(filter.test('xxa.*(b)yy'), false);
    assert.equal(filter.test('anything'), false);
});

test('admin filters reject overlong values', () => {
    assert.throws(
        () => normalizeAdminFilter('x'.repeat(ADMIN_FILTER_MAX + 1), 'email'),
        error => error.statusCode === 400 && /email/.test(error.message)
    );
});
