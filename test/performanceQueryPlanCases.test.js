import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlyQueryPlanCases, buildQueryPlanCases } from '../scripts/performance/queryPlanCases.js';
import { buildLeadFixture } from '../scripts/performance/generateLeadFixture.js';

const inputs = {
    acctId: 'account-1',
    leadId: 'lead-1',
    userId: 'user-1',
    collectionId: 'collection-1'
};

test('performance audit cases represent every latency-sensitive domain', () => {
    const cases = assertReadOnlyQueryPlanCases(buildQueryPlanCases(inputs));
    assert.deepEqual(new Set(cases.map(item => item.collection)), new Set([
        'leads', 'account_admins', 'lead_notes', 'lead_reminders'
    ]));
    assert.ok(cases.every(item => item.command.filter.acctId === inputs.acctId));
    assert.ok(cases.every(item => item.command.limit <= 101));
});

test('performance audit validation rejects unscoped and write-like cases', () => {
    assert.throws(() => assertReadOnlyQueryPlanCases([{
        name: 'unscoped', collection: 'leads', command: { find: 'leads', filter: {}, limit: 1 }
    }]), /tenant-scoped/);
    assert.throws(() => assertReadOnlyQueryPlanCases([{
        name: 'write', collection: 'leads', command: {
            find: 'leads', filter: { acctId: 'account-1', $out: 'other' }, limit: 1
        }
    }]), /write operation/);
});

test('100k fixture rows are deterministic and tenant scoped', () => {
    const first = buildLeadFixture(42, 'account-1');
    assert.deepEqual(first, buildLeadFixture(42, 'account-1'));
    assert.equal(first.acctId, 'account-1');
    assert.match(first.email, /@example\.invalid$/);
    assert.notEqual(first.collectionId, buildLeadFixture(43, 'account-1').collectionId);
});
