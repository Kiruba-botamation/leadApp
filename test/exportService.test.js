import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeCsvCell, serializeCsvRow, validateExportInput } from '../services/exportService.js';

test('CSV serialization escapes quotes, separators and line breaks', () => {
    assert.equal(serializeCsvRow(['plain', 'a,b', 'say "hi"', 'line\nnext']), 'plain,"a,b","say ""hi""","line\nnext"\r\n');
});

test('CSV serialization prevents spreadsheet formula injection', () => {
    for (const value of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '  =1+1', '\t@x']) {
        assert.equal(serializeCsvCell(value).startsWith("'"), true, value);
    }
    assert.equal(serializeCsvCell('normal'), 'normal');
});

test('export input validation normalizes a valid request', () => {
    assert.deepEqual(validateExportInput({
        collectionId: 'collection-1', fields: [{ field: 'name', label: 'Name' }], sortOrder: 'asc'
    }), {
        collectionId: 'collection-1', fields: [{ field: 'name', label: 'Name' }], fieldFilters: '',
        sortBy: 'updatedAt', sortOrder: 1, responsibleFilter: ''
    });
});

test('export input validation rejects unsafe shapes', () => {
    assert.throws(() => validateExportInput({ collectionId: 'x', fields: [] }), /fields must contain/);
    assert.throws(() => validateExportInput({ collectionId: 'x', fields: [{ field: 'name', label: 'Name' }], extra: true }), /unsupported/);
    assert.throws(() => validateExportInput({ collectionId: 'x', fields: [{ field: 'name', label: '' }] }), /Invalid label/);
    assert.throws(() => validateExportInput({ collectionId: 'x', fields: [{ field: 'name', label: 'Name' }, { field: 'name', label: 'Again' }] }), /unique/);
});
