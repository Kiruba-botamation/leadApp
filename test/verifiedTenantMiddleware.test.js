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

test('resolves the canonical query account ID', () => {
    const req = request({ query: { acctId: ' account-1 ' } });
    assert.equal(resolveCanonicalAcctId(req), 'account-1');
});

test('ignores non-canonical account ID sources and returns null without query acctId', () => {
    assert.equal(resolveCanonicalAcctId(request({ body: { acctId: 'account-3' } })), null);
    assert.equal(resolveCanonicalAcctId(request()), null);
});

test('rejects non-scalar and blank account IDs', () => {
    assert.throws(
        () => resolveCanonicalAcctId(request({ query: { acctId: ['account-1', 'account-2'] } })),
        /Invalid acctId/
    );
    assert.throws(
        () => resolveCanonicalAcctId(request({ query: { acctId: '  ' } })),
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
