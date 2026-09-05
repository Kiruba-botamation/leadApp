import test from 'node:test';
import assert from 'node:assert/strict';

import { applyResolvedResponsible, resolveResponsibleUserIds } from '../services/leadService.js';

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

test('create normalization leaves leads unassigned when the admin is unavailable', () => {
    const items = [
        { name: 'Assigned', responsible: 'chatbot-1' },
        { name: 'Unavailable', responsible: 'missing-admin' },
        { name: 'Already unassigned' }
    ];
    const resolved = resolveResponsibleUserIds(admins, ['chatbot-1', 'missing-admin']);

    applyResolvedResponsible(items, resolved);

    assert.equal(items[0].responsible, 'user-1');
    assert.equal(Object.hasOwn(items[1], 'responsible'), false);
    assert.equal(Object.hasOwn(items[2], 'responsible'), false);
});
