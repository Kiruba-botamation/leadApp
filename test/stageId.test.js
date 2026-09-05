import test from 'node:test';
import assert from 'node:assert/strict';

import { generateStageId, normaliseCustomStageId, resolveStageId, stageIdKey } from '../services/collectionService.js';

test('stage IDs accept unique alphanumeric values and preserve legacy numbers', () => {
    const stages = [{ id: 1 }, { id: 'QUALIFIED2' }];

    assert.equal(normaliseCustomStageId(' FollowUp3 '), 'FollowUp3');
    assert.equal(resolveStageId(stages, '1'), 1);
    assert.equal(resolveStageId(stages, 'qualified2'), 'QUALIFIED2');
    assert.equal(stageIdKey(' NEW '), 'new');
});

test('stage IDs reject punctuation and reserved route names', () => {
    assert.throws(() => normaliseCustomStageId('in-progress'), /only letters and numbers/);
    assert.throws(() => normaliseCustomStageId('reorder'), /reserved/);
});

test('new stages receive a unique alphanumeric ID from their name', () => {
    assert.equal(generateStageId('In Progress', []), 'INPROGRESS');
    assert.equal(generateStageId('In Progress', [{ id: 'inprogress' }]), 'INPROGRESS2');
});
