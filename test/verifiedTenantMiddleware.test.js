import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSuperadmin, resolveCanonicalAcctId } from '../middleware/verifiedTenantMiddleware.js';

const request = (overrides = {}) => ({
    query: {},
    body: {},
    headers: {},
    params: {},
    ...overrides
});

test('resolves one canonical account ID across matching sources', () => {
    const req = request({
        query: { acctId: ' account-1 ' },
        body: { acctId: 'account-1' },
        headers: { 'x-acctno': 'account-1', 'x-acct-id': 'account-1' },
        params: { acctId: 'account-1' }
    });

    assert.equal(resolveCanonicalAcctId(req), 'account-1');
});

test('rejects conflicting account IDs instead of choosing a source', () => {
    const req = request({
        query: { acctId: 'account-1' },
        body: { acctId: 'account-2' }
    });

    assert.throws(() => resolveCanonicalAcctId(req), /Conflicting acctId values/);
});

test('supports a path account ID and returns null when none is supplied', () => {
    assert.equal(resolveCanonicalAcctId(request({ params: { acctId: 'account-3' } })), 'account-3');
    assert.equal(resolveCanonicalAcctId(request()), null);
});

test('rejects non-scalar and blank account IDs', () => {
    assert.throws(
        () => resolveCanonicalAcctId(request({ query: { acctId: ['account-1', 'account-2'] } })),
        /Invalid acctId/
    );
    assert.throws(
        () => resolveCanonicalAcctId(request({ body: { acctId: '  ' } })),
        /Invalid acctId/
    );
});

test('account role policy requires a verified tenant and allowed role', () => {
    let nextCalls = 0;
    const next = () => { nextCalls += 1; };
    const response = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    requireSuperadmin(
        { tenant: { acctId: 'account-1' }, user: { accessLevel: 'superadmin' } },
        response,
        next
    );
    assert.equal(nextCalls, 1);

    requireSuperadmin(
        { tenant: { acctId: 'account-1' }, user: { accessLevel: 'admin' } },
        response,
        next
    );
    assert.equal(response.statusCode, 403);
    assert.equal(nextCalls, 1);
});
