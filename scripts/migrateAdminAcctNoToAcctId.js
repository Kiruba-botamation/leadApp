/**
 * account_admins: acctNo → acctId Migration
 *
 * For every document in `account_admins` that still has the legacy `acctNo`
 * field, this script:
 *   1. Looks up the matching `accounts` document by `acctNo`
 *   2. Copies `accounts._id` into `account_admins.acctId`
 *   3. Removes the `acctNo` field from the `account_admins` document
 *
 * Background:
 *   Older versions of the admin sync stored `acctNo` (the Botamation external
 *   account number) on each admin record instead of `acctId` (the MongoDB _id
 *   of the owning account). The current code and schema use `acctId` exclusively.
 *   This script brings existing database documents in line with the schema.
 *
 * ── Run ───────────────────────────────────────────────────────────────────────
 *   node --env-file=.env.local scripts/migrateAdminAcctNoToAcctId.js
 *
 * ── Safety ────────────────────────────────────────────────────────────────────
 *  • DRY_RUN = true  → prints what would change, touches nothing in DB
 *  • DRY_RUN = false → writes changes to MongoDB
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *  Safe to run multiple times. Documents without `acctNo` are skipped.
 *  If a document already has a correct `acctId` AND `acctNo`, the `acctId`
 *  is still re-derived from `accounts` to guarantee correctness, then
 *  `acctNo` is removed.
 */

// Uses the same mongoConnector as the app — identical DNS overrides, URI, and dbName
import mongoConnector from '../config/mongoConnector.js';
import mongoose from 'mongoose';

// ── Configuration ─────────────────────────────────────────────────────────────
const DRY_RUN = false; // Set to false to apply changes

// ── Connect (same path as the application) ───────────────────────────────────
await mongoConnector.connect();
console.log('[Migration] Connected to MongoDB');

const db = mongoose.connection.db;
const adminsColl   = db.collection('account_admins');
const accountsColl = db.collection('accounts');

// ── Find all account_admins documents that have the legacy acctNo field ───────
const affected = await adminsColl
    .find({ acctNo: { $exists: true } })
    .toArray();

console.log(`[Migration] account_admins documents with legacy 'acctNo': ${affected.length}`);

if (affected.length === 0) {
    console.log('[Migration] Nothing to migrate — no documents have acctNo');
    await mongoConnector.disconnect();
    process.exit(0);
}

// ── DRY RUN preview ───────────────────────────────────────────────────────────
if (DRY_RUN) {
    console.log('\n[Migration] DRY RUN — resolving acctId for each document:\n');

    let resolvable = 0;
    let unresolvable = 0;

    for (const doc of affected) {
        const account = await accountsColl.findOne(
            { acctNo: doc.acctNo },
            { projection: { _id: 1, acctNo: 1, accountName: 1 } }
        );

        if (account) {
            resolvable++;
            console.log(
                `  ✔  adminId=${doc._id}  acctNo=${doc.acctNo}` +
                `  →  acctId=${account._id}  (${account.accountName || ''})`
            );
        } else {
            unresolvable++;
            console.warn(
                `  ✘  adminId=${doc._id}  acctNo=${doc.acctNo}  →  NO matching account found`
            );
        }
    }

    console.log(`\n[Migration] Summary (dry run):`);
    console.log(`  Would update:  ${resolvable}`);
    console.log(`  Cannot resolve: ${unresolvable} (account not found for these acctNo values)`);
    console.log('\n[Migration] Set DRY_RUN = false to apply changes');
    await mongoConnector.disconnect();
    process.exit(0);
}

// ── Apply migration ───────────────────────────────────────────────────────────
console.log('\n[Migration] Applying migration...\n');

let updated    = 0;
let skipped    = 0;
let failed     = 0;

for (const doc of affected) {
    const account = await accountsColl.findOne(
        { acctNo: doc.acctNo },
        { projection: { _id: 1, acctNo: 1 } }
    );

    if (!account) {
        console.warn(
            `  [SKIP] adminId=${doc._id}  acctNo=${doc.acctNo}  — no matching account, skipping`
        );
        skipped++;
        continue;
    }

    try {
        await adminsColl.updateOne(
            { _id: doc._id },
            {
                $set:   { acctId: account._id },
                $unset: { acctNo: '' }
            }
        );
        console.log(
            `  [OK]   adminId=${doc._id}  acctNo=${doc.acctNo}  →  acctId=${account._id}`
        );
        updated++;
    } catch (err) {
        console.error(
            `  [ERR]  adminId=${doc._id}  acctNo=${doc.acctNo}  —  ${err.message}`
        );
        failed++;
    }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n[Migration] ─────────────────────────────────────────');
console.log(`  Updated:        ${updated}`);
console.log(`  Skipped (no account found): ${skipped}`);
console.log(`  Errors:         ${failed}`);
console.log('[Migration] ─────────────────────────────────────────');

if (skipped > 0) {
    console.warn(
        `\n[Migration] WARNING: ${skipped} admin document(s) still have 'acctNo' because` +
        ` no matching account was found. Investigate these manually.`
    );
}

await mongoConnector.disconnect();
console.log('[Migration] Disconnected. Migration complete.');
