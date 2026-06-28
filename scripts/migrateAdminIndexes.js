/**
 * account_admins: global-uniqueness index migration
 *
 * Enforces that `userId`, `email`, and `chatbotAdminId` are each unique across the
 * ENTIRE collection — no value may appear in two documents in any combination.
 *
 * Indexes created (matches accountAdminModel.js):
 *   1. { userId }         — unique
 *   2. { email }          — unique PARTIAL (only when email is a string; nulls exempt)
 *   3. { chatbotAdminId } — unique PARTIAL (only when chatbotAdminId is a string)
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

// Legacy / superseded index names to drop before creating the global ones
const LEGACY_INDEXES = [
    'acctId_1_userId_1',
    'acctId_1_chatbotAdminId_1',
    'userId_1',          // recreated as unique below
    'email_1',
    'chatbotAdminId_1',
];

// Report any value shared by more than one document for a given field.
async function findDuplicates(coll, field) {
    const dups = await coll.aggregate([
        { $match: { [field]: { $type: 'string' } } },
        { $group: { _id: `$${field}`, count: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
    ]).toArray();
    return dups;
}

async function migrate() {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    console.log('[migrate] Connected to MongoDB');

    const coll = mongoose.connection.collection('account_admins');

    // 1) Pre-flight duplicate scan — abort cleanly if the data can't satisfy the constraint
    let blocked = false;
    for (const field of ['userId', 'email', 'chatbotAdminId']) {
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

    // 3) Create the global-uniqueness indexes
    await coll.createIndex({ userId: 1 }, { unique: true });
    console.log('[migrate] Created unique index on { userId }');

    await coll.createIndex(
        { email: 1 },
        { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
    );
    console.log('[migrate] Created partial unique index on { email }');

    await coll.createIndex(
        { chatbotAdminId: 1 },
        { unique: true, partialFilterExpression: { chatbotAdminId: { $type: 'string' } } }
    );
    console.log('[migrate] Created partial unique index on { chatbotAdminId }');

    await mongoose.disconnect();
    console.log('[migrate] Done.');
}

migrate().catch(err => {
    console.error('[migrate] Failed:', err);
    process.exit(1);
});
