/**
 * account_admins: tenant-scoped index migration
 *
 * Allows the same person to administer multiple accounts while enforcing identity
 * uniqueness within each account. Also backfills lowercase fields used by literal
 * filters so roster queries remain account-indexed.
 *
 * Indexes created (matches accountAdminModel.js):
 *   1. { acctId, userId }                    — unique
 *   2. { acctId, emailNormalized }           — unique partial
 *   3. { acctId, chatbotAdminIdNormalized }  — unique partial
 *
 * Drops the legacy per-account compound indexes and the non-unique userId index,
 * since MongoDB will not change an existing index's options in place
 * (IndexOptionsConflict). Before creating the unique indexes, scans for any
 * existing duplicate values and ABORTS with a report if found — so creation can't
 * fail half-way and you can clean the data first.
 *
 * ── Run ───────────────────────────────────────────────────────────────────────
 *   node --env-file=.env.local scripts/migrateAdminIndexes.js
 *
 * Safe to re-run: missing indexes are skipped, createIndex is idempotent.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';

dotenv.config();
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME   = process.env.MONGO_DB_NAME || 'leadapp';

// Legacy / superseded index names to drop before creating tenant-scoped ones
const LEGACY_INDEXES = [
    'acctId_1_userId_1',
    'acctId_1_chatbotAdminId_1',
    'userId_1',
    'email_1',
    'chatbotAdminId_1',
];

// Report any value shared within an account for a given field.
async function findDuplicates(coll, field) {
    const dups = await coll.aggregate([
        { $match: { [field]: { $type: 'string' } } },
        { $group: { _id: { acctId: '$acctId', value: `$${field}` }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
    ]).toArray();
    return dups;
}

async function migrate() {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    console.log('[migrate] Connected to MongoDB');

    const coll = mongoose.connection.collection('account_admins');

    const normalizeExpression = field => ({
        $let: {
            vars: {
                normalized: {
                    $cond: [
                        { $eq: [{ $type: `$${field}` }, 'string'] },
                        { $toLower: { $trim: { input: `$${field}` } } },
                        ''
                    ]
                }
            },
            in: { $cond: [{ $eq: ['$$normalized', ''] }, null, '$$normalized'] }
        }
    });
    await coll.updateMany({}, [{ $set: {
        firstNameNormalized: normalizeExpression('firstName'),
        lastNameNormalized: normalizeExpression('lastName'),
        emailNormalized: normalizeExpression('email'),
        phoneNormalized: normalizeExpression('phone'),
        chatbotAdminIdNormalized: normalizeExpression('chatbotAdminId')
    } }]);
    console.log('[migrate] Backfilled normalized admin fields');

    // 1) Pre-flight duplicate scan — abort cleanly if the data can't satisfy the constraint
    let blocked = false;
    for (const field of ['userId', 'emailNormalized', 'chatbotAdminIdNormalized']) {
        const dups = await findDuplicates(coll, field);
        if (dups.length) {
            blocked = true;
            console.error(`[migrate] ✗ Duplicate ${field} values found (${dups.length}):`);
            dups.forEach(d => console.error(`    ${field}=${JSON.stringify(d._id)} → docs ${JSON.stringify(d.ids)}`));
        } else {
            console.log(`[migrate] ✓ No duplicate ${field} values`);
        }
    }
    if (blocked) {
        console.error('[migrate] Aborting — resolve the duplicates above, then re-run.');
        await mongoose.disconnect();
        process.exit(1);
    }

    // 2) Drop legacy / superseded indexes
    const existing = await coll.indexes();
    console.log('[migrate] Existing indexes:', existing.map(i => i.name).join(', '));
    for (const name of LEGACY_INDEXES) {
        if (existing.some(i => i.name === name)) {
            await coll.dropIndex(name);
            console.log(`[migrate] Dropped index: ${name}`);
        }
    }

    // 3) Create tenant-leading query and uniqueness indexes
    await coll.createIndex({ acctId: 1, createdAt: -1, _id: -1 });
    await coll.createIndex({ acctId: 1, updatedAt: -1, _id: -1 });
    await coll.createIndex({ acctId: 1, userId: 1 }, { unique: true });
    await coll.createIndex({ acctId: 1, firstNameNormalized: 1, _id: 1 });
    await coll.createIndex({ acctId: 1, lastNameNormalized: 1, _id: 1 });
    await coll.createIndex({ acctId: 1, phoneNormalized: 1, _id: 1 });
    await coll.createIndex({ acctId: 1, accessLevel: 1, _id: 1 });
    console.log('[migrate] Created account-leading admin indexes');

    await coll.createIndex(
        { acctId: 1, emailNormalized: 1 },
        { unique: true, partialFilterExpression: { emailNormalized: { $type: 'string' } } }
    );
    console.log('[migrate] Created partial unique index on { acctId, emailNormalized }');

    await coll.createIndex(
        { acctId: 1, chatbotAdminIdNormalized: 1 },
        { unique: true, partialFilterExpression: { chatbotAdminIdNormalized: { $type: 'string' } } }
    );
    console.log('[migrate] Created partial unique index on { acctId, chatbotAdminIdNormalized }');

    await mongoose.disconnect();
    console.log('[migrate] Done.');
}

migrate().catch(err => {
    console.error('[migrate] Failed:', err);
    process.exit(1);
});
