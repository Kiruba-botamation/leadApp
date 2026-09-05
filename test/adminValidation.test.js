import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ADMIN_FILTER_MAX,
    ADMIN_LIMIT_MAX,
    escapeRegexLiteral,
    isAdminMissingFromPlatform,
    normaliseBotamationAdmin,
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

test('admin sync only prunes records with a confirmed missing external id', () => {
    const externalIds = new Set(['admin-1']);

    assert.equal(isAdminMissingFromPlatform({ chatbotAdminId: ' ADMIN-1 ' }, externalIds), false);
    assert.equal(isAdminMissingFromPlatform({ chatbotAdminId: 'admin-2' }, externalIds), true);
    assert.equal(isAdminMissingFromPlatform({ chatbotAdminId: null }, externalIds), false);
});

test('Botamation admin normalization accepts snake-case platform fields', () => {
    assert.deepEqual(normaliseBotamationAdmin({
        admin_id: 42,
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone_number: '1234567890',
        profile_image_url: 'https://example.com/ada.jpg'
    }), {
        chatbotAdminId: 42,
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '1234567890',
        profileImage: 'https://example.com/ada.jpg'
    });
});

test('Botamation admin normalization supports generic id and full name fields', () => {
    assert.deepEqual(normaliseBotamationAdmin({
        id: 'admin-7',
        name: 'Grace Brewster Hopper',
        avatar: 'https://example.com/grace.jpg'
    }), {
        chatbotAdminId: 'admin-7',
        firstName: 'Grace',
        lastName: 'Brewster Hopper',
        phone: null,
        profileImage: 'https://example.com/grace.jpg'
    });
});
