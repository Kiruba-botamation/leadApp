import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveResponsibleUserIds } from '../services/leadService.js';

const admins = [
    { _id: 'admin-1', chatbotAdminId: 'chatbot-1', userId: 'user-1' },
    { _id: 'admin-2', chatbotAdminId: 'chatbot-2', userId: 'user-2' }
];

test('responsible identifiers resolve to the canonical user id', () => {
    const resolved = resolveResponsibleUserIds(admins, [
        'chatbot-1',
        'admin-1',
        'user-1',
        'missing'
    ]);

    assert.equal(resolved.get('chatbot-1'), 'user-1');
    assert.equal(resolved.get('admin-1'), 'user-1');
    assert.equal(resolved.get('user-1'), 'user-1');
    assert.equal(resolved.get('missing'), undefined);
});

test('responsible identifiers use chatbot, admin, then user id precedence', () => {
    const resolved = resolveResponsibleUserIds([
        { _id: 'admin-a', chatbotAdminId: 'shared', userId: 'user-a' },
        { _id: 'shared', chatbotAdminId: 'chatbot-b', userId: 'user-b' },
        { _id: 'admin-c', chatbotAdminId: 'chatbot-c', userId: 'shared' }
    ], ['shared']);

    assert.equal(resolved.get('shared'), 'user-a');
});

test('responsible identifiers are trimmed before resolution', () => {
    const resolved = resolveResponsibleUserIds(admins, [' chatbot-2 ']);

    assert.equal(resolved.get('chatbot-2'), 'user-2');
});
