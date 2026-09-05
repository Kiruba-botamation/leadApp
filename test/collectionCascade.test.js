import test from 'node:test';
import assert from 'node:assert/strict';

import { pruneCollectionAnalytics } from '../services/collectionService.js';

test('collection deletion prunes only analytics charts owned by that collection', () => {
    const schema = {
        filters: [
            { id: 1, chartCollection: 'collection-1' },
            { id: 2, chartCollection: { _id: 'collection-1', collectionName: 'First' } },
            { id: 3, chartCollection: { _id: 'collection-2', collectionName: 'Second' } },
            { id: 4, chartCollection: null }
        ],
        layout: 'grid'
    };

    assert.deepEqual(pruneCollectionAnalytics(schema, 'collection-1'), {
        filters: [
            { id: 3, chartCollection: { _id: 'collection-2', collectionName: 'Second' } },
            { id: 4, chartCollection: null }
        ],
        layout: 'grid'
    });
});

test('collection analytics pruning leaves unrelated schemas unchanged', () => {
    const schema = { filters: [{ id: 1, chartCollection: 'collection-2' }] };

    assert.equal(pruneCollectionAnalytics(schema, 'collection-1'), schema);
});
